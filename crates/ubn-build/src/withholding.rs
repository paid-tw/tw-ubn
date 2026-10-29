//! Parsing for the FIA withholding-unit (扣繳單位) files: UBNs held by
//! schools, nonprofits and government agencies, which are not VAT-registered
//! and so are absent from `BGMOPEN1` / `BGMOPEN1X`.
//!
//! Sources (verified 2026-10-29 by downloading each file):
//!   nonprofit https://eip.fia.gov.tw/data/BGMOPEN99.csv   (data.gov.tw 34147, daily)
//!   school    https://eip.fia.gov.tw/data/BGMOPEN99X.csv  (data.gov.tw 75136, monthly)
//!   agency    https://www.fia.gov.tw/download/9bc4de1485014443b518beb37d8f35fe
//!             (data.gov.tw 44806, irregular; served as `機關名單.csv`)
//!
//! `BGMOPEN99` and `BGMOPEN99X` are UTF-8 (no BOM, LF) with the header
//! `統一編號,單位名稱,機關所在縣市,最近異動日期,最近異動原因,原因說明文字`.
//! Their first data row is a sentinel with an empty 統一編號 and the extract
//! date in `單位名稱` (`1151030`, a ROC date, in `BGMOPEN99`; `01-OCT-26` in
//! `BGMOPEN99X`). It is stored in `data_date` and skipped.
//!
//! The agency list is UTF-8 (no BOM, CRLF), every field quoted, header
//! `統一編號,機關單位名稱`, names right-padded with spaces, and no sentinel.
//! It repeats a few UBNs (4 on 2026-10-29, one with two different names);
//! the first occurrence wins.
//!
//! `最近異動原因` is the latest registration event, so it carries the
//! deregistrations: `11` (註銷), `17` (撤銷登記) and `18` (擅自歇業他遷不明)
//! map to `closed`, `12` (申請停業) to `suspended`, and every other code
//! (`01` 設立, `02` 變更負責人, `03`, `04`, `13` 復業, `16`, `20`, `49`…) to
//! `active`.
//!
//! None of these files has a capital, setup date, organisation type, invoice
//! flag or industry, so those fields are empty / null / false. `address` is
//! the county or city (`機關所在縣市`) for nonprofits and schools — the only
//! location these files give — and empty for agencies.

use crate::transform::{cell, index_columns, Kind, Parsed, Record, Status};
use anyhow::Result;
use std::collections::HashSet;

/// One of the three withholding-unit files.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    /// `BGMOPEN99`: nonprofits under 所得稅法 §11(4).
    Nonprofit,
    /// `BGMOPEN99X`: schools and kindergartens.
    School,
    /// The Executive Yuan agencies that agreed to publish their UBN.
    Agency,
}

impl Source {
    pub fn kind(self) -> Kind {
        match self {
            Source::Nonprofit => Kind::Nonprofit,
            Source::School => Kind::School,
            Source::Agency => Kind::Agency,
        }
    }

    fn columns(self) -> &'static [&'static str] {
        match self {
            Source::Nonprofit | Source::School => UNIT_COLUMNS,
            Source::Agency => AGENCY_COLUMNS,
        }
    }
}

/// `BGMOPEN99.csv` and `BGMOPEN99X.csv`. Order is documentation only.
const UNIT_COLUMNS: &[&str] = &[
    "統一編號",
    "單位名稱",
    "機關所在縣市",
    "最近異動日期",
    "最近異動原因",
    "原因說明文字",
];

/// The agency list.
const AGENCY_COLUMNS: &[&str] = &["統一編號", "機關單位名稱"];

/// `最近異動原因` → status. See the module doc for the code list.
pub fn status_of_reason(code: &str) -> Status {
    match code {
        "11" | "17" | "18" => Status::Closed,
        "12" => Status::Suspended,
        _ => Status::Active,
    }
}

