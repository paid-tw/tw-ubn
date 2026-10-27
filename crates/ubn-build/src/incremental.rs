//! Incremental upsert: diff today's snapshot against the previous run's state
//! and emit only the delta, so a D1 (or any keyed store) pays writes for just
//! what changed instead of a full daily reload.
//!
//! Emitted SQL follows the D1 import rules
//! (https://developers.cloudflare.com/d1/best-practices/import-export-data/):
//! SQL format, one row per INSERT (avoids "Statement too long"), and no
//! `BEGIN`/`COMMIT` wrappers (D1's import manages the transaction).

use crate::transform::Record;
use anyhow::Result;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;
use ubn_core::shard_of;

/// FNV-1a 64-bit hash of a record's JSON — the change detector. serde emits
/// fields in declaration order, so the string is stable across runs.
pub fn row_hash(r: &Record) -> u64 {
    let s = serde_json::to_string(r).unwrap_or_default();
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in s.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// Load a previous `state.tsv` (`ban\t{hash:016x}` per line). A missing file is
/// treated as an empty state (first run → everything is an upsert).
pub fn load_state(path: &Path) -> Result<HashMap<String, u64>> {
    let mut map = HashMap::new();
    let Ok(f) = File::open(path) else {
        return Ok(map);
    };
    for line in BufReader::new(f).lines() {
        let line = line?;
        if let Some((ban, hex)) = line.split_once('\t') {
            if let Ok(h) = u64::from_str_radix(hex.trim(), 16) {
                map.insert(ban.to_string(), h);
            }
        }
    }
    Ok(map)
}

pub struct Diff {
    /// Indices into `records` that are new or changed.
    pub upserts: Vec<usize>,
    /// UBNs present last time but gone now.
    pub deletes: Vec<String>,
    pub unchanged: usize,
}

/// Diff today's records (with precomputed `hashes`) against `prev`.
pub fn diff(prev: &HashMap<String, u64>, records: &[Record], hashes: &[u64]) -> Diff {
    let mut upserts = Vec::new();
    let mut unchanged = 0usize;
    let mut seen: HashSet<&str> = HashSet::with_capacity(records.len());
    for (i, r) in records.iter().enumerate() {
        seen.insert(r.ban.as_str());
        match prev.get(&r.ban) {
            Some(&h) if h == hashes[i] => unchanged += 1,
            _ => upserts.push(i),
        }
    }
    let deletes = prev
        .keys()
        .filter(|b| !seen.contains(b.as_str()))
        .cloned()
        .collect();
    Diff {
        upserts,
        deletes,
        unchanged,
    }
}

/// Single-quote a SQL string literal (doubling embedded quotes).
fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

const COLUMNS: &str = "ban, name, address, capital, setup_date, setup_date_iso, org_type, use_invoice, status, suspension_date, suspension_date_iso, industries";

fn sql_text(value: Option<&str>) -> String {
    value.map(q).unwrap_or_else(|| "NULL".into())
}

fn values(r: &Record) -> String {
    let industries = serde_json::to_string(&r.industries).unwrap_or_else(|_| "[]".into());
    format!(
        "({}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {})",
        q(&r.ban),
        q(&r.name),
        q(&r.address),
        q(&r.capital),
        q(&r.setup_date),
        sql_text(r.setup_date_iso.as_deref()),
        q(&r.org_type),
        if r.use_invoice { 1 } else { 0 },
        q(r.status),
        sql_text(r.suspension_date.as_deref()),
        sql_text(r.suspension_date_iso.as_deref()),
        q(&industries),
    )
}

/// `CREATE TABLE IF NOT EXISTS` — a UBN primary key, so `ON CONFLICT(ban)` works.
/// Also an index on `name` so the D1 variant's prefix search (`name LIKE 'x%'`)
/// is index-assisted and reads few rows. The index costs one extra row_written
/// per insert/name-change; harmless for the R2 path, which never creates D1.
pub fn write_schema_sql(path: &Path) -> Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    writeln!(
        w,
        "CREATE TABLE IF NOT EXISTS ubn (\n  \
         ban TEXT PRIMARY KEY, name TEXT, address TEXT, capital TEXT,\n  \
         setup_date TEXT, setup_date_iso TEXT, org_type TEXT,\n  \
         use_invoice INTEGER, status TEXT,\n  \
         suspension_date TEXT, suspension_date_iso TEXT, industries TEXT\n);\n\
         CREATE INDEX IF NOT EXISTS idx_name ON ubn (name);"
    )?;
    Ok(())
}

/// Idempotent column adds for D1 databases created before these columns
/// existed. `CREATE TABLE IF NOT EXISTS` never alters an existing table, so an
/// old `ubn` would lack `suspension_date` / `suspension_date_iso` and the first
/// delta upsert would fail with "table ubn has no column named suspension_date".
/// Apply each statement on its own, ignoring the "duplicate column name" error a
/// freshly-created table raises.
pub fn write_migrate_sql(path: &Path) -> Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    writeln!(
        w,
        "ALTER TABLE ubn ADD COLUMN suspension_date TEXT;\n\
         ALTER TABLE ubn ADD COLUMN suspension_date_iso TEXT;"
    )?;
    Ok(())
}

