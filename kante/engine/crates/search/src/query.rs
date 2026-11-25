//! Query side: `search`, `resolve`, `reverse`.
//!
//! A query is split into canonical tokens. Every token becomes a [`Spec`]: a
//! few ranges of vocabulary ids (its prefix range, alias words, and — in the
//! typo fallback — words one edit away). A document matches when every token
//! matches one of its name, alternative-name or locality tokens.
//!
//! Candidates come from the rarest token's posting lists and are verified and
//! scored against the document's forward list. Because documents are numbered
//! by prominence, "too many candidates" is cut by taking the smallest ids
//! (or the precomputed top list of a frequent prefix); with a position, a ring
//! search over the document grid adds what is close by.
//!
//! A query that contains a house number is additionally read as
//! *street + number*: the remaining tokens select streets, the number selects
//! houses inside them.

use crate::cats::{CLASS_NATURE, CLASS_PLACE_MAJOR, CLASS_PLACE_MINOR};
use crate::text::{self, Toks};
use crate::*;
use std::cell::RefCell;
use std::cmp::Ordering;

const MAX_Q: usize = 8;
const Q_FUZZY: u8 = 1;
const Q_PREFIX: u8 = 2;
/// A synonym of the typed word ("genf" for "Genève"): as good as exact for
/// deciding what kind of match this is, a touch below it in score.
const Q_ALIAS: u8 = 3;
const Q_EXACT: u8 = 4;

/// Most candidates verified for one multi-token query.
const BUDGET: usize = 12_000;
/// Documents looked at around the user's position.
const LOCAL_BUDGET: i32 = 8_000;

// ---- scoring (same scale as document prominence, 0..=127) ------------------
/// The query is the whole name.
const B_FULL: f32 = 60.0;
/// The query is the whole name plus (part of) its locality: "bundesgasse bern".
const B_FULL_LOC: f32 = 52.0;
/// The query is the stop's own name: "bundesplatz" for "Bern, Bundesplatz".
const B_SUB_FULL: f32 = 50.0;
/// The query is the beginning of the name.
const B_PREFIX: f32 = 40.0;
const B_SUB_PREFIX: f32 = 32.0;
/// All words of the name are typed, in another order.
const B_ALL_COVERED: f32 = 36.0;
/// All typed words are in the name.
const B_IN_NAME: f32 = 25.0;
/// A town is rarely where one wants to go — its stations are. An exact
/// locality name therefore sits among the station names that start with it.
const P_LOCALITY_FULL: f32 = 12.0;
/// The words typed start the name, the rest is its locality: "verkehrshaus luzern".
const B_PREFIX_LOC: f32 = 30.0;
/// The category was typed: "apotheke", "bahnhof" for a rail station.
const B_KEYWORD: f32 = 34.0;
/// Words of another name of the thing (other language, short name). How much
/// of that name was typed is unknown, so this stays below a real name match.
const B_ALT_EXACT: f32 = 24.0;
const B_ALT: f32 = 16.0;
/// Two typed words had to share one word of the name ("bern b" on "Bern").
const P_SHARED: f32 = 6.0;
const B_NAME_AND_ALT: f32 = 30.0;
/// The whole name plus a category word: "bern bahnhof" for the station "Bern".
const B_FULL_ALT: f32 = 46.0;
const B_NAME_AND_LOC: f32 = 12.0;
/// A category word plus a locality: "apotheke bern".
const B_ALT_AND_LOC: f32 = 12.0;
const P_ALIAS: f32 = 3.0;
/// Only the locality matched ("bern" finding a street in Bern).
const B_LOC_ONLY: f32 = -25.0;
const P_UNCOVERED: f32 = 1.5;
const P_MID_PREFIX: f32 = 3.0;
const P_FUZZY: f32 = 12.0;
const B_LAST_EXACT: f32 = 4.0;
const PROX_MAX: f32 = 45.0;
const PROX_HALF_M: f32 = 2_000.0;
const B_HOUSE: f32 = 45.0;
const B_HOUSE_PARTIAL: f32 = 28.0;
const B_HOUSE_PREFIX: f32 = 12.0;

#[derive(Clone, Copy)]
struct Rng {
    lo: u32,
    hi: u32,
    q: u8,
}

/// What one query token may match.
#[derive(Default)]
struct Spec {
    ranges: Vec<Rng>,
    /// Vocabulary id spelled exactly like the token, if any.
    exact: u32,
    /// The token the user is still typing.
    last: bool,
    /// `ranges[0]` is the plain prefix range of the token.
    pure: bool,
    /// Typed length in bytes.
    len: usize,
}

impl Spec {
    #[inline]
    fn quality(&self, id: u32) -> u8 {
        if id == self.exact {
            return Q_EXACT;
        }
        let mut best = 0;
        for r in &self.ranges {
            if id >= r.lo && id < r.hi && r.q > best {
                best = r.q;
            }
        }
        best
    }
}

#[derive(Clone, Copy)]
struct Res {
    score: f32,
    id: u32,
    house: bool,
}

