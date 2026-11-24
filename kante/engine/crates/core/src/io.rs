//! Binary cache files (`data/built/*.bin`): bincode with a small header so a
//! stale cache from an older struct layout is rejected instead of misread.

use anyhow::{bail, Context, Result};
use serde::{de::DeserializeOwned, Serialize};
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Write};
use std::path::Path;

const MAGIC: &[u8; 8] = b"KANTE\0\0\x01";

/// Write `value` to `path` atomically (temp file + rename). `schema` is a
/// caller-chosen version string; bump it whenever the struct layout changes.
pub fn save<T: Serialize>(path: &Path, schema: &str, value: &T) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension("tmp");
    {
        let mut w = BufWriter::with_capacity(8 << 20, File::create(&tmp).with_context(|| format!("create {}", tmp.display()))?);
        w.write_all(MAGIC)?;
        let s = schema.as_bytes();
        w.write_all(&(s.len() as u32).to_le_bytes())?;
        w.write_all(s)?;
        bincode::serialize_into(&mut w, value)?;
        w.flush()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

pub fn load<T: DeserializeOwned>(path: &Path, schema: &str) -> Result<T> {
    let mut r = BufReader::with_capacity(8 << 20, File::open(path).with_context(|| format!("open {}", path.display()))?);
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic)?;
    if &magic != MAGIC {
        bail!("{}: not a Kante cache file", path.display());
    }
    let mut len = [0u8; 4];
    r.read_exact(&mut len)?;
    let mut s = vec![0u8; u32::from_le_bytes(len) as usize];
    r.read_exact(&mut s)?;
    if s != schema.as_bytes() {
        bail!("{}: schema {:?} but expected {:?}; rebuild the data", path.display(), String::from_utf8_lossy(&s), schema);
    }
    Ok(bincode::deserialize_from(&mut r)?)
}

/// The schema a cache file was written with, or None if it is not one (or cannot be read).
pub fn schema_of(path: &Path) -> Option<String> {
    let mut r = File::open(path).ok()?;
    let mut magic = [0u8; 8];
    r.read_exact(&mut magic).ok()?;
    if &magic != MAGIC {
        return None;
    }
    let mut len = [0u8; 4];
    r.read_exact(&mut len).ok()?;
    let n = u32::from_le_bytes(len) as usize;
    if n > 256 {
        return None;
    }
    let mut s = vec![0u8; n];
    r.read_exact(&mut s).ok()?;
    String::from_utf8(s).ok()
}