/// Emit the delta as one-row upserts + chunked deletes (no transaction wrapper).
pub fn write_delta_sql(records: &[Record], d: &Diff, path: &Path) -> Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    for &i in &d.upserts {
        let r = &records[i];
        writeln!(
            w,
            "INSERT INTO ubn ({COLUMNS}) VALUES {} ON CONFLICT(ban) DO UPDATE SET \
             name=excluded.name, address=excluded.address, capital=excluded.capital, \
             setup_date=excluded.setup_date, setup_date_iso=excluded.setup_date_iso, \
             org_type=excluded.org_type, use_invoice=excluded.use_invoice, \
             status=excluded.status, suspension_date=excluded.suspension_date, \
             suspension_date_iso=excluded.suspension_date_iso, \
             industries=excluded.industries;",
            values(r),
        )?;
    }
    // DELETE ... IN (...) in small chunks to stay well under statement limits.
    for chunk in d.deletes.chunks(200) {
        let list = chunk.iter().map(|b| q(b)).collect::<Vec<_>>().join(", ");
        writeln!(w, "DELETE FROM ubn WHERE ban IN ({list});")?;
    }
    Ok(())
}

/// Persist the current full state for the next run to diff against.
pub fn write_state(records: &[Record], hashes: &[u64], path: &Path) -> Result<()> {
    let mut w = BufWriter::new(File::create(path)?);
    for (r, h) in records.iter().zip(hashes) {
        writeln!(w, "{}\t{:016x}", r.ban, h)?;
    }
    Ok(())
}

/// List the shard buckets touched by the delta, so only those need re-uploading.
pub fn write_changed_shards(records: &[Record], d: &Diff, shards: u32, path: &Path) -> Result<()> {
    let mut set: BTreeSet<u32> = BTreeSet::new();
    for &i in &d.upserts {
        set.insert(shard_of(&records[i].ban, shards));
    }
    for ban in &d.deletes {
        set.insert(shard_of(ban, shards));
    }
    let mut w = BufWriter::new(File::create(path)?);
    for b in set {
        writeln!(w, "{b}")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transform::{Record, Status};

    fn rec(ban: &str, name: &str) -> Record {
        Record {
            ban: ban.into(),
            name: name.into(),
            address: "addr".into(),
            capital: "0".into(),
            setup_date: "".into(),
            setup_date_iso: None,
            org_type: "獨資".into(),
            use_invoice: false,
            status: Status::Active.as_str(),
            suspension_date: None,
            suspension_date_iso: None,
            industries: vec![],
        }
    }

    #[test]
    fn diff_classifies_new_changed_unchanged_removed() {
        let a = rec("10000001", "A");
        let b = rec("10000002", "B");
        let recs = vec![a.clone(), b.clone(), rec("10000003", "C-new")];
        let hashes: Vec<u64> = recs.iter().map(row_hash).collect();

        let mut prev = HashMap::new();
        prev.insert("10000001".to_string(), row_hash(&a)); // unchanged
        prev.insert("10000002".to_string(), row_hash(&rec("10000002", "B-old"))); // changed
        prev.insert("10000009".to_string(), 123); // removed

        let d = diff(&prev, &recs, &hashes);
        assert_eq!(d.unchanged, 1);
        assert_eq!(d.upserts.len(), 2); // B changed + C new
        assert_eq!(d.deletes, vec!["10000009".to_string()]);
    }

    #[test]
    fn sql_quotes_are_escaped_and_upsert_is_wellformed() {
        let mut r = rec("10000001", "O'Reilly 商行");
        r.suspension_date = Some("1150101".into());
        r.suspension_date_iso = Some("2026-01-01".into());
        let d = Diff {
            upserts: vec![0],
            deletes: vec!["10000009".into()],
            unchanged: 0,
        };
        let dir = std::env::temp_dir().join(format!("ubn-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("delta.sql");
        write_delta_sql(&[r], &d, &p).unwrap();
        let schema_path = dir.join("schema.sql");
        write_schema_sql(&schema_path).unwrap();
        let schema = std::fs::read_to_string(&schema_path).unwrap();
        assert!(schema.contains("suspension_date TEXT"));
        assert!(schema.contains("CREATE INDEX IF NOT EXISTS idx_name ON ubn (name)"));
        let migrate_path = dir.join("migrate.sql");
        write_migrate_sql(&migrate_path).unwrap();
        let migrate = std::fs::read_to_string(&migrate_path).unwrap();
        assert!(migrate.contains("ALTER TABLE ubn ADD COLUMN suspension_date TEXT;"));
        assert!(migrate.contains("ALTER TABLE ubn ADD COLUMN suspension_date_iso TEXT;"));
        let sql = std::fs::read_to_string(&p).unwrap();
        assert!(sql.contains("'O''Reilly 商行'"));
        assert!(sql.contains("ON CONFLICT(ban) DO UPDATE"));
        assert!(sql.contains("'1150101'"));
        assert!(sql.contains("'2026-01-01'"));
        assert!(sql.contains("suspension_date=excluded.suspension_date"));
        assert!(sql.contains("DELETE FROM ubn WHERE ban IN ('10000009');"));
        assert!(!sql.contains("BEGIN")); // D1 import manages the transaction
    }
}
