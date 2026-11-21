//! Minimal, allocation-free CSV record splitter for the GTFS and atlas files.
//!
//! Fields are returned as byte ranges into the input buffer (the content
//! between the quotes for quoted fields), so the hot loops never allocate a
//! `String` per field. Quoted fields may contain the separator, doubled
//! quotes and line breaks.

use anyhow::{anyhow, bail, Result};

#[derive(Clone, Copy, Debug, Default)]
pub struct Field {
    pub start: usize,
    pub end: usize,
    /// The raw bytes contain `""` escapes (see [`unescape`]).
    pub esc: bool,
}

impl Field {
    #[inline]
    pub fn is_empty(&self) -> bool {
        self.start == self.end
    }
    #[inline]
    pub fn raw<'a>(&self, buf: &'a [u8]) -> &'a [u8] {
        &buf[self.start..self.end]
    }
}

/// Split the record starting at `pos` into `out` and return the position of
/// the next record. A blank line yields one empty field.
#[inline]
pub fn next_record(buf: &[u8], mut pos: usize, sep: u8, out: &mut Vec<Field>) -> usize {
    out.clear();
    let len = buf.len();
    loop {
        if pos < len && buf[pos] == b'"' {
            let start = pos + 1;
            let mut p = start;
            let mut esc = false;
            loop {
                match memchr::memchr(b'"', &buf[p..]) {
                    None => {
                        p = len;
                        break;
                    }
                    Some(i) => {
                        p += i;
                        if p + 1 < len && buf[p + 1] == b'"' {
                            esc = true;
                            p += 2;
                        } else {
                            break;
                        }
                    }
                }
            }
            out.push(Field { start, end: p, esc });
            pos = (p + 1).min(len);
            // Tolerate stray bytes between the closing quote and the separator.
            while pos < len && buf[pos] != sep && buf[pos] != b'\n' && buf[pos] != b'\r' {
                pos += 1;
            }
        } else {
            let start = pos;
            while pos < len {
                let c = buf[pos];
                if c == sep || c == b'\n' || c == b'\r' {
                    break;
                }
                pos += 1;
            }
            out.push(Field { start, end: pos, esc: false });
        }
        if pos < len && buf[pos] == sep {
            pos += 1;
            continue;
        }
        if pos < len && buf[pos] == b'\r' {
            pos += 1;
        }
        if pos < len && buf[pos] == b'\n' {
            pos += 1;
        }
        return pos;
    }
}

/// Field content as text: `""` → `"`, invalid UTF-8 replaced.
pub fn unescape(raw: &[u8], esc: bool) -> String {
    let s = String::from_utf8_lossy(raw);
    if esc {
        s.replace("\"\"", "\"")
    } else {
        s.into_owned()
    }
}

pub fn strip_bom(buf: &[u8]) -> &[u8] {
    buf.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(buf)
}

/// Column names of a file and the offset of the first data record.
pub struct Header {
    pub file: String,
    pub cols: Vec<String>,
    pub body: usize,
}

impl Header {
    pub fn parse(file: &str, buf: &[u8], sep: u8) -> Result<Header> {
        let bom = buf.len() - strip_bom(buf).len();
        if bom == buf.len() {
            bail!("{file}: file is empty");
        }
        let mut fields = Vec::new();
        let body = next_record(buf, bom, sep, &mut fields);
        let cols = fields.iter().map(|f| unescape(f.raw(buf), f.esc).trim().to_string()).collect();
        Ok(Header { file: file.to_string(), cols, body })
    }

    pub fn opt(&self, name: &str) -> Option<usize> {
        self.cols.iter().position(|c| c == name)
    }

    pub fn col(&self, name: &str) -> Result<usize> {
        self.opt(name)
            .ok_or_else(|| anyhow!("{}: missing column '{}' (found: {})", self.file, name, self.cols.join(",")))
    }
}

/// Sequential reader over a whole in-memory file.
pub struct Table<'a> {
    pub buf: &'a [u8],
    pub header: Header,
    pos: usize,
    sep: u8,
    fields: Vec<Field>,
}

impl<'a> Table<'a> {
    pub fn new(file: &str, buf: &'a [u8], sep: u8) -> Result<Self> {
        let header = Header::parse(file, buf, sep)?;
        let pos = header.body;
        Ok(Table { buf, header, pos, sep, fields: Vec::with_capacity(32) })
    }

    pub fn col(&self, name: &str) -> Result<usize> {
        self.header.col(name)
    }

    pub fn opt(&self, name: &str) -> Option<usize> {
        self.header.opt(name)
    }

    /// Advance to the next non-blank record.
    pub fn next(&mut self) -> bool {
        while self.pos < self.buf.len() {
            self.pos = next_record(self.buf, self.pos, self.sep, &mut self.fields);
            if self.fields.len() == 1 && self.fields[0].is_empty() {
                continue;
            }
            return true;
        }
        false
    }

    /// Raw bytes of a column; empty when the record is too short.
    #[inline]
    pub fn get(&self, col: usize) -> &'a [u8] {
        match self.fields.get(col) {
            Some(f) => &self.buf[f.start..f.end],
            None => b"",
        }
    }

    #[inline]
    pub fn get_opt(&self, col: Option<usize>) -> &'a [u8] {
        match col {
            Some(c) => self.get(c),
            None => b"",
        }
    }

    pub fn field(&self, col: usize) -> Field {
        self.fields.get(col).copied().unwrap_or_default()
    }

    pub fn text(&self, col: usize) -> String {
        let f = self.field(col);
        unescape(f.raw(self.buf), f.esc)
    }

    pub fn text_opt(&self, col: Option<usize>) -> String {
        col.map(|c| self.text(c)).unwrap_or_default()
    }
}

