//! Build the tw-ubn open dataset from the FIA daily tax-registry snapshot.
//!
//! Sources (verified 2026-10-27):
//!   active    https://eip.fia.gov.tw/data/BGMOPEN1.zip  (zipped CSV)
//!   suspended https://eip.fia.gov.tw/data/BGMOPEN1X.csv (plain CSV)
//! Merging the two gives a `status` dimension without needing GCIS.
//!
//! Outputs, under --out (default ./dist):
//!   ubn.ndjson.gz    full dataset, one JSON object per line
//!   ubn.sqlite       full dataset, indexed on ban
//!   shards/<n>.json  per-UBN shards (ban -> {name,address,useInvoice,status})
//!   manifest.json    data date, row count, shard count, hash, OGDL attribution
//!
//! Usage:
//!   ubn-build [--out DIR] [--shards N]
//!             [--active-zip PATH] [--suspended-csv PATH] [--no-suspended]
//! When the local paths are omitted the files are fetched over HTTPS.

mod attribution;
mod transform;

use anyhow::{bail, Context, Result};
use attribution::{IncludedSource, ACTIVE_URL, SUSPENDED_URL};
use flate2::write::GzEncoder;
use flate2::Compression;
use rusqlite::{params, Connection};
use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::PathBuf;
use transform::{parse_csv, Record, ShardRecord, Status};
use ubn_core::shard_of;

struct Args {
    out: PathBuf,
    shards: u32,
    active_zip: Option<PathBuf>,
    suspended_csv: Option<PathBuf>,
    no_suspended: bool,
}

fn parse_args() -> Result<Args> {
    let mut a = Args {
        out: PathBuf::from("dist"),
        shards: 8192,
        active_zip: None,
        suspended_csv: None,
        no_suspended: false,
    };
    let mut it = std::env::args().skip(1);
    while let Some(flag) = it.next() {
        let mut next = || it.next().with_context(|| format!("{flag} needs a value"));
        match flag.as_str() {
            "--out" => a.out = PathBuf::from(next()?),
            "--shards" => a.shards = next()?.parse().context("--shards must be an integer")?,
            "--active-zip" => a.active_zip = Some(PathBuf::from(next()?)),
            "--suspended-csv" => a.suspended_csv = Some(PathBuf::from(next()?)),
            "--no-suspended" => a.no_suspended = true,
            other => bail!("unknown argument: {other}"),
        }
    }
    if a.shards == 0 {
        bail!("--shards must be > 0");
    }
    Ok(a)
}

fn http_get(url: &str) -> Result<Vec<u8>> {
    let resp = ureq::get(url)
        .call()
        .with_context(|| format!("GET {url}"))?;
    let mut buf = Vec::new();
    resp.into_reader().read_to_end(&mut buf)?;
    Ok(buf)
}

/// Read the first entry of a zip archive as a UTF-8 string.
fn csv_from_zip(bytes: &[u8]) -> Result<String> {
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))?;
    if archive.is_empty() {
        bail!("zip archive is empty");
    }
    let mut entry = archive.by_index(0)?;
    let mut s = String::new();
    entry.read_to_string(&mut s)?;
    Ok(s)
}

fn write_shards(records: &[Record], out: &std::path::Path, shards: u32) -> Result<()> {
    let dir = out.join("shards");
    fs::create_dir_all(&dir)?;
    let mut buckets: Vec<Vec<ShardRecord>> = vec![Vec::new(); shards as usize];
    for r in records {
        buckets[shard_of(&r.ban, shards) as usize].push(r.to_shard());
    }
    for (i, bucket) in buckets.iter().enumerate() {
        let f = File::create(dir.join(format!("{i}.json")))?;
        serde_json::to_writer(BufWriter::new(f), bucket)?;
    }
    Ok(())
}

fn write_ndjson_gz(records: &[Record], path: &std::path::Path) -> Result<()> {
    let mut w = GzEncoder::new(BufWriter::new(File::create(path)?), Compression::new(9));
    for r in records {
        serde_json::to_writer(&mut w, r)?;
        w.write_all(b"\n")?;
    }
    w.finish()?;
    Ok(())
}

