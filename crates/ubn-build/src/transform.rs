//! Pure CSV parsing / normalization for the FIA tax-registry files.
//! Kept free of I/O so it can be unit-tested without the network.
//!
//! `BGMOPEN1` (active) and `BGMOPEN1X` (suspended) share a schema except the
//! suspended file inserts `停業日期` — in the upstream extract, between
//! `組織別名稱` and `使用統一發票`. Columns are matched by header name, in
//! any order. The header must be exactly the expected set for that file;
//! anything else aborts the build so a schema change cannot silently shift
//! fields (the failure mode of the old positional parser: every suspended
//! `使用統一發票` was read as the suspension date, so `use_invoice` was
//! always false and industry code/name slid left by one).
//!
//! The first data row of both files is a sentinel (`28-OCT-26` in
//! `營業地址`, empty 統一編號). It is stored in `data_date` and skipped.

use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use ubn_core::roc_to_iso;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    Active,
    Suspended,
}

impl Status {
    pub fn as_str(self) -> &'static str {
        match self {
            Status::Active => "active",
            Status::Suspended => "suspended",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Industry {
    pub code: String,
    pub name: String,
}

/// A full registry record, one per JSON line / SQLite row.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Record {
    pub ban: String,
    pub name: String,
    pub address: String,
    pub capital: String,
    pub setup_date: String,
    pub setup_date_iso: Option<String>,
    pub org_type: String,
    pub use_invoice: bool,
    pub status: &'static str,
    /// ROC date from `停業日期`. Null when that column is absent (active
    /// file) or the cell is blank.
    pub suspension_date: Option<String>,
    pub suspension_date_iso: Option<String>,
    pub industries: Vec<Industry>,
}

/// The minimal record published in each per-UBN shard (checkout autofill).
///
/// `status` was added with the header-driven build. Shards published before
/// that omit the field; readers must treat a missing `status` as unknown,
/// not as active. `suspension_date` is intentionally not copied here — it
/// lives on the full dataset (`ubn.ndjson.gz`, `ubn.sqlite`) only.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ShardRecord {
    pub ban: String,
    pub name: String,
    pub address: String,
    #[serde(rename = "useInvoice")]
    pub use_invoice: bool,
    pub status: &'static str,
}

impl Record {
    pub fn to_shard(&self) -> ShardRecord {
        ShardRecord {
            ban: self.ban.clone(),
            name: self.name.clone(),
            address: self.address.clone(),
            use_invoice: self.use_invoice,
            status: self.status,
        }
    }
}

#[derive(Debug)]
pub struct Parsed {
    pub records: Vec<Record>,
    /// The extract date carried by the CSV's sentinel row (e.g. "28-OCT-26").
    pub data_date: Option<String>,
}

/// Columns `BGMOPEN1.csv` always carries, in the upstream's usual order.
/// Order is documentation only — parsing is by name.
const ACTIVE_COLUMNS: &[&str] = &[
    "營業地址",
    "統一編號",
    "總機構統一編號",
    "營業人名稱",
    "資本額",
    "設立日期",
    "組織別名稱",
    "使用統一發票",
    "行業代號",
    "名稱",
    "行業代號1",
    "名稱1",
    "行業代號2",
    "名稱2",
    "行業代號3",
    "名稱3",
];

/// `BGMOPEN1X.csv`: the active columns plus `停業日期`.
const SUSPENDED_COLUMNS: &[&str] = &[
    "營業地址",
    "統一編號",
    "總機構統一編號",
    "營業人名稱",
    "資本額",
    "設立日期",
    "組織別名稱",
    "停業日期",
    "使用統一發票",
    "行業代號",
    "名稱",
    "行業代號1",
    "名稱1",
    "行業代號2",
    "名稱2",
    "行業代號3",
    "名稱3",
];

struct Columns {
    address: usize,
    ban: usize,
    name: usize,
    capital: usize,
    setup_date: usize,
    org_type: usize,
    use_invoice: usize,
    suspension_date: Option<usize>,
    industries: [(usize, usize); 4],
}

fn expected_columns(status: Status) -> &'static [&'static str] {
    match status {
        Status::Active => ACTIVE_COLUMNS,
        Status::Suspended => SUSPENDED_COLUMNS,
    }
}

fn header_names(header: &csv::StringRecord) -> Result<Vec<String>> {
    let mut names = Vec::with_capacity(header.len());
    for (i, raw) in header.iter().enumerate() {
        let name = raw.trim().trim_start_matches('\u{feff}');
        if name.is_empty() {
            bail!("FIA CSV header has an empty column name at index {i}");
        }
        names.push(name.to_string());
    }
    Ok(names)
}