/// Split `buf` into about `n` pieces that end on a line break. Only valid for
/// files without line breaks inside quoted fields (records that get cut are
/// counted as malformed by the callers).
pub fn split_lines(buf: &[u8], n: usize) -> Vec<&[u8]> {
    let n = n.max(1);
    let target = (buf.len() / n).max(1 << 16);
    let mut out = Vec::with_capacity(n + 1);
    let mut start = 0;
    while start < buf.len() {
        let mut end = (start + target).min(buf.len());
        if end < buf.len() {
            end = match memchr::memchr(b'\n', &buf[end..]) {
                Some(i) => end + i + 1,
                None => buf.len(),
            };
        }
        out.push(&buf[start..end]);
        start = end;
    }
    out
}

#[inline]
pub fn parse_u32(b: &[u8]) -> Option<u32> {
    let b = b.trim_ascii();
    if b.is_empty() || b.len() > 10 {
        return None;
    }
    let mut v: u64 = 0;
    for &c in b {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v * 10 + (c - b'0') as u64;
    }
    u32::try_from(v).ok()
}

pub fn parse_f64(b: &[u8]) -> Option<f64> {
    std::str::from_utf8(b).ok()?.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// `HH:MM:SS` (hours may exceed 23) → seconds; `None` when empty or invalid.
#[inline]
pub fn parse_time(b: &[u8]) -> Option<i32> {
    #[inline(always)]
    fn d(c: u8) -> Option<i32> {
        if c.is_ascii_digit() {
            Some((c - b'0') as i32)
        } else {
            None
        }
    }
    if b.len() == 8 && b[2] == b':' && b[5] == b':' {
        let h = d(b[0])? * 10 + d(b[1])?;
        let m = d(b[3])? * 10 + d(b[4])?;
        let s = d(b[6])? * 10 + d(b[7])?;
        return Some(h * 3600 + m * 60 + s);
    }
    let b = b.trim_ascii();
    if b.is_empty() {
        return None;
    }
    let mut parts = [0i32; 3];
    let mut idx = 0;
    let mut digits = 0;
    for &c in b {
        if c == b':' {
            if digits == 0 || idx == 2 {
                return None;
            }
            idx += 1;
            digits = 0;
        } else {
            parts[idx] = parts[idx].checked_mul(10)?.checked_add(d(c)?)?;
            digits += 1;
            if digits > 4 {
                return None;
            }
        }
    }
    if idx != 2 || digits == 0 {
        return None;
    }
    Some(parts[0] * 3600 + parts[1] * 60 + parts[2])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(s: &str, sep: u8) -> Vec<Vec<String>> {
        let b = s.as_bytes();
        let mut out = Vec::new();
        let mut f = Vec::new();
        let mut pos = 0;
        while pos < b.len() {
            pos = next_record(b, pos, sep, &mut f);
            out.push(f.iter().map(|x| unescape(x.raw(b), x.esc)).collect());
        }
        out
    }

    #[test]
    fn records() {
        let r = rec("\"a\",\"b,\"\"x\"\"\",c\r\n1,,\"\"\n\"multi\nline\",2", b',');
        assert_eq!(r[0], vec!["a", "b,\"x\"", "c"]);
        assert_eq!(r[1], vec!["1", "", ""]);
        assert_eq!(r[2], vec!["multi\nline", "2"]);
        let r = rec("x;y;\n;;z", b';');
        assert_eq!(r[0], vec!["x", "y", ""]);
        assert_eq!(r[1], vec!["", "", "z"]);
    }

    #[test]
    fn header_and_table() {
        let buf = b"\xEF\xBB\xBFa,b\r\n\"1\",\"2\"\r\n\r\n3,4\r\n";
        let mut t = Table::new("x.txt", buf, b',').unwrap();
        assert!(t.col("c").is_err());
        let (a, b) = (t.col("a").unwrap(), t.col("b").unwrap());
        assert!(t.next());
        assert_eq!((t.get(a), t.get(b)), (&b"1"[..], &b"2"[..]));
        assert!(t.next());
        assert_eq!(t.text(b), "4");
        assert!(!t.next());
    }

    #[test]
    fn numbers() {
        assert_eq!(parse_time(b"25:15:00"), Some(90900));
        assert_eq!(parse_time(b"5:07:09"), Some(5 * 3600 + 7 * 60 + 9));
        assert_eq!(parse_time(b"105:00:00"), Some(105 * 3600));
        assert_eq!(parse_time(b""), None);
        assert_eq!(parse_time(b"aa:bb:cc"), None);
        assert_eq!(parse_u32(b" 42 "), Some(42));
        assert_eq!(parse_u32(b"4294967296"), None);
        assert_eq!(parse_u32(b"-1"), None);
    }

    #[test]
    fn split() {
        let mut s = String::new();
        for i in 0..100_000 {
            s.push_str(&format!("row{i},x\r\n"));
        }
        let parts = split_lines(s.as_bytes(), 7);
        assert!(parts.len() > 1);
        assert_eq!(parts.iter().map(|p| p.len()).sum::<usize>(), s.len());
        assert!(parts.iter().all(|p| p.ends_with(b"\n")));
    }
}
