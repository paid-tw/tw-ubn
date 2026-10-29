//! Open Government Data License v1 attribution (政府資料開放授權條款－第1版).
//!
//! The licence's exhibit (附件：顯名聲明, https://data.gov.tw/license) says a
//! user who does not attach the required notice is treated as never having
//! been granted the licence. The manifest carries that notice:
//!
//! 1. 提供機關／單位 [年份] [開放資料釋出名稱與版本號]
//! 2. the standard release statement
//! 3. https://data.gov.tw/license

use serde::Serialize;

pub const ACTIVE_URL: &str = "https://eip.fia.gov.tw/data/BGMOPEN1.zip";
pub const SUSPENDED_URL: &str = "https://eip.fia.gov.tw/data/BGMOPEN1X.csv";
pub const NONPROFIT_URL: &str = "https://eip.fia.gov.tw/data/BGMOPEN99.csv";
pub const SCHOOL_URL: &str = "https://eip.fia.gov.tw/data/BGMOPEN99X.csv";
/// Served as `機關名單.csv`; the path is an opaque download id on fia.gov.tw.
pub const AGENCY_URL: &str = "https://www.fia.gov.tw/download/9bc4de1485014443b518beb37d8f35fe";

pub const PROVIDER: &str = "財政部財政資訊中心";
/// Official title. The hyphen is U+FF0D, as on data.gov.tw/license.
pub const LICENSE_NAME: &str = "政府資料開放授權條款\u{ff0d}第1版";
pub const LICENSE_URL: &str = "https://data.gov.tw/license";

/// Exhibit item 2, verbatim from https://data.gov.tw/license (附件：顯名聲明).
pub const STATEMENT: &str = "此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。";

pub const ACTIVE_DATASET: &str = "全國營業(稅籍)登記資料集";
pub const SUSPENDED_DATASET: &str = "全國營業(稅籍)登記(停業)資料集";
pub const NONPROFIT_DATASET: &str = "非營利事業機關團體資料集";
pub const SCHOOL_DATASET: &str = "全國各級學校統一編號資料集";
pub const AGENCY_DATASET: &str = "行政院所屬各機關同意開放統一編號資料集";
const ACTIVE_CATALOG: &str = "https://data.gov.tw/dataset/9400";
const SUSPENDED_CATALOG: &str = "https://data.gov.tw/dataset/75140";
const NONPROFIT_CATALOG: &str = "https://data.gov.tw/dataset/34147";
const SCHOOL_CATALOG: &str = "https://data.gov.tw/dataset/75136";
const AGENCY_CATALOG: &str = "https://data.gov.tw/dataset/44806";

const SOURCE_AGENCY: &str = "財政部財政資訊中心 (Fiscal Information Agency, Ministry of Finance)";

/// Whether a source file was part of this build, and the sentinel date if
/// the file had one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IncludedSource<'a> {
    /// Not loaded (`--no-suspended`, `--no-nonprofit`, …).
    Skipped,
    /// Loaded. `None` means the sentinel row was missing (the agency list
    /// never has one).
    Loaded(Option<&'a str>),
}

/// Every source file a build can include, with its sentinel date.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sources<'a> {
    /// `BGMOPEN1`, always loaded.
    pub active: Option<&'a str>,
    pub suspended: IncludedSource<'a>,
    pub nonprofit: IncludedSource<'a>,
    pub school: IncludedSource<'a>,
    pub agency: IncludedSource<'a>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AttributedDataset {
    pub name: &'static str,
    /// Gregorian year derived from a `DD-MON-YY` or ROC `YYYMMDD` sentinel,
    /// when it parses.
    pub year: Option<String>,
    /// Sentinel date (`28-OCT-26`, or `1151030` for `BGMOPEN99`). That stamp
    /// is the upstream version label; the files are replaced in place and
    /// have no separate version number.
    pub version: Option<String>,
    pub url: &'static str,
    pub catalog: &'static str,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attribution {
    pub provider: &'static str,
    /// Exhibit line 1, with the slots filled in.
    pub exhibit: String,
    pub statement: &'static str,
    pub license: &'static str,
    pub license_url: &'static str,
    pub datasets: Vec<AttributedDataset>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub source: &'static str,
    pub suspended_source: Option<&'static str>,
    pub source_agency: &'static str,
    pub data_date: Option<String>,
    pub suspended_data_date: Option<String>,
    pub built_at: String,
    pub rows: usize,
    pub shards: u32,
    pub hash: &'static str,
    pub license: &'static str,
    pub license_url: &'static str,
    pub attribution: Attribution,
}

