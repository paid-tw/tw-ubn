//! Pure CSV parsing / normalization for the FIA tax-registry files.
//! Kept free of I/O so it can be unit-tested without the network.

use serde::Serialize;
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

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Industry {
    pub code: String,
    pub name: String,
}

/// A full registry record, one per JSON line / SQLite row.
#[derive(Debug, Clone, Serialize)]
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
    pub industries: Vec<Industry>,
}

/// The minimal record published in each per-UBN shard (checkout autofill).
#[derive(Debug, Clone, Serialize)]
pub struct ShardRecord {
    pub ban: String,
    pub name: String,
    pub address: String,
    #[serde(rename = "useInvoice")]
    pub use_invoice: bool,
}

impl Record {
    pub fn to_shard(&self) -> ShardRecord {
        ShardRecord {
            ban: self.ban.clone(),
            name: self.name.clone(),
            address: self.address.clone(),
            use_invoice: self.use_invoice,
        }
    }
}

pub struct Parsed {
    pub records: Vec<Record>,
    /// The extract date carried by the CSV's sentinel row (e.g. "27-OCT-26").
    pub data_date: Option<String>,
}

/// Parse a FIA tax-registry CSV.
///
/// Column order (0-based): 0 address, 1 ban, 2 hq_ban, 3 name, 4 capital,
/// 5 setup_date (ROC), 6 org_type, 7 use_invoice (Y/N), 8/9..14/15 industry
/// code/name pairs. The first data row is a sentinel holding the extract date
/// in column 0 with an empty UBN; it is captured into `data_date` and skipped.
pub fn parse_csv<R: std::io::Read>(reader: R, status: Status) -> anyhow::Result<Parsed> {
    let mut rdr = csv::ReaderBuilder::new()
        .has_headers(true)
        .flexible(true)
        .from_reader(reader);

    let mut records = Vec::new();
    let mut data_date = None;

    for result in rdr.records() {
        let r = result?;
        let get = |i: usize| r.get(i).unwrap_or("").trim().to_string();

        let ban = get(1);
        if ban.len() != 8 || !ban.bytes().all(|b| b.is_ascii_digit()) {
            // sentinel / blank row: grab the extract date from column 0 once
            let c0 = get(0);
            if data_date.is_none() && !c0.is_empty() {
                data_date = Some(c0);
            }
            continue;
        }

        let mut industries = Vec::new();
        for (ci, ni) in [(8usize, 9usize), (10, 11), (12, 13), (14, 15)] {
            let code = get(ci);
            let name = get(ni);
            if !code.is_empty() || !name.is_empty() {
                industries.push(Industry { code, name });
            }
        }

        let setup_date = get(5);
        records.push(Record {
            setup_date_iso: roc_to_iso(&setup_date),
            ban,
            name: get(3),
            address: get(0),
            capital: get(4),
            setup_date,
            org_type: get(6),
            use_invoice: get(7) == "Y",
            status: status.as_str(),
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
    fn status_label_follows_argument() {
        let p = parse_csv(SAMPLE.as_bytes(), Status::Suspended).unwrap();
        assert!(p.records.iter().all(|r| r.status == "suspended"));
    }
}