fn write_sqlite(records: &[Record], path: &std::path::Path) -> Result<()> {
    let _ = fs::remove_file(path);
    let mut conn = Connection::open(path)?;
    conn.execute_batch(
        "PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF;
         CREATE TABLE ubn(
           ban TEXT, name TEXT, address TEXT, capital TEXT,
           setup_date TEXT, setup_date_iso TEXT, org_type TEXT,
           use_invoice INTEGER, status TEXT, industries TEXT,
           suspension_date TEXT, suspension_date_iso TEXT);",
    )?;
    {
        let tx = conn.transaction()?;
        {
            let mut stmt =
                tx.prepare("INSERT INTO ubn VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)")?;
            for r in records {
                stmt.execute(params![
                    r.ban,
                    r.name,
                    r.address,
                    r.capital,
                    r.setup_date,
                    r.setup_date_iso,
                    r.org_type,
                    r.use_invoice,
                    r.status,
                    serde_json::to_string(&r.industries)?,
                    r.suspension_date,
                    r.suspension_date_iso,
                ])?;
            }
        }
        tx.commit()?;
    }
    conn.execute("CREATE INDEX idx_ban ON ubn(ban)", [])?;
    conn.execute("VACUUM", [])?;
    Ok(())
}

/// Suspended rows first so a duplicate UBN (unlikely) resolves to the active row.
fn merge_records(suspended: Vec<Record>, active: Vec<Record>) -> Vec<Record> {
    let mut by_ban: BTreeMap<String, Record> = BTreeMap::new();
    for r in suspended {
        by_ban.insert(r.ban.clone(), r);
    }
    for r in active {
        by_ban.insert(r.ban.clone(), r);
    }
    by_ban.into_values().collect()
}

fn main() -> Result<()> {
    let args = parse_args()?;
    fs::create_dir_all(&args.out)?;

    eprintln!("==> loading active tax registry");
    let active_csv = match &args.active_zip {
        Some(p) => csv_from_zip(&fs::read(p)?)?,
        None => csv_from_zip(&http_get(ACTIVE_URL)?)?,
    };
    let active = parse_csv(active_csv.as_bytes(), Status::Active)
        .context("parsing active registry (BGMOPEN1)")?;
    let data_date = active.data_date.clone();

    let (suspended_records, suspended_date) = if args.no_suspended {
        (Vec::new(), None)
    } else {
        eprintln!("==> loading suspended tax registry");
        let csv = match &args.suspended_csv {
            Some(p) => fs::read_to_string(p)?,
            None => String::from_utf8(http_get(SUSPENDED_URL)?)?,
        };
        let suspended = parse_csv(csv.as_bytes(), Status::Suspended)
            .context("parsing suspended registry (BGMOPEN1X)")?;
        eprintln!(
            "    {} suspended rows (data date {:?})",
            suspended.records.len(),
            suspended.data_date
        );
        (suspended.records, suspended.data_date)
    };
    let records = merge_records(suspended_records, active.records);
    eprintln!("==> {} records (data date {:?})", records.len(), data_date);

    eprintln!("==> writing shards ({})", args.shards);
    write_shards(&records, &args.out, args.shards)?;
    eprintln!("==> writing ubn.ndjson.gz");
    write_ndjson_gz(&records, &args.out.join("ubn.ndjson.gz"))?;
    eprintln!("==> writing ubn.sqlite");
    write_sqlite(&records, &args.out.join("ubn.sqlite"))?;

    let suspended = if args.no_suspended {
        IncludedSource::Skipped
    } else {
        IncludedSource::Loaded(suspended_date.as_deref())
    };
    let manifest = attribution::build_manifest(
        data_date.as_deref(),
        suspended,
        records.len(),
        args.shards,
        &chrono_now(),
    );
    fs::write(
        args.out.join("manifest.json"),
        serde_json::to_string_pretty(&manifest)?,
    )?;

    eprintln!("==> done; artifacts in {}", args.out.display());
    Ok(())
}

/// Minimal RFC3339 UTC timestamp without pulling in a date crate.
fn chrono_now() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    // days since epoch -> civil date (Howard Hinnant's algorithm)
    let (days, secs) = ((now / 86400) as i64, now % 86400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        secs / 3600,
        (secs % 3600) / 60,
        secs % 60
    )
}

#[cfg(test)]
mod build_tests;