pub fn build_manifest(sources: &Sources<'_>, rows: usize, shards: u32, built_at: &str) -> Manifest {
    let attribution = attribution(sources);
    let active_date = sources.active;
    let (suspended_source, suspended_data_date) = match sources.suspended {
        IncludedSource::Skipped => (None, None),
        IncludedSource::Loaded(date) => (Some(SUSPENDED_URL), date.map(str::to_string)),
    };
    Manifest {
        source: ACTIVE_URL,
        suspended_source,
        source_agency: SOURCE_AGENCY,
        data_date: active_date.map(str::to_string),
        suspended_data_date,
        built_at: built_at.to_string(),
        rows,
        shards,
        hash: "fnv1a-32",
        license: LICENSE_NAME,
        license_url: LICENSE_URL,
        attribution,
    }
}

fn attribution(sources: &Sources<'_>) -> Attribution {
    let mut datasets = vec![dataset(
        ACTIVE_DATASET,
        ACTIVE_URL,
        ACTIVE_CATALOG,
        sources.active,
    )];
    let optional = [
        (
            sources.suspended,
            SUSPENDED_DATASET,
            SUSPENDED_URL,
            SUSPENDED_CATALOG,
        ),
        (
            sources.nonprofit,
            NONPROFIT_DATASET,
            NONPROFIT_URL,
            NONPROFIT_CATALOG,
        ),
        (sources.school, SCHOOL_DATASET, SCHOOL_URL, SCHOOL_CATALOG),
        (sources.agency, AGENCY_DATASET, AGENCY_URL, AGENCY_CATALOG),
    ];
    for (included, name, url, catalog) in optional {
        if let IncludedSource::Loaded(date) = included {
            datasets.push(dataset(name, url, catalog, date));
        }
    }
    let exhibit = exhibit_line(&datasets);
    Attribution {
        provider: PROVIDER,
        exhibit,
        statement: STATEMENT,
        license: LICENSE_NAME,
        license_url: LICENSE_URL,
        datasets,
    }
}

fn dataset(
    name: &'static str,
    url: &'static str,
    catalog: &'static str,
    version: Option<&str>,
) -> AttributedDataset {
    AttributedDataset {
        name,
        year: version.and_then(year_from_sentinel),
        version: version.map(str::to_string),
        url,
        catalog,
    }
}

/// `28-OCT-26` → `2026`, and ROC `1151030` → `2026` (the `BGMOPEN99`
/// sentinel). Returns `None` for any other shape.
fn year_from_sentinel(date: &str) -> Option<String> {
    if date.len() == 7 && date.bytes().all(|b| b.is_ascii_digit()) {
        return ubn_core::roc_to_iso(date).map(|iso| iso[..4].to_string());
    }
    let mut parts = date.split('-');
    let day = parts.next()?;
    let month = parts.next()?;
    let yy = parts.next()?;
    if parts.next().is_some() {
        return None;
    }
    if day.len() != 2 || month.len() != 3 || yy.len() != 2 {
        return None;
    }
    if !day.bytes().all(|b| b.is_ascii_digit())
        || !yy.bytes().all(|b| b.is_ascii_digit())
        || !month.bytes().all(|b| b.is_ascii_alphabetic())
    {
        return None;
    }
    let n: u32 = yy.parse().ok()?;
    Some((2000 + n).to_string())
}

fn exhibit_line(datasets: &[AttributedDataset]) -> String {
    let mut years: Vec<&str> = Vec::new();
    for dataset in datasets {
        if let Some(year) = dataset.year.as_deref() {
            if !years.contains(&year) {
                years.push(year);
            }
        }
    }
    let year = if years.is_empty() {
        "年份未標示".to_string()
    } else {
        years.join("/")
    };
    let names = datasets
        .iter()
        .map(|dataset| match &dataset.version {
            Some(version) => format!("{}（版本 {version}）", dataset.name),
            None => format!("{}（版本未標示）", dataset.name),
        })
        .collect::<Vec<_>>()
        .join("、");
    format!("提供機關\u{ff0f}單位 {PROVIDER} {year} {names}")
}

#[cfg(test)]
mod tests {
    use super::*;

    const OFFICIAL_STATEMENT: &str = "此開放資料依政府資料開放授權條款 (Open Government Data License) 進行公眾釋出，使用者於遵守本條款各項規定之前提下，得利用之。";