#[derive(Default)]
struct Scratch {
    toks: Toks,
    specs: Vec<Spec>,
    cand: Vec<u32>,
    res: Vec<Res>,
    streets: Vec<Res>,
    tmp: Vec<u32>,
}

thread_local! {
    static SCRATCH: RefCell<Scratch> = RefCell::new(Scratch::default());
}

/// The user's position with the two factors that turn coordinate deltas into metres.
#[derive(Clone, Copy)]
struct Near {
    lat: i32,
    lon: i32,
    kx: f32,
    ky: f32,
}

impl Near {
    fn new(p: LatLon) -> Near {
        let ky = (kante_core::geo::M_PER_DEG_LAT * 1e-7) as f32;
        Near { lat: p.lat, lon: p.lon, kx: ky * (p.lat_deg().to_radians().cos() as f32), ky }
    }
    #[inline]
    fn dist(&self, lat: i32, lon: i32) -> f32 {
        // 64-bit differences: stray coordinates must not overflow.
        let dx = (lon as i64 - self.lon as i64) as f32 * self.kx;
        let dy = (lat as i64 - self.lat as i64) as f32 * self.ky;
        (dx * dx + dy * dy).sqrt()
    }
    #[inline]
    fn boost(&self, lat: i32, lon: i32) -> f32 {
        let d = self.dist(lat, lon);
        let r = d / PROX_HALF_M;
        PROX_MAX / (1.0 + r * r) + 5.0 / (1.0 + d / 20_000.0)
    }
}

