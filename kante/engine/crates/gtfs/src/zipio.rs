//! Reading members straight out of the GTFS zip (nothing is unpacked to disk).

use anyhow::{anyhow, bail, Context, Result};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;
use zip::ZipArchive;

pub type Archive = ZipArchive<BufReader<File>>;

/// Members that are held in memory as a whole may not inflate beyond this
/// (the archive is untrusted input). `stop_times.txt` is streamed instead.
const MAX_MEMBER_BYTES: u64 = 4 << 30;

pub fn open(path: &Path) -> Result<Archive> {
    let f = File::open(path).with_context(|| format!("open {}", path.display()))?;
    ZipArchive::new(BufReader::with_capacity(1 << 20, f)).with_context(|| format!("{}: not a readable zip archive", path.display()))
}

pub fn has(ar: &Archive, name: &str) -> bool {
    ar.index_for_name(name).is_some()
}

/// Whole member in memory, `None` when the archive has no such member.
pub fn read_opt(ar: &mut Archive, name: &str) -> Result<Option<Vec<u8>>> {
    if !has(ar, name) {
        return Ok(None);
    }
    let mut f = ar.by_name(name).map_err(|e| anyhow!("{name}: {e}"))?;
    // The declared size is untrusted; it only seeds the allocation.
    let mut buf = Vec::with_capacity((f.size() as usize).min(1 << 30) + 16);
    (&mut f).take(MAX_MEMBER_BYTES + 1).read_to_end(&mut buf).with_context(|| format!("{name}: decompression failed"))?;
    if buf.len() as u64 > MAX_MEMBER_BYTES {
        bail!("{name}: larger than {} GiB uncompressed; refusing to load it into memory", MAX_MEMBER_BYTES >> 30);
    }
    Ok(Some(buf))
}

pub fn read(ar: &mut Archive, name: &str) -> Result<Vec<u8>> {
    read_opt(ar, name)?.ok_or_else(|| anyhow!("GTFS archive has no member {name}"))
}

pub fn read_path(path: &Path, name: &str) -> Result<Vec<u8>> {
    read(&mut open(path)?, name)
}

pub fn read_path_opt(path: &Path, name: &str) -> Result<Option<Vec<u8>>> {
    read_opt(&mut open(path)?, name)
}
