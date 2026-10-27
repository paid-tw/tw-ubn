//! Integration-style coverage: real FIA fixture rows go through the same
//! parse → merge → ndjson/sqlite/shard writers `main` uses.

use super::transform::{parse_csv, Status};
use super::{merge_records, write_ndjson_gz, write_shards, write_sqlite};
use anyhow::{Context, Result};
use flate2::read::GzDecoder;
use rusqlite::{params, Connection};
use std::fs;
use std::io::BufRead;
use std::path::{Path, PathBuf};
use ubn_core::shard_of;

const ACTIVE_FIXTURE: &str = include_str!("../fixtures/bgmopen1_sample.csv");
const SUSPENDED_FIXTURE: &str = include_str!("../fixtures/bgmopen1x_sample.csv");

struct TempDir(PathBuf);

impl TempDir {
    fn new() -> Self {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = std::env::temp_dir().join(format!("ubn-build-{nanos}"));
        fs::create_dir_all(&path).unwrap();
        Self(path)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn build_fixture_dataset(out: &Path) -> Result<Vec<super::transform::Record>> {
    let active = parse_csv(ACTIVE_FIXTURE.as_bytes(), Status::Active)?;
    let suspended = parse_csv(SUSPENDED_FIXTURE.as_bytes(), Status::Suspended)?;
    assert_eq!(active.data_date.as_deref(), Some("28-OCT-26"));
    assert_eq!(suspended.data_date.as_deref(), Some("28-OCT-26"));
    let records = merge_records(suspended.records, active.records);
    write_shards(&records, out, 32)?;
    write_ndjson_gz(&records, &out.join("ubn.ndjson.gz"))?;
    write_sqlite(&records, &out.join("ubn.sqlite"))?;
    Ok(records)
}

fn ndjson_by_ban(path: &Path, ban: &str) -> Result<serde_json::Value> {
    let file = fs::File::open(path)?;
    for line in std::io::BufReader::new(GzDecoder::new(file)).lines() {
        let line = line?;
        let value: serde_json::Value = serde_json::from_str(&line)?;
        if value["ban"] == ban {
            return Ok(value);
        }
    }
    anyhow::bail!("ndjson missing {ban}")
}

#[test]
fn fixture_rows_survive_ndjson_sqlite_and_shards() -> Result<()> {
    let dir = TempDir::new();
    let records = build_fixture_dataset(&dir.0)?;
    assert_eq!(records.len(), 11);

    let suspended_y = records
        .iter()
        .filter(|r| r.status == "suspended" && r.use_invoice)
        .count();
    assert_eq!(suspended_y, 5, "positional parse of this fixture yields 0");

    let row = ndjson_by_ban(&dir.0.join("ubn.ndjson.gz"), "87003412")?;
    assert_eq!(row["name"], "惜緣農業資材行");
    assert_eq!(row["use_invoice"], true);
    assert_eq!(row["status"], "suspended");
    assert_eq!(row["suspension_date"], "1150101");
    assert_eq!(row["suspension_date_iso"], "2026-01-01");
    assert_eq!(row["industries"][0]["code"], "462011");
    assert_eq!(row["industries"][0]["name"], "肥料批發");
    assert_ne!(row["industries"][0]["code"], "Y");

    let active = ndjson_by_ban(&dir.0.join("ubn.ndjson.gz"), "47588972")?;
    assert_eq!(active["status"], "active");
    assert_eq!(active["use_invoice"], true);
    assert!(active["suspension_date"].is_null());
    assert_eq!(active["industries"][0]["code"], "434013");

    let conn = Connection::open(dir.0.join("ubn.sqlite"))?;
    let y: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ubn WHERE status = 'suspended' AND use_invoice = 1",
        [],
        |r| r.get(0),
    )?;
    assert_eq!(y, 5);
    let (invoice, status, suspension, industries): (i64, String, Option<String>, String) = conn
        .query_row(
            "SELECT use_invoice, status, suspension_date, industries FROM ubn WHERE ban = ?1",
            params!["87003412"],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )?;
    assert_eq!(invoice, 1);
    assert_eq!(status, "suspended");
    assert_eq!(suspension.as_deref(), Some("1150101"));
    let industries: serde_json::Value = serde_json::from_str(&industries)?;
    assert_eq!(industries[0]["code"], "462011");
    assert_eq!(industries[0]["name"], "肥料批發");

    let bucket = shard_of("87003412", 32);
    let shard: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        dir.0.join("shards").join(format!("{bucket}.json")),
    )?)?;
    let shard_row = shard
        .as_array()
        .context("shard is an array")?
        .iter()
        .find(|r| r["ban"] == "87003412")
        .context("shard contains 87003412")?;
    assert_eq!(shard_row["useInvoice"], true);
    assert_eq!(shard_row["name"], "惜緣農業資材行");
    assert_eq!(shard_row["status"], "suspended");

    let active_bucket = shard_of("47588972", 32);
    let active_shard: serde_json::Value = serde_json::from_str(&fs::read_to_string(
        dir.0.join("shards").join(format!("{active_bucket}.json")),
    )?)?;
    let active_row = active_shard
        .as_array()
        .context("shard is an array")?
        .iter()
        .find(|r| r["ban"] == "47588972")
        .context("shard contains 47588972")?;
    assert_eq!(active_row["status"], "active");
    assert_eq!(active_row["useInvoice"], true);
    Ok(())
}

#[test]
fn active_row_replaces_a_suspended_duplicate() -> Result<()> {
    let mut suspended = parse_csv(SUSPENDED_FIXTURE.as_bytes(), Status::Suspended)?;
    let ban = "87003412".to_string();
    let mut active = parse_csv(ACTIVE_FIXTURE.as_bytes(), Status::Active)?;
    let mut dup = active.records[0].clone();
    dup.ban = ban.clone();
    dup.name = "營業中同號".into();
    active.records.push(dup);
    suspended
        .records
        .retain(|r| r.ban == ban || r.ban == "47522228");

    let merged = merge_records(suspended.records, active.records);
    let row = merged.iter().find(|r| r.ban == ban).unwrap();
    assert_eq!(row.status, "active");
    assert_eq!(row.name, "營業中同號");
    assert!(row.suspension_date.is_none());
    assert!(merged
        .iter()
        .any(|r| r.ban == "47522228" && r.status == "suspended"));
    Ok(())
}