fn bsearch(mut lo: usize, mut hi: usize, pred: impl Fn(usize) -> bool) -> usize {
    while lo < hi {
        let mid = (lo + hi) / 2;
        if pred(mid) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    lo
}

/// Keep the `k` smallest values of `v` (any order).
fn keep_smallest(v: &mut Vec<u32>, k: usize) -> bool {
    if v.len() <= k {
        return false;
    }
    v.select_nth_unstable(k);
    v.truncate(k);
    true
}

impl SearchIndex {
    /// Type-ahead search. The last word is a prefix, every word must match,
    /// word order does not matter. `near` favours what is close without
    /// hiding an exact name match elsewhere.
    pub fn search(&self, query: &str, near: Option<LatLon>, limit: usize) -> Vec<Hit> {
        if limit == 0 || self.kind.is_empty() {
            return Vec::new();
        }
        SCRATCH.with(|s| match s.try_borrow_mut() {
            Ok(mut sc) => self.search_in(&mut sc, query, near, limit),
            Err(_) => self.search_in(&mut Scratch::default(), query, near, limit),
        })
    }

    fn search_in(&self, sc: &mut Scratch, query: &str, near: Option<LatLon>, limit: usize) -> Vec<Hit> {
        let Scratch { toks, specs, cand, res, streets, tmp } = sc;
        toks.clear();
        text::tokenize_query(query, toks);
        let n = toks.len().min(MAX_Q);
        if n == 0 {
            return Vec::new();
        }
        let near = near.filter(|p| !p.is_none()).map(Near::new);
        while specs.len() < n {
            specs.push(Spec::default());
        }
        for (i, spec) in specs.iter_mut().enumerate().take(n) {
            self.make_spec(toks.get(i), i + 1 == n, spec);
        }
        res.clear();
        self.run_all(toks, &specs[..n], near.as_ref(), cand, streets, res);

        // Typo fallback: only when the plain search found next to nothing.
        if res.len() < 3 {
            let empty: Vec<bool> = specs[..n].iter().map(|s| s.ranges.is_empty()).collect();
            let any_empty = empty.iter().any(|&e| e);
            let mut changed = false;
            for i in 0..n {
                let t = toks.get(i);
                if t.len() < 5 || t.as_bytes()[0].is_ascii_digit() || (any_empty && !empty[i]) {
                    continue;
                }
                changed |= self.add_fuzzy(t, i + 1 == n, &mut specs[i], tmp);
            }
            if changed {
                self.run_all(toks, &specs[..n], near.as_ref(), cand, streets, res);
            }
        }

        // Best `limit`, without sorting everything.
        let want = (limit * 2 + 8).min(res.len());
        let by_score = |a: &Res, b: &Res| b.score.total_cmp(&a.score).then(a.house.cmp(&b.house)).then(a.id.cmp(&b.id));
        if res.len() > want {
            res.select_nth_unstable_by(want, by_score);
            res.truncate(want);
        }
        res.sort_unstable_by(by_score);
        res.dedup_by(|b, a| a.house == b.house && a.id == b.id);
        let mut hits: Vec<Hit> = Vec::with_capacity(limit);
        for r in res.iter() {
            let h = if r.house { self.house_hit(r.id, r.score) } else { self.doc_hit(r.id, r.score) };
            // The same thing mapped twice (a node and its building) shows once.
            if hits.iter().any(|o| o.kind == h.kind && o.name == h.name && o.detail == h.detail && o.pos.dist_m(&h.pos) < 200.0) {
                continue;
            }
            hits.push(h);
            if hits.len() == limit {
                break;
            }
        }
        hits
    }

    /// Every reading of the query: all words as text, and each number as a house number.
    fn run_all(&self, toks: &Toks, specs: &[Spec], near: Option<&Near>, cand: &mut Vec<u32>, streets: &mut Vec<Res>, res: &mut Vec<Res>) {
        let n = specs.len();
        let mut sel = [0u8; MAX_Q];
        for (i, s) in sel.iter_mut().enumerate().take(n) {
            *s = i as u8;
        }
        self.run(specs, &sel[..n], false, near, cand, res);
        if n < 2 {
            return;
        }
        let mut tried = 0;
        for k in (0..n).rev() {
            if !text::is_house_number(toks.get(k)) {
                continue;
            }
            let mut m = 0;
            for i in (0..n).filter(|&i| i != k) {
                sel[m] = i as u8;
                m += 1;
            }
            streets.clear();
            self.run(specs, &sel[..m], true, near, cand, streets);
            self.houses(toks.get(k), k + 1 == n, near, streets, res);
            tried += 1;
            if tried == 3 {
                break;
            }
        }
    }

    // -----------------------------------------------------------------------
    // Tokens → vocabulary ranges
    // -----------------------------------------------------------------------

    fn prefix_range(&self, p: &[u8]) -> (u32, u32) {
        let n = self.vocab.len();
        let lo = bsearch(0, n, |i| self.vocab.get(i) < p);
        let hi = bsearch(lo, n, |i| self.vocab.get(i).starts_with(p));
        (lo as u32, hi as u32)
    }

    fn vocab_find(&self, t: &[u8]) -> Option<u32> {
        let n = self.vocab.len();
        let lo = bsearch(0, n, |i| self.vocab.get(i) < t);
        (lo < n && self.vocab.get(lo) == t).then_some(lo as u32)
    }

    fn make_spec(&self, tok: &str, last: bool, spec: &mut Spec) {
        spec.ranges.clear();
        spec.exact = NONE;
        spec.last = last;
        spec.pure = false;
        spec.len = tok.len();
        let b = tok.as_bytes();
        let digit = b[0].is_ascii_digit();
        // Short words in the middle ("de", "la", "3") must match as they are.
        if last || (b.len() >= 3 && !digit) {
            let (lo, hi) = self.prefix_range(b);
            if lo < hi {
                spec.ranges.push(Rng { lo, hi, q: Q_PREFIX });
                spec.pure = true;
                if self.vocab.get(lo as usize) == b {
                    spec.exact = lo;
                }
            }
        } else if let Some(id) = self.vocab_find(b) {
            spec.ranges.push(Rng { lo: id, hi: id + 1, q: Q_EXACT });
            spec.exact = id;
        }
        if !digit && b.len() >= 2 {
            for (src, dst) in text::aliases() {
                let q = if src == tok {
                    Q_ALIAS
                } else if last && b.len() >= 3 && src.starts_with(tok) {
                    Q_PREFIX
                } else {
                    continue;
                };
                if let Some(id) = self.vocab_find(dst.as_bytes()) {
                    spec.ranges.push(Rng { lo: id, hi: id + 1, q });
                }
            }
        }
    }

    /// Add vocabulary words one edit away from `tok`. Returns whether any were found.
    fn add_fuzzy(&self, tok: &str, last: bool, spec: &mut Spec, tmp: &mut Vec<u32>) -> bool {
        let q = tok.as_bytes();
        let n = q.len();
        tmp.clear();
        // An edit leaves the beginning or the end of the word intact. Short
        // words: scan everything with the same first letter; long words: the
        // same first two letters, or the same ending.
        let h = if n <= 6 { 1 } else { 2 };
        let (lo, hi) = self.prefix_range(&q[..h]);
        for id in lo..hi {
            let t = self.vocab.get(id as usize);
            if t.len() + 1 < n {
                continue;
            }
            if (t.len() <= n + 1 && text::within1(q, t, false)) || (last && text::within1(q, t, true)) {
                tmp.push(id);
            }
        }
        if n >= 7 {
            let suf = &q[3..];
            let nv = self.vocab_rev.len();
            let mut i = bsearch(0, nv, |i| self.vocab.get(self.vocab_rev[i] as usize).iter().rev().cmp(suf.iter().rev()) == Ordering::Less);
            while i < nv {
                let id = self.vocab_rev[i];
                let t = self.vocab.get(id as usize);
                if !t.ends_with(suf) {
                    break;
                }
                if t.len() + 1 >= n && t.len() <= n + 1 && text::within1(q, t, false) {
                    tmp.push(id);
                }
                i += 1;
            }
        }
        tmp.sort_unstable();
        tmp.dedup();
        let before = spec.ranges.len();
        let mut i = 0;
        while i < tmp.len() && spec.ranges.len() < before + 48 {
            let lo = tmp[i];
            let mut hi = lo + 1;
            i += 1;
            while i < tmp.len() && tmp[i] == hi {
                hi += 1;
                i += 1;
            }
            // Skip what the token already matches properly.
            if !(lo..hi).all(|id| spec.quality(id) >= Q_PREFIX) {
                spec.ranges.push(Rng { lo, hi, q: Q_FUZZY });
            }
        }
        if spec.ranges.len() > before {
            spec.pure = spec.pure && before > 0;
            true
        } else {
            false
        }
    }

    #[inline]
    fn npost(&self, lo: u32, hi: u32) -> &[u32] {
        &self.npost[self.npost_off[lo as usize] as usize..self.npost_off[hi as usize] as usize]
    }

    #[inline]
    fn lpost(&self, lo: u32, hi: u32) -> &[u32] {
        &self.lpost[self.lpost_off[lo as usize] as usize..self.lpost_off[hi as usize] as usize]
    }

    fn counts(&self, spec: &Spec) -> (usize, usize) {
        let (mut n, mut l) = (0, 0);
        for r in &spec.ranges {
            n += self.npost(r.lo, r.hi).len();
            l += self.lpost(r.lo, r.hi).len();
        }
        (n, l)
    }

    fn heavy_list(&self, p: &[u8]) -> Option<&[u32]> {
        if p.len() > HEAVY_MAX_LEN {
            return None;
        }
        let n = self.heavy_keys.len();
        let i = bsearch(0, n, |i| self.heavy_keys.get(i) < p);
        (i < n && self.heavy_keys.get(i) == p).then(|| &self.heavy[self.heavy_off[i] as usize..self.heavy_off[i + 1] as usize])
    }

    // -----------------------------------------------------------------------
    // Candidates → scored documents
    // -----------------------------------------------------------------------

    /// Score every document matching the tokens `sel` of `specs` into `out`.
    fn run(&self, specs: &[Spec], sel: &[u8], streets_only: bool, near: Option<&Near>, cand: &mut Vec<u32>, out: &mut Vec<Res>) {
        let m = sel.len();
        if m == 0 {
            return;
        }
        let mut driver = 0;
        let mut driver_n = usize::MAX;
        let mut name_n = 0;
        for (i, &s) in sel.iter().enumerate() {
            let (n, l) = self.counts(&specs[s as usize]);
            if n + l == 0 {
                return;
            }
            if n + l < driver_n {
                driver_n = n + l;
                driver = i;
                name_n = n;
            }
        }
        let spec = &specs[sel[driver] as usize];
        cand.clear();
        let truncated;
        // One word alone means a name, unless it hardly exists as one ("3011").
        let name_only = m == 1 && name_n >= 200;
        let need_name = streets_only || name_only;
        let street = |d: &u32| self.kind[*d as usize] == KIND_STREET;

        if m == 1 && name_n > HEAVY_MIN && !streets_only {
            // A frequent prefix: its precomputed top list, plus the best
            // documents spelled exactly like the token.
            truncated = true;
            let mut rest = 0;
            if let Some(list) = spec.pure.then(|| self.heavy_list(self.vocab_prefix_of(spec))).flatten() {
                cand.extend_from_slice(list);
                rest = 1;
            }
            if spec.exact != NONE {
                let list = self.npost(spec.exact, spec.exact + 1);
                cand.extend(list.iter().take(HEAVY_TOP).map(|&d| d & POST_MASK));
                // Documents whose whole name is the token, further down the list.
                cand.extend(list.iter().take(40_000).skip(HEAVY_TOP).filter(|&&d| d & SOLE != 0).take(HEAVY_TOP / 2).map(|&d| d & POST_MASK));
            }
            for r in &spec.ranges[rest..] {
                let list = self.npost(r.lo, r.hi);
                if r.hi - r.lo == 1 {
                    cand.extend(list.iter().take(HEAVY_TOP).map(|&d| d & POST_MASK));
                } else {
                    let at = cand.len();
                    cand.extend(list.iter().map(|&d| d & POST_MASK));
                    if cand.len() - at > HEAVY_TOP * 4 {
                        cand[at..].select_nth_unstable(HEAVY_TOP * 4);
                        cand.truncate(at + HEAVY_TOP * 4);
                    }
                }
            }
        } else {
            for r in &spec.ranges {
                cand.extend(self.npost(r.lo, r.hi).iter().map(|&d| d & POST_MASK));
                if !name_only {
                    cand.extend_from_slice(self.lpost(r.lo, r.hi));
                }
            }
            if streets_only {
                cand.retain(street);
            }
            truncated = keep_smallest(cand, BUDGET);
        }
        cand.sort_unstable();
        cand.dedup();

        for &d in cand.iter() {
            if streets_only && self.kind[d as usize] != KIND_STREET {
                continue;
            }
            if let Some(score) = self.score_doc(d, specs, sel, near, need_name) {
                out.push(Res { score, id: d, house: false });
            }
        }

        // The cut kept the most prominent matches; add the closest ones.
        if let (true, Some(nr)) = (truncated, near) {
            let (cx, cy) = self.dgrid.xy(LatLon { lat: nr.lat, lon: nr.lon });
            let mut budget = LOCAL_BUDGET;
            let mut found = 0;
            for r in 0..=8i32 {
                let mut visit = |x: i32, y: i32| {
                    for &d in self.dgrid.cell(x, y) {
                        if streets_only && self.kind[d as usize] != KIND_STREET {
                            continue;
                        }
                        budget -= 1;
                        if cand.binary_search(&d).is_ok() {
                            continue;
                        }
                        if let Some(score) = self.score_doc(d, specs, sel, near, need_name) {
                            out.push(Res { score, id: d, house: false });
                            found += 1;
                        }
                    }
                };
                if r == 0 {
                    visit(cx, cy);
                } else {
                    for dx in -r..=r {
                        visit(cx + dx, cy - r);
                        visit(cx + dx, cy + r);
                    }
                    for dy in -r + 1..r {
                        visit(cx - r, cy + dy);
                        visit(cx + r, cy + dy);
                    }
                }
                if budget <= 0 || (r >= 2 && found >= 30) {
                    break;
                }
            }
        }
    }

    /// The spelling of a pure spec's prefix (any term in its range starts with it).
    fn vocab_prefix_of(&self, spec: &Spec) -> &[u8] {
        let r = spec.ranges[0];
        let a = self.vocab.get(r.lo as usize);
        let b = self.vocab.get(r.hi as usize - 1);
        let n = a.iter().zip(b.iter()).take_while(|(x, y)| x == y).count();
        &a[..n]
    }

    /// Does document `d` match all tokens, and how well?
    fn score_doc(&self, d: u32, specs: &[Spec], sel: &[u8], near: Option<&Near>, need_name: bool) -> Option<f32> {
        let di = d as usize;
        let f = &self.fwd[self.fwd_off[di] as usize..self.fwd_off[di + 1] as usize];
        let n_name = f.iter().take_while(|&&e| e >> CLS_SHIFT == CLS_NAME).count();
        let n_alt = f[n_name..].iter().take_while(|&&e| e >> CLS_SHIFT == CLS_ALT).count();
        let (name, rest) = f.split_at(n_name);
        let (alt, loc) = rest.split_at(n_alt);
        let m = sel.len();

        // Give every query token its own name token where possible.
        let mut used = 0u32;
        let mut qual = [0u8; MAX_Q];
        let mut wher = [0u8; MAX_Q]; // 1 name, 2 alternative name, 3 locality
        let mut at = [0u8; MAX_Q];
        let mut shared = false;
        let mut plain_alt = false;
        for (i, &si) in sel.iter().enumerate() {
            let sp = &specs[si as usize];
            let (mut bq, mut bj) = (0u8, 0usize);
            for (j, &e) in name.iter().enumerate() {
                if (used >> j) & 1 == 1 {
                    continue;
                }
                let q = sp.quality(e & ID_MASK);
                if q > bq {
                    bq = q;
                    bj = j;
                    if q == Q_EXACT {
                        break;
                    }
                }
            }
            if bq > 0 {
                used |= 1 << bj;
                qual[i] = bq;
                wher[i] = 1;
                at[i] = bj as u8;
                continue;
            }
            for &e in alt {
                let q = sp.quality(e & ID_MASK);
                // A category keyword must be typed (nearly) in full: "b" is not "bahnhof".
                if e & MINOR != 0 && q < Q_ALIAS && (q < Q_PREFIX || sp.len < KEYWORD_MIN_PREFIX) {
                    continue;
                }
                if q > bq {
                    bq = q;
                    bj = (e & MINOR == 0) as usize;
                }
            }
            if bq > 0 {
                qual[i] = bq;
                wher[i] = 2;
                plain_alt |= bj == 1;
                continue;
            }
            for &e in loc {
                bq = bq.max(sp.quality(e & ID_MASK));
            }
            if bq > 0 {
                qual[i] = bq;
                wher[i] = 3;
                continue;
            }
            // Last resort: share a name token another query token already took.
            for (j, &e) in name.iter().enumerate() {
                let q = sp.quality(e & ID_MASK);
                if q > bq {
                    bq = q;
                    bj = j;
                }
            }
            if bq == 0 {
                return None;
            }
            qual[i] = bq;
            wher[i] = 1;
            at[i] = bj as u8;
            shared = true;
        }

        let in_name = wher[..m].iter().filter(|&&w| w == 1).count();
        let in_alt = wher[..m].iter().filter(|&&w| w == 2).count();
        let in_loc = m - in_name - in_alt;
        if need_name && in_name + in_alt == 0 {
            return None;
        }
        let covered = used.count_ones() as usize;
        let name_exact = (0..m).all(|i| wher[i] != 1 || qual[i] >= Q_ALIAS);
        let in_order = (0..m).all(|i| wher[i] == 1 && at[i] as usize == i);
        let sub = if self.kind[di] == KIND_STATION { self.cat[di] as usize } else { 0 };
        let class = if self.kind[di] == KIND_POI { (self.cat[di] >> 12) as u8 } else { 0 };
        let locality = class == CLASS_PLACE_MAJOR || class == CLASS_PLACE_MINOR;
        // Words of the name that mean something, and how many of them were typed.
        let (mut sig, mut sig_cov) = (0usize, 0usize);
        for (j, &e) in name.iter().enumerate() {
            if e & MINOR == 0 {
                sig += 1;
                sig_cov += ((used >> j) & 1) as usize;
            }
        }

        let bonus = if shared {
            B_IN_NAME - P_SHARED
        } else if in_name == m {
            if covered == n_name && name_exact {
                B_FULL - if locality { P_LOCALITY_FULL } else { 0.0 }
            } else {
                let base = if in_order {
                    B_PREFIX + if covered == n_name { 5.0 } else { 0.0 }
                } else if sub > 0 && name_exact && covered == n_name - sub && used == (((1u32 << n_name) - 1) & !((1u32 << sub) - 1)) {
                    B_SUB_FULL
                } else if sub > 0 && (0..m).all(|i| at[i] as usize == sub + i) {
                    B_SUB_PREFIX
                } else if covered == n_name {
                    B_ALL_COVERED
                } else {
                    B_IN_NAME
                };
                // "paul klee" is most of "Zentrum Paul Klee": the more of the
                // name is typed, the closer to a full match.
                let frac = if sig > 0 && sig_cov < sig { sig_cov as f32 / sig as f32 } else { 0.0 };
                base.max(B_IN_NAME + 30.0 * frac * frac)
            }
        } else if in_name > 0 {
            let name_full = covered == n_name && name_exact;
            if in_alt == 0 && name_full {
                B_FULL_LOC
            } else if in_loc == 0 && name_full && (0..m).all(|i| qual[i] >= Q_ALIAS) {
                B_FULL_ALT
            } else if in_loc == 0 {
                B_NAME_AND_ALT
            } else if in_alt == 0 && {
                let mut k = 0;
                (0..m).all(|i| {
                    wher[i] != 1 || {
                        k += 1;
                        at[i] as usize == k - 1
                    }
                })
            } {
                B_PREFIX_LOC
            } else {
                B_NAME_AND_LOC
            }
        } else if in_alt > 0 {
            if in_loc > 0 {
                B_ALT_AND_LOC
            } else if !plain_alt {
                B_KEYWORD
            } else if (0..m).all(|i| qual[i] >= Q_ALIAS) {
                B_ALT_EXACT
            } else {
                B_ALT
            }
        } else {
            B_LOC_ONLY
        };

        let mut s = self.stat[di] as f32 * 0.5 + bonus;
        if in_name > 0 {
            s -= (P_UNCOVERED * (sig - sig_cov.min(sig)) as f32).min(6.0);
        }
        for (i, &si) in sel.iter().enumerate() {
            let last = specs[si as usize].last;
            match qual[i] {
                Q_FUZZY => s -= P_FUZZY,
                Q_PREFIX if !last => s -= P_MID_PREFIX,
                Q_ALIAS => s -= P_ALIAS,
                Q_EXACT if last => s += B_LAST_EXACT,
                _ => {}
            }
        }
        if let Some(nr) = near {
            s += nr.boost(self.lat[di], self.lon[di]);
        }
        Some(s)
    }

    /// House numbers inside the matched `streets`.
    fn houses(&self, num: &str, num_is_last: bool, near: Option<&Near>, streets: &mut Vec<Res>, out: &mut Vec<Res>) {
        let n_int = text::leading_int(num);
        if n_int == u32::MAX || streets.is_empty() {
            return;
        }
        const TOP: usize = 40;
        if streets.len() > TOP {
            streets.select_nth_unstable_by(TOP, |a, b| b.score.total_cmp(&a.score));
            streets.truncate(TOP);
        }
        let pure_digits = num.bytes().all(|b| b.is_ascii_digit());
        // House-number ids are ordered by leading integer.
        let ids_of = |lo: u32, hi: u32| -> (u32, u32) { (self.hn_int.partition_point(|&x| x < lo) as u32, self.hn_int.partition_point(|&x| x <= hi) as u32) };
        let same = ids_of(n_int, n_int);
        let mut any_exact = false;
        for st in streets.iter_mut() {
            let di = st.id as usize;
            let s = self.ext[di] as usize;
            let (a, b) = (self.house_off[s] as usize, self.house_off[s + 1] as usize);
            let hs = &self.h_hn[a..b];
            let base = st.score - near.map_or(0.0, |n| n.boost(self.lat[di], self.lon[di]));
            let mut push = |h: usize, bonus: f32| {
                let prox = near.map_or(0.0, |n| n.boost(self.h_lat[h], self.h_lon[h]));
                out.push(Res { score: base + bonus + prox, id: h as u32, house: true });
            };
            let mut exact = false;
            let mut extra = 0.0f32;
            let i0 = hs.partition_point(|&x| x < same.0);
            for (k, &hn) in hs[i0..].iter().enumerate() {
                if hn >= same.1 {
                    break;
                }
                let key = self.hn_key.get(hn as usize);
                if key == num.as_bytes() {
                    exact = true;
                    push(a + i0 + k, B_HOUSE);
                } else if key.starts_with(num.as_bytes()) && extra < 4.0 {
                    // "3" also offers 3a, 3b …; "12" offers "12-14".
                    extra += 0.5;
                    push(a + i0 + k, B_HOUSE_PARTIAL - extra);
                } else if !pure_digits && key.iter().all(|c| c.is_ascii_digit()) {
                    // "3c" asked, only "3" exists.
                    push(a + i0 + k, B_HOUSE_PREFIX);
                }
            }
            if num_is_last && pure_digits {
                // Still typing: 3 → 30…39, 300…399.
                let mut mult = 10u32;
                let mut shown = 0.0f32;
                while mult <= 1000 && n_int < 10_000 && shown < 3.0 {
                    let r = ids_of(n_int * mult, n_int * mult + mult - 1);
                    let j0 = hs.partition_point(|&x| x < r.0);
                    for (k, &hn) in hs[j0..].iter().enumerate() {
                        if hn >= r.1 || shown >= 3.0 {
                            break;
                        }
                        shown += 0.5;
                        push(a + j0 + k, B_HOUSE_PREFIX - shown);
                    }
                    mult *= 10;
                }
            }
            st.house = exact;
            any_exact |= exact;
        }
        // No such number anywhere (yet): offer the streets themselves — unless
        // the "number" has four digits and is far more likely a postcode.
        if !any_exact && num.len() < 4 {
            for st in streets.iter().filter(|s| !s.house) {
                out.push(Res { score: st.score - 6.0, id: st.id, house: false });
            }
        }
    }

    // -----------------------------------------------------------------------
    // Results
    // -----------------------------------------------------------------------

    fn loc_parts(&self, loc: u32) -> (&str, &str) {
        if loc == NONE || loc as usize >= self.locs.len() {
            return ("", "");
        }
        let s = self.locs.str(loc as usize);
        s.split_once('\x1f').unwrap_or((s, ""))
    }

    /// "3011 Bern"
    fn loc_label(&self, loc: u32) -> String {
        let (pc, city) = self.loc_parts(loc);
        match (pc.is_empty(), city.is_empty()) {
            (false, false) => format!("{pc} {city}"),
            (true, _) => city.to_string(),
            (_, true) => pc.to_string(),
        }
    }

    fn doc_pos(&self, d: usize) -> LatLon {
        LatLon { lat: self.lat[d], lon: self.lon[d] }
    }

    fn doc_hit(&self, d: u32, score: f32) -> Hit {
        let di = d as usize;
        let full = self.strs.str(di);
        let (name, sub) = full.split_once('\x1f').unwrap_or((full, ""));
        let pos = self.doc_pos(di);
        match self.kind[di] {
            KIND_STATION => {
                let st = self.ext[di];
                Hit {
                    kind: HitKind::Station,
                    id: format!("st:{}", self.st_ids[st as usize]),
                    name: name.to_string(),
                    detail: String::new(),
                    pos,
                    station: Some(st),
                    score,
                    icon: "station".into(),
                    category: String::new(),
                    info: None,
                }
            }
            KIND_POI => {
                let label = self.cats.get((self.cat[di] & 0xfff) as usize).map(|s| s.as_str()).unwrap_or("Place");
                let class = (self.cat[di] >> 12) as u8;
                let (pc, city) = self.loc_parts(self.loc[di]);
                let mut detail = String::with_capacity(label.len() + sub.len() + city.len() + 12);
                detail.push_str(label);
                match class {
                    CLASS_PLACE_MAJOR => {}
                    CLASS_PLACE_MINOR => {
                        // A village is its own locality: show the postcode. A quarter shows its town.
                        let own = kante_core::text::normalize(city) == kante_core::text::normalize(name);
                        let tail = if own { pc.to_string() } else { self.loc_label(self.loc[di]) };
                        if !tail.is_empty() {
                            detail.push_str(" · ");
                            detail.push_str(&tail);
                        }
                    }
                    CLASS_NATURE => {
                        if !city.is_empty() {
                            detail.push_str(" · ");
                            detail.push_str(city);
                        }
                    }
                    _ => {
                        if !sub.is_empty() || !city.is_empty() {
                            detail.push_str(" · ");
                            detail.push_str(sub);
                            if !sub.is_empty() && !city.is_empty() {
                                detail.push_str(", ");
                            }
                            detail.push_str(city);
                        }
                    }
                }
                let rank = self.ext[di] as usize;
                let code = self.poi_code.get(rank).copied().unwrap_or(0);
                let info = if rank < self.poi_info.len() { PoiInfo::decode(self.poi_info.str(rank)).map(Box::new) } else { None };
                Hit {
                    kind: HitKind::Poi,
                    id: format!("poi:{code}"),
                    name: name.to_string(),
                    detail,
                    pos,
                    station: None,
                    score,
                    icon: crate::cats::icon(label, class).into(),
                    category: label.to_string(),
                    info,
                }
            }
            _ => {
                // A street through several postcodes shows only the town.
                let detail = if self.cat[di] == 1 { self.loc_parts(self.loc[di]).1.to_string() } else { self.loc_label(self.loc[di]) };
                Hit {
                    kind: HitKind::Address,
                    id: format!("addr:{}", (self.ext[di] as u64) * 2 + 1),
                    name: name.to_string(),
                    detail,
                    pos,
                    station: None,
                    score,
                    icon: "address".into(),
                    category: String::new(),
                    info: None,
                }
            }
        }
    }

    fn house_hit(&self, h: u32, score: f32) -> Hit {
        let hi = h as usize;
        let street = self.house_off.partition_point(|&o| o <= h) - 1;
        let d = self.street_doc.get(street).copied().unwrap_or(NONE);
        let sname = if d == NONE { "" } else { self.doc_name(d as usize) };
        let hn = self.hn_raw.str(self.h_hn[hi] as usize);
        Hit {
            kind: HitKind::Address,
            id: format!("addr:{}", h as u64 * 2),
            name: format!("{sname} {hn}"),
            detail: self.loc_label(self.h_loc[hi]),
            pos: LatLon { lat: self.h_lat[hi], lon: self.h_lon[hi] },
            station: None,
            score,
            icon: "address".into(),
            category: String::new(),
            info: None,
        }
    }

    /// The hit for an id returned earlier by `search` or `reverse` of this index.
    pub fn resolve(&self, id: &str) -> Option<Hit> {
        if let Some(g) = id.strip_prefix("st:") {
            let i = self.st_sorted.binary_search_by(|&s| self.st_ids[s as usize].as_str().cmp(g)).ok()?;
            let d = self.st_doc[self.st_sorted[i] as usize];
            return (d != NONE).then(|| self.doc_hit(d, self.stat[d as usize] as f32 * 0.5));
        }
        if let Some(n) = id.strip_prefix("poi:") {
            let code: u64 = n.parse().ok()?;
            let i = self.poi_code.binary_search(&code).ok()?;
            let d = self.poi_doc[i];
            return Some(self.doc_hit(d, self.stat[d as usize] as f32 * 0.5));
        }
        let n: u64 = id.strip_prefix("addr:")?.parse().ok()?;
        if n & 1 == 1 {
            let d = *self.street_doc.get((n >> 1) as usize)?;
            (d != NONE).then(|| self.doc_hit(d, self.stat[d as usize] as f32 * 0.5))
        } else {
            let h = n >> 1;
            (h < self.h_lat.len() as u64).then(|| {
                let street = self.house_off.partition_point(|&o| o as u64 <= h) - 1;
                let d = self.street_doc.get(street).copied().unwrap_or(NONE);
                self.house_hit(h as u32, if d == NONE { 0.0 } else { self.stat[d as usize] as f32 * 0.5 })
            })
        }
    }

    /// Nearest address / place name for a coordinate ("Bundesgasse 3", "3003 Bern"):
    /// the nearest house within 60 m, else the nearest named street within
    /// 150 m, else the nearest place within a few kilometres. `Hit::score` is
    /// the distance in metres.
    pub fn reverse(&self, pos: LatLon) -> Option<Hit> {
        if pos.is_none() {
            return None;
        }
        let nr = Near::new(pos);
        let n_houses = self.h_lat.len() as u32;
        let (cx, cy) = self.fine.xy(pos);
        let mut house = (60.0f32, NONE);
        let mut street = (150.0f32, NONE);
        for dy in -1..=1 {
            for dx in -1..=1 {
                for &it in self.fine.cell(cx + dx, cy + dy) {
                    if it < n_houses {
                        let d = nr.dist(self.h_lat[it as usize], self.h_lon[it as usize]);
                        if d < house.0 {
                            house = (d, it);
                        }
                    } else {
                        let i = (it - n_houses) as usize;
                        let d = nr.dist(self.sp_lat[i], self.sp_lon[i]);
                        if d < street.0 {
                            street = (d, self.sp_street[i]);
                        }
                    }
                }
            }
        }
        if house.1 != NONE {
            return Some(self.house_hit(house.1, house.0));
        }
        if street.1 != NONE {
            let d = self.street_doc[street.1 as usize];
            if d != NONE {
                let mut h = self.doc_hit(d, street.0);
                h.pos = pos;
                return Some(h);
            }
        }
        // Open country: the nearest named place, localities preferred.
        let (cx, cy) = self.dgrid.xy(pos);
        let mut best = (f32::MAX, NONE);
        for r in 0..=10i32 {
            let mut visit = |x: i32, y: i32| {
                for &d in self.dgrid.cell(x, y) {
                    let di = d as usize;
                    if self.kind[di] != KIND_POI {
                        continue;
                    }
                    let class = (self.cat[di] >> 12) as u8;
                    let dist = nr.dist(self.lat[di], self.lon[di]);
                    // A named locality 800 m away says more than a bench-level POI 300 m away.
                    let eff = if class == CLASS_PLACE_MAJOR || class == CLASS_PLACE_MINOR { dist * 0.4 } else { dist };
                    if eff < best.0 {
                        best = (eff, d);
                    }
                }
            };
            if r == 0 {
                visit(cx, cy);
            } else {
                for dx in -r..=r {
                    visit(cx + dx, cy - r);
                    visit(cx + dx, cy + r);
                }
                for dy in -r + 1..r {
                    visit(cx - r, cy + dy);
                    visit(cx + r, cy + dy);
                }
            }
            // Everything in the next ring is at least r cells (≈ 500 m each) away.
            if best.1 != NONE && best.0 < r as f32 * 450.0 * 0.4 {
                break;
            }
        }
        (best.1 != NONE).then(|| {
            let di = best.1 as usize;
            self.doc_hit(best.1, nr.dist(self.lat[di], self.lon[di]))
        })
    }
}