    fn business_only<'a>(active: Option<&'a str>, suspended: IncludedSource<'a>) -> Sources<'a> {
        Sources {
            active,
            suspended,
            nonprofit: IncludedSource::Skipped,
            school: IncludedSource::Skipped,
            agency: IncludedSource::Skipped,
        }
    }

    fn both(active: Option<&str>, suspended: Option<&str>) -> Manifest {
        build_manifest(
            &business_only(active, IncludedSource::Loaded(suspended)),
            11,
            32,
            "2026-10-27T22:00:00Z",
        )
    }

    #[test]
    fn statement_matches_the_license_exhibit() {
        assert_eq!(STATEMENT, OFFICIAL_STATEMENT);
        assert_eq!(LICENSE_URL, "https://data.gov.tw/license");
        assert_eq!(LICENSE_NAME, "政府資料開放授權條款－第1版");
        assert!(LICENSE_NAME.contains('\u{ff0d}'));
        assert!(!LICENSE_NAME.contains('-'));
    }

    #[test]
    fn manifest_attributes_both_datasets() {
        let m = both(Some("28-OCT-26"), Some("28-OCT-26"));
        assert_eq!(m.source, ACTIVE_URL);
        assert_eq!(m.suspended_source, Some(SUSPENDED_URL));
        assert_eq!(m.data_date.as_deref(), Some("28-OCT-26"));
        assert_eq!(m.suspended_data_date.as_deref(), Some("28-OCT-26"));
        assert_eq!(m.license, LICENSE_NAME);
        assert_eq!(m.license_url, LICENSE_URL);
        assert_eq!(m.attribution.provider, PROVIDER);
        assert_eq!(m.attribution.statement, OFFICIAL_STATEMENT);
        assert_eq!(
            m.attribution.exhibit,
            "提供機關／單位 財政部財政資訊中心 2026 全國營業(稅籍)登記資料集（版本 28-OCT-26）、全國營業(稅籍)登記(停業)資料集（版本 28-OCT-26）"
        );
        assert_eq!(m.attribution.datasets.len(), 2);
        assert_eq!(m.attribution.datasets[0].name, ACTIVE_DATASET);
        assert_eq!(m.attribution.datasets[0].catalog, ACTIVE_CATALOG);
        assert_eq!(m.attribution.datasets[0].year.as_deref(), Some("2026"));
        assert_eq!(m.attribution.datasets[1].name, SUSPENDED_DATASET);
        assert_eq!(
            m.attribution.datasets[1].catalog,
            "https://data.gov.tw/dataset/75140"
        );
        assert_eq!(m.attribution.datasets[1].url, SUSPENDED_URL);

        let json = serde_json::to_value(&m).unwrap();
        assert_eq!(json["attribution"]["statement"], OFFICIAL_STATEMENT);
        assert_eq!(json["attribution"]["licenseUrl"], LICENSE_URL);
        assert_eq!(json["license"], LICENSE_NAME);
        // Keys the dataset workflow reads when it builds the release notes.
        assert!(json["attribution"]["exhibit"].is_string());
        assert!(json["attribution"]["statement"].is_string());
        assert!(json["attribution"]["licenseUrl"].is_string());
    }

    #[test]
    fn skipping_suspended_omits_that_dataset() {
        let m = build_manifest(
            &business_only(Some("27-OCT-26"), IncludedSource::Skipped),
            5,
            8,
            "2026-10-26T00:00:00Z",
        );
        assert!(m.suspended_source.is_none());
        assert!(m.suspended_data_date.is_none());
        assert_eq!(m.attribution.datasets.len(), 1);
        assert_eq!(m.attribution.datasets[0].name, ACTIVE_DATASET);
        assert_eq!(m.attribution.datasets[0].year.as_deref(), Some("2026"));
        assert!(!m.attribution.exhibit.contains("停業"));
        assert_eq!(
            m.attribution.exhibit,
            "提供機關／單位 財政部財政資訊中心 2026 全國營業(稅籍)登記資料集（版本 27-OCT-26）"
        );
    }