/// Parse one withholding-unit CSV into records of `source.kind()`.
pub fn parse_withholding_csv<R: std::io::Read>(reader: R, source: Source) -> Result<Parsed> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(reader);
    let index = index_columns(rdr.headers()?, source.columns(), source.kind().as_str())?;
    let col = |name: &str| index[name];
    let ban_col = col("統一編號");
    let (name_col, city_col, reason_col) = match source {
        Source::Nonprofit | Source::School => (
            col("單位名稱"),
            Some(col("機關所在縣市")),
            Some(col("最近異動原因")),
        ),
        Source::Agency => (col("機關單位名稱"), None, None),
    };

    let mut records = Vec::new();
    let mut seen = HashSet::new();
    let mut data_date = None;
    for result in rdr.records() {
        let r = result?;
        let ban = cell(&r, ban_col);
        if ban.len() != 8 || !ban.bytes().all(|b| b.is_ascii_digit()) {
            // Sentinel / blank row: the extract date sits in the name column.
            let stamp = cell(&r, name_col);
            if data_date.is_none() && !stamp.is_empty() {
                data_date = Some(stamp);
            }
            continue;
        }
        if !seen.insert(ban.clone()) {
            continue;
        }
        let status = reason_col.map_or(Status::Active, |i| status_of_reason(&cell(&r, i)));
        records.push(Record {
            ban,
            name: cell(&r, name_col),
            address: city_col.map(|i| cell(&r, i)).unwrap_or_default(),
            capital: String::new(),
            setup_date: String::new(),
            setup_date_iso: None,
            org_type: String::new(),
            use_invoice: false,
            status: status.as_str(),
            kind: source.kind().as_str(),
            suspension_date: None,
            suspension_date_iso: None,
            industries: Vec::new(),
        });
    }

    Ok(Parsed { records, data_date })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real rows from the 2026-10-29 downloads (sentinels `1151030`,
    /// `01-OCT-26`; the agency list has none).
    const NONPROFIT_FIXTURE: &str = include_str!("../fixtures/bgmopen99_sample.csv");
    const SCHOOL_FIXTURE: &str = include_str!("../fixtures/bgmopen99x_sample.csv");
    const AGENCY_FIXTURE: &str = include_str!("../fixtures/agency_sample.csv");

    fn find<'a>(p: &'a Parsed, ban: &str) -> &'a Record {
        p.records.iter().find(|r| r.ban == ban).unwrap()
    }

    #[test]
    fn reason_codes_map_to_status() {
        for code in ["11", "17", "18"] {
            assert_eq!(status_of_reason(code), Status::Closed, "{code}");
        }
        assert_eq!(status_of_reason("12"), Status::Suspended);
        for code in ["01", "02", "03", "04", "13", "16", "20", "49", "", "99"] {
            assert_eq!(status_of_reason(code), Status::Active, "{code}");
        }
    }

    #[test]
    fn nonprofit_fixture_skips_sentinel_and_maps_codes() {
        let p = parse_withholding_csv(NONPROFIT_FIXTURE.as_bytes(), Source::Nonprofit).unwrap();
        assert_eq!(p.data_date.as_deref(), Some("1151030"));
        assert_eq!(p.records.len(), 7);
        assert!(p.records.iter().all(|r| r.kind == "nonprofit"));
        assert!(p.records.iter().all(|r| !r.use_invoice));
        assert!(p.records.iter().all(|r| r.industries.is_empty()));

        let fencing = find(&p, "00099678");
        assert_eq!(fencing.name, "中華民國擊劍協會");
        assert_eq!(fencing.address, "臺北市");
        assert_eq!(fencing.status, "active");
        assert_eq!(fencing.capital, "");
        assert_eq!(fencing.org_type, "");
        assert!(fencing.setup_date_iso.is_none());
        assert!(fencing.suspension_date.is_none());

        assert_eq!(find(&p, "10253329").status, "closed"); // 11
        assert_eq!(find(&p, "37631606").status, "closed"); // 17
        assert_eq!(find(&p, "00831856").status, "closed"); // 18
        assert_eq!(find(&p, "26088212").status, "suspended"); // 12
        assert_eq!(find(&p, "61173632").status, "active"); // 01
    }

    #[test]
    fn school_fixture_keeps_its_own_sentinel_format() {
        let p = parse_withholding_csv(SCHOOL_FIXTURE.as_bytes(), Source::School).unwrap();
        assert_eq!(p.data_date.as_deref(), Some("01-OCT-26"));
        assert_eq!(p.records.len(), 5);
        assert!(p.records.iter().all(|r| r.kind == "school"));

        let closed = find(&p, "00132017");
        assert_eq!(closed.name, "高雄市私立鼎佳佳幼兒園");
        assert_eq!(closed.status, "closed");
        assert_eq!(closed.address, "高雄市");
        assert_eq!(find(&p, "00516203").status, "active");
        assert_eq!(find(&p, "00532072").status, "closed"); // 17
        assert_eq!(find(&p, "00682429").status, "suspended"); // 12
        assert_eq!(find(&p, "03703406").name, "中央警察大學");
    }

    #[test]
    fn agency_fixture_trims_padding_and_keeps_first_duplicate() {
        let p = parse_withholding_csv(AGENCY_FIXTURE.as_bytes(), Source::Agency).unwrap();
        assert!(p.data_date.is_none());
        assert_eq!(p.records.len(), 4);
        assert!(p.records.iter().all(|r| r.kind == "agency"));
        assert!(p.records.iter().all(|r| r.status == "active"));
        assert!(p.records.iter().all(|r| r.address.is_empty()));

        assert_eq!(find(&p, "03732303").name, "財政部");
        // Listed twice upstream with two names; the first row wins.
        assert_eq!(find(&p, "91002127").name, "法務部矯正署屏東看守所");
        assert_eq!(p.records.iter().filter(|r| r.ban == "91002127").count(), 1);
    }

    #[test]
    fn rejects_unknown_or_missing_columns() {
        let extra = NONPROFIT_FIXTURE.replacen("原因說明文字", "原因說明文字,備註", 1);
        let err = parse_withholding_csv(extra.as_bytes(), Source::Nonprofit).unwrap_err();
        assert!(err.to_string().contains("備註"), "{err}");

        let missing = SCHOOL_FIXTURE.replacen("最近異動原因,", "", 1);
        let err = parse_withholding_csv(missing.as_bytes(), Source::School).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("missing"), "{msg}");
        assert!(msg.contains("最近異動原因"), "{msg}");

        // The agency header on a unit file (and vice versa) is a schema error.
        let err = parse_withholding_csv(AGENCY_FIXTURE.as_bytes(), Source::School).unwrap_err();
        assert!(err.to_string().contains("機關單位名稱"), "{err}");
        let err = parse_withholding_csv(NONPROFIT_FIXTURE.as_bytes(), Source::Agency).unwrap_err();
        assert!(err.to_string().contains("單位名稱"), "{err}");
    }

    #[test]
    fn column_order_does_not_change_parsed_rows() {
        let flipped = "\
原因說明文字,最近異動原因,最近異動日期,機關所在縣市,單位名稱,統一編號
,,,,1151030,
撤銷登記,17,1070725,臺南市,臺南市英得利暨信固投資人權益促進協會,37631606
";
        let p = parse_withholding_csv(flipped.as_bytes(), Source::Nonprofit).unwrap();
        assert_eq!(p.data_date.as_deref(), Some("1151030"));
        assert_eq!(p.records.len(), 1);
        assert_eq!(p.records[0].name, "臺南市英得利暨信固投資人權益促進協會");
        assert_eq!(p.records[0].address, "臺南市");
        assert_eq!(p.records[0].status, "closed");
    }
}