fn resolve_columns(header: &csv::StringRecord, status: Status) -> Result<Columns> {
    let names = header_names(header)?;
    let mut index: HashMap<&str, usize> = HashMap::with_capacity(names.len());
    for (i, name) in names.iter().enumerate() {
        if index.insert(name.as_str(), i).is_some() {
            bail!(
                "unexpected FIA CSV header for {} file: duplicate column {name:?}",
                status.as_str()
            );
        }
    }

    let expected = expected_columns(status);
    let missing: Vec<&str> = expected
        .iter()
        .copied()
        .filter(|name| !index.contains_key(name))
        .collect();
    let unexpected: Vec<&str> = names
        .iter()
        .map(String::as_str)
        .filter(|name| !expected.contains(name))
        .collect();
    if !missing.is_empty() || !unexpected.is_empty() {
        bail!(
            "unexpected FIA CSV header for {} file.\n  missing: {}\n  unexpected: {}\n  got: {}",
            status.as_str(),
            join_or_none(&missing),
            join_or_none(&unexpected),
            names.join(", "),
        );
    }

    let col = |name: &str| index[name];
    Ok(Columns {
        address: col("營業地址"),
        ban: col("統一編號"),
        name: col("營業人名稱"),
        capital: col("資本額"),
        setup_date: col("設立日期"),
        org_type: col("組織別名稱"),
        use_invoice: col("使用統一發票"),
        suspension_date: index.get("停業日期").copied(),
        industries: [
            (col("行業代號"), col("名稱")),
            (col("行業代號1"), col("名稱1")),
            (col("行業代號2"), col("名稱2")),
            (col("行業代號3"), col("名稱3")),
        ],
    })
}

fn join_or_none(items: &[&str]) -> String {
    if items.is_empty() {
        "(none)".to_string()
    } else {
        items.join(", ")
    }
}

fn cell(rec: &csv::StringRecord, idx: usize) -> String {
    rec.get(idx).unwrap_or("").trim().to_string()
}