    #[test]
    fn every_loaded_withholding_source_is_attributed() {
        let sources = Sources {
            active: Some("30-OCT-26"),
            suspended: IncludedSource::Loaded(Some("30-OCT-26")),
            nonprofit: IncludedSource::Loaded(Some("1151030")),
            school: IncludedSource::Loaded(Some("01-OCT-26")),
            agency: IncludedSource::Loaded(None),
        };
        let m = build_manifest(&sources, 9, 32, "2026-10-29T22:00:00Z");
        let names: Vec<_> = m.attribution.datasets.iter().map(|d| d.name).collect();
        assert_eq!(
            names,
            [
                ACTIVE_DATASET,
                SUSPENDED_DATASET,
                NONPROFIT_DATASET,
                SCHOOL_DATASET,
                AGENCY_DATASET
            ]
        );
        let nonprofit = &m.attribution.datasets[2];
        assert_eq!(nonprofit.url, NONPROFIT_URL);
        assert_eq!(nonprofit.catalog, "https://data.gov.tw/dataset/34147");
        assert_eq!(nonprofit.version.as_deref(), Some("1151030"));
        assert_eq!(nonprofit.year.as_deref(), Some("2026")); // ROC 115
        assert_eq!(m.attribution.datasets[3].url, SCHOOL_URL);
        assert_eq!(
            m.attribution.datasets[3].catalog,
            "https://data.gov.tw/dataset/75136"
        );
        let agency = &m.attribution.datasets[4];
        assert_eq!(agency.url, AGENCY_URL);
        assert_eq!(agency.catalog, "https://data.gov.tw/dataset/44806");
        assert!(agency.version.is_none());
        assert!(agency.year.is_none());
        assert_eq!(
            m.attribution.exhibit,
            "提供機關／單位 財政部財政資訊中心 2026 全國營業(稅籍)登記資料集（版本 30-OCT-26）、全國營業(稅籍)登記(停業)資料集（版本 30-OCT-26）、非營利事業機關團體資料集（版本 1151030）、全國各級學校統一編號資料集（版本 01-OCT-26）、行政院所屬各機關同意開放統一編號資料集（版本未標示）"
        );

        let partial = build_manifest(
            &Sources {
                school: IncludedSource::Skipped,
                ..sources
            },
            9,
            32,
            "2026-10-29T22:00:00Z",
        );
        assert!(!partial.attribution.exhibit.contains(SCHOOL_DATASET));
        assert!(partial.attribution.exhibit.contains(AGENCY_DATASET));
    }

    #[test]
    fn year_parses_both_sentinel_shapes() {
        assert_eq!(year_from_sentinel("28-OCT-26").as_deref(), Some("2026"));
        assert_eq!(year_from_sentinel("1151030").as_deref(), Some("2026"));
        assert_eq!(year_from_sentinel("1150000"), None);
        assert_eq!(year_from_sentinel("115103"), None);
    }

    #[test]
    fn disagreeing_sentinel_years_are_both_shown() {
        let m = both(Some("28-OCT-26"), Some("02-JAN-27"));
        assert_eq!(m.attribution.datasets[0].year.as_deref(), Some("2026"));
        assert_eq!(m.attribution.datasets[1].year.as_deref(), Some("2027"));
        assert_eq!(m.data_date.as_deref(), Some("28-OCT-26"));
        assert_eq!(m.suspended_data_date.as_deref(), Some("02-JAN-27"));
        assert_eq!(
            m.attribution.exhibit,
            "提供機關／單位 財政部財政資訊中心 2026/2027 全國營業(稅籍)登記資料集（版本 28-OCT-26）、全國營業(稅籍)登記(停業)資料集（版本 02-JAN-27）"
        );
    }

    #[test]
    fn missing_or_unparseable_sentinel_does_not_invent_a_year() {
        let missing = both(None, None);
        assert!(missing
            .attribution
            .datasets
            .iter()
            .all(|d| d.year.is_none()));
        assert!(missing
            .attribution
            .datasets
            .iter()
            .all(|d| d.version.is_none()));
        assert_eq!(
            missing.attribution.exhibit,
            "提供機關／單位 財政部財政資訊中心 年份未標示 全國營業(稅籍)登記資料集（版本未標示）、全國營業(稅籍)登記(停業)資料集（版本未標示）"
        );

        let raw = both(Some("not-a-date"), Some("28-OCT-26"));
        assert!(raw.attribution.datasets[0].year.is_none());
        assert_eq!(
            raw.attribution.datasets[0].version.as_deref(),
            Some("not-a-date")
        );
        assert_eq!(raw.attribution.datasets[1].year.as_deref(), Some("2026"));
        assert!(raw.attribution.exhibit.contains("2026"));
        assert!(raw.attribution.exhibit.contains("版本 not-a-date"));
        assert!(!raw.attribution.exhibit.contains("年份未標示"));
    }
}