/// Parse a FIA tax-registry CSV.
///
/// `status` is the file the caller is reading (`BGMOPEN1` → active,
/// `BGMOPEN1X` → suspended). It selects the expected header and the
/// `status` value written onto each row; it is not inferred from the
/// presence of `停業日期`.
pub fn parse_csv<R: std::io::Read>(reader: R, status: Status) -> Result<Parsed> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(reader);
    let cols = resolve_columns(rdr.headers()?, status)?;

    let mut records = Vec::new();
    let mut data_date = None;

    for result in rdr.records() {
        let r = result?;
        let ban = cell(&r, cols.ban);
        if ban.len() != 8 || !ban.bytes().all(|b| b.is_ascii_digit()) {
            // Sentinel / blank row: the extract date sits in 營業地址.
            let stamp = cell(&r, cols.address);
            if data_date.is_none() && !stamp.is_empty() {
                data_date = Some(stamp);
            }
            continue;
        }

        let mut industries = Vec::new();
        for (ci, ni) in cols.industries {
            let code = cell(&r, ci);
            let name = cell(&r, ni);
            if !code.is_empty() || !name.is_empty() {
                industries.push(Industry { code, name });
            }
        }

        let setup_date = cell(&r, cols.setup_date);
        let suspension_date = cols
            .suspension_date
            .map(|i| cell(&r, i))
            .filter(|s| !s.is_empty());
        records.push(Record {
            setup_date_iso: roc_to_iso(&setup_date),
            suspension_date_iso: suspension_date.as_deref().and_then(roc_to_iso),
            ban,
            name: cell(&r, cols.name),
            address: cell(&r, cols.address),
            capital: cell(&r, cols.capital),
            setup_date,
            org_type: cell(&r, cols.org_type),
            use_invoice: cell(&r, cols.use_invoice) == "Y",
            status: status.as_str(),
            suspension_date,
            industries,
        });
    }

    Ok(Parsed { records, data_date })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "\
營業地址,統一編號,總機構統一編號,營業人名稱,資本額,設立日期,組織別名稱,使用統一發票,行業代號,名稱,行業代號1,名稱1,行業代號2,名稱2,行業代號3,名稱3
27-OCT-26,,,,,,,,,,,,,,,
\"台北市信義路1號\",22099131,,\"台積電\",100,0760321,股份有限公司,Y,261199,其他積體電路製造,261111,矽晶圓製造,,,,
\"高雄市中山路2號\",47529263,,\"小吃店\",5000,1051108,獨資,N,561115,餐廳,,,,,,";

    /// Real rows from the FIA extract whose sentinel is `28-OCT-26`
    /// (files on eip.fia.gov.tw last-modified 2026-10-27).
    const ACTIVE_FIXTURE: &str = include_str!("../fixtures/bgmopen1_sample.csv");
    const SUSPENDED_FIXTURE: &str = include_str!("../fixtures/bgmopen1x_sample.csv");

    fn rev_columns(csv_text: &str) -> String {
        let mut rdr = csv::ReaderBuilder::new()
            .has_headers(true)
            .flexible(true)
            .from_reader(csv_text.as_bytes());
        let header = rdr.headers().unwrap().clone();
        let width = header.len();
        let rows: Vec<_> = rdr.records().map(|r| r.unwrap()).collect();
        let flip = |rec: &csv::StringRecord| -> Vec<String> {
            (0..width)
                .rev()
                .map(|i| rec.get(i).unwrap_or("").to_string())
                .collect()
        };
        let mut w = csv::WriterBuilder::new().from_writer(Vec::new());
        w.write_record(flip(&header)).unwrap();
        for row in &rows {
            w.write_record(flip(row)).unwrap();
        }
        String::from_utf8(w.into_inner().unwrap()).unwrap()
    }

    #[test]
    fn captures_date_and_skips_sentinel() {
        let p = parse_csv(SAMPLE.as_bytes(), Status::Active).unwrap();
        assert_eq!(p.data_date.as_deref(), Some("27-OCT-26"));
        assert_eq!(p.records.len(), 2); // sentinel dropped
    }

    #[test]
    fn normalizes_fields() {
        let p = parse_csv(SAMPLE.as_bytes(), Status::Active).unwrap();
        let tsmc = &p.records[0];
        assert_eq!(tsmc.ban, "22099131");
        assert_eq!(tsmc.name, "台積電");
        assert_eq!(tsmc.address, "台北市信義路1號");
        assert!(tsmc.use_invoice);
        assert_eq!(tsmc.setup_date_iso.as_deref(), Some("1987-03-21"));
        assert_eq!(tsmc.status, "active");
        assert!(tsmc.suspension_date.is_none());
        assert!(tsmc.suspension_date_iso.is_none());
        assert_eq!(tsmc.industries.len(), 2);
        assert_eq!(
            tsmc.industries[0],
            Industry {
                code: "261199".into(),
                name: "其他積體電路製造".into()
            }
        );

        let shop = &p.records[1];
        assert!(!shop.use_invoice);
        assert_eq!(shop.industries.len(), 1);
    }

    #[test]
    fn strips_utf8_bom_on_the_first_header() {
        let csv = format!("\u{feff}{SAMPLE}");
        let p = parse_csv(csv.as_bytes(), Status::Active).unwrap();
        assert_eq!(p.records.len(), 2);
        assert_eq!(p.records[0].name, "台積電");
    }

    #[test]
    fn rejects_unknown_column() {
        let csv = SAMPLE.replace("名稱3", "名稱3,備註");
        let err = parse_csv(csv.as_bytes(), Status::Active).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("unexpected"), "{msg}");
        assert!(msg.contains("備註"), "{msg}");
    }

    #[test]
    fn rejects_empty_column_name() {
        let csv = SAMPLE.replace("名稱3", "名稱3,");
        let err = parse_csv(csv.as_bytes(), Status::Active).unwrap_err();
        assert!(err.to_string().contains("empty column"), "{err}");
    }

    #[test]
    fn rejects_missing_required_column() {
        let csv = SAMPLE.replace("使用統一發票,", "");
        let err = parse_csv(csv.as_bytes(), Status::Active).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("missing"), "{msg}");
        assert!(msg.contains("使用統一發票"), "{msg}");
    }

    #[test]
    fn rejects_duplicate_column() {
        let csv = SAMPLE.replace("營業人名稱", "營業地址");
        let err = parse_csv(csv.as_bytes(), Status::Active).unwrap_err();
        assert!(err.to_string().contains("duplicate"), "{err}");
    }

    #[test]
    fn rejects_active_header_on_the_suspended_file() {
        // The pre-fix parser accepted this and shifted every field after 組織別名稱.
        let err = parse_csv(SAMPLE.as_bytes(), Status::Suspended).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("停業日期"), "{msg}");
        assert!(msg.contains("missing"), "{msg}");
    }

    #[test]
    fn rejects_suspension_column_on_the_active_file() {
        let err = parse_csv(SUSPENDED_FIXTURE.as_bytes(), Status::Active).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("unexpected"), "{msg}");
        assert!(msg.contains("停業日期"), "{msg}");
    }

    #[test]
    fn active_fixture_rows_keep_invoice_flag_and_industry() {
        let p = parse_csv(ACTIVE_FIXTURE.as_bytes(), Status::Active).unwrap();
        assert_eq!(p.data_date.as_deref(), Some("28-OCT-26"));
        assert_eq!(p.records.len(), 5);
        assert!(p.records.iter().all(|r| r.status == "active"));
        assert!(p.records.iter().all(|r| r.suspension_date.is_none()));

        let uses_invoice = p.records.iter().filter(|r| r.use_invoice).count();
        assert_eq!(uses_invoice, 2);

        let shop = p.records.iter().find(|r| r.ban == "38965019").unwrap();
        assert_eq!(shop.name, "原味商行");
        assert!(!shop.use_invoice);
        assert_eq!(shop.setup_date_iso.as_deref(), Some("2015-04-13"));
        assert_eq!(shop.industries[0].code, "472927");
        assert_eq!(shop.industries[0].name, "豆類製品零售");

        let engineer = p.records.iter().find(|r| r.ban == "47588972").unwrap();
        assert!(engineer.use_invoice);
        assert_eq!(engineer.industries[0].code, "434013");
        assert_eq!(engineer.industries[0].name, "房屋設備安裝工程");

        let four = p.records.iter().find(|r| r.ban == "89771986").unwrap();
        assert_eq!(four.industries.len(), 4);
        assert_eq!(four.industries[0].code, "464212");
        assert_eq!(
            four.industries[0].name,
            "通訊傳播設備（電話、手機除外）批發"
        );
        assert_eq!(four.industries[3].code, "433112");

        let branch = p.records.iter().find(|r| r.ban == "72373274").unwrap();
        assert_eq!(branch.name, "佳哉畜牧場中寮營業所");
        assert!(!branch.use_invoice);
    }

    #[test]
    fn suspended_fixture_is_not_shifted_by_the_extra_column() {
        // 惜緣農業資材行 is the shape the positional parser destroyed:
        // column 7 is 停業日期 `1150101`, column 8 is `Y`, column 9 is
        // `462011`. Reading by index made use_invoice=false and
        // industries[0] = {code:"Y", name:"462011"}.
        let p = parse_csv(SUSPENDED_FIXTURE.as_bytes(), Status::Suspended).unwrap();
        assert_eq!(p.data_date.as_deref(), Some("28-OCT-26"));
        assert_eq!(p.records.len(), 6);
        assert!(p.records.iter().all(|r| r.status == "suspended"));

        let y = p.records.iter().filter(|r| r.use_invoice).count();
        let n = p.records.iter().filter(|r| !r.use_invoice).count();
        assert_eq!((y, n), (5, 1));

        let row = p.records.iter().find(|r| r.ban == "87003412").unwrap();
        assert_eq!(row.name, "惜緣農業資材行");
        assert_eq!(
            row.address,
            "南投縣中寮鄉八仙村００７鄰永樂路７之１６號１樓"
        );
        assert!(row.use_invoice);
        assert_eq!(row.suspension_date.as_deref(), Some("1150101"));
        assert_eq!(row.suspension_date_iso.as_deref(), Some("2026-01-01"));
        assert_eq!(row.setup_date_iso.as_deref(), Some("2020-03-05"));
        assert_eq!(row.industries.len(), 3);
        assert_eq!(
            row.industries[0],
            Industry {
                code: "462011".into(),
                name: "肥料批發".into()
            }
        );
        assert_ne!(row.industries[0].code, "Y");
        assert_eq!(row.industries[1].code, "462016");
        assert_eq!(row.industries[2].code, "485299");

        let closed_shop = p.records.iter().find(|r| r.ban == "47522228").unwrap();
        assert!(!closed_shop.use_invoice);
        assert_eq!(closed_shop.suspension_date.as_deref(), Some("1150811"));
        assert_eq!(
            closed_shop.suspension_date_iso.as_deref(),
            Some("2026-08-11")
        );
        assert_eq!(closed_shop.industries[0].code, "559099");

        let farm = p.records.iter().find(|r| r.ban == "94920851").unwrap();
        assert_eq!(farm.industries.len(), 4);
        assert_eq!(farm.suspension_date_iso.as_deref(), Some("2025-11-16"));

        // 29 rows in the 28-OCT-26 suspended extract have a blank 停業日期.
        // The invoice flag and industries must still land on the right columns.
        let blank = p.records.iter().find(|r| r.ban == "60274801").unwrap();
        assert_eq!(blank.name, "安聯企業社");
        assert!(blank.suspension_date.is_none());
        assert!(blank.suspension_date_iso.is_none());
        assert!(blank.use_invoice);
        assert_eq!(blank.industries.len(), 4);
        assert_eq!(blank.industries[0].code, "483212");
        assert_eq!(blank.industries[0].name, "手機及手機週邊零配件零售");
    }

    #[test]
    fn column_order_does_not_change_parsed_rows() {
        for (csv_text, status) in [
            (ACTIVE_FIXTURE, Status::Active),
            (SUSPENDED_FIXTURE, Status::Suspended),
        ] {
            let original = parse_csv(csv_text.as_bytes(), status).unwrap();
            let flipped = parse_csv(rev_columns(csv_text).as_bytes(), status).unwrap();
            assert_eq!(flipped.data_date, original.data_date);
            assert_eq!(flipped.records, original.records);
        }
    }
}
