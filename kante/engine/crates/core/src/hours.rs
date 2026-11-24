//! When a way is closed: a small reader of OpenStreetMap's `opening_hours=*` and of `access:conditional` /
//! `foot:conditional` (`no @ (22:00-06:00)`), for route choice only (`kante/docs/WALK-ENDS.md`, "Opening hours").
//!
//! Only what can be read with certainty is read: `24/7`; months and month-day ranges (`Nov-May`, `Dec 21-Mar 31`);
//! weekdays (`Mo-Fr`, `Sa,Su`); times (`08:00-12:00,13:00-18:00`, overnight `22:00-02:00`, `24:00`); `off` /
//! `closed`; rules separated by `;` (a later rule replaces the earlier ones for the days it names) or by `,` after a
//! time (it adds to them). Anything else (public or school holidays in an open rule, sunrise, week numbers, comments,
//! `+`, `winter`) makes the whole value unreadable, and an unreadable value is open: a way is only ever avoided when
//! its hours clearly exclude the time.

use serde::{Deserialize, Serialize};

/// A local (Europe/Zurich) moment, as the hours read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct WalkTime {
    /// 1 = January.
    pub month: u8,
    /// Day of the month, 1-31.
    pub mday: u8,
    /// 0 = Monday … 6 = Sunday.
    pub wday: u8,
    /// Minutes since midnight, 0-1439.
    pub minute: u16,
}

impl WalkTime {
    /// The local time in Switzerland of a Unix time (seconds).
    pub fn from_unix(t: i64) -> WalkTime {
        use chrono::{Datelike, TimeZone, Timelike};
        let dt = chrono_tz::Europe::Zurich.timestamp_opt(t, 0).single().unwrap_or_else(|| chrono_tz::Europe::Zurich.timestamp_opt(0, 0).unwrap());
        WalkTime { month: dt.month() as u8, mday: dt.day() as u8, wday: dt.weekday().num_days_from_monday() as u8, minute: (dt.hour() * 60 + dt.minute()) as u16 }
    }
    /// The same minute a day earlier (month lengths of a non-leap year; only used for times running past midnight).
    fn day_before(self) -> WalkTime {
        const LEN: [u8; 13] = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        let (month, mday) = if self.mday > 1 {
            (self.month, self.mday - 1)
        } else {
            let m = if self.month == 1 { 12 } else { self.month - 1 };
            (m, LEN[m as usize])
        };
        WalkTime { month, mday, wday: (self.wday + 6) % 7, minute: self.minute }
    }
    fn ordinal(self) -> u16 {
        self.month as u16 * 32 + self.mday as u16
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
struct Rule {
    /// Date ranges as `month * 32 + day`, inclusive, possibly wrapping over the new year; empty = every day.
    dates: Vec<(u16, u16)>,
    /// Bit `d` (0 = Monday); 0 = every day.
    wdays: u8,
    /// Minutes from midnight; `end` may pass 1440 (into the next day).
    times: Vec<(u16, u16)>,
    off: bool,
    /// Added to the rules before it (after a `,`) rather than replacing them.
    additional: bool,
}

impl Rule {
    fn on(&self, t: WalkTime) -> bool {
        let o = t.ordinal();
        (self.wdays == 0 || self.wdays & (1 << t.wday) != 0)
            && (self.dates.is_empty() || self.dates.iter().any(|&(a, b)| if a <= b { o >= a && o <= b } else { o >= a || o <= b }))
    }
}

/// A readable `opening_hours` value or a closing condition.
#[derive(Clone, Debug, PartialEq)]
pub struct Hours {
    rules: Vec<Rule>,
    /// `*:conditional=no @ (…)`: closed while the condition holds (else: open while it holds).
    closed_when: bool,
}

impl Hours {
    /// Whether the rules hold (open hours: open; a condition: it applies) at `t`.
    fn holds(&self, t: WalkTime) -> bool {
        if self.rules.is_empty() {
            return true; // 24/7
        }
        let ranges = |d: WalkTime| -> Option<Vec<(u16, u16)>> {
            let mut cur: Option<Vec<(u16, u16)>> = None;
            for r in &self.rules {
                if !r.on(d) {
                    continue;
                }
                let add: Vec<(u16, u16)> = if r.off { Vec::new() } else if r.times.is_empty() { vec![(0, 1440)] } else { r.times.clone() };
                match (&mut cur, r.additional, r.off) {
                    (Some(c), true, false) => c.extend(add),
                    _ => cur = Some(add),
                }
            }
            cur
        };
        let m = t.minute;
        if ranges(t).is_some_and(|v| v.iter().any(|&(a, b)| m >= a && m < b)) {
            return true;
        }
        // times of the day before that run past midnight
        ranges(t.day_before()).is_some_and(|v| v.iter().any(|&(a, b)| b > 1440 && m + 1440 >= a.max(1440) && m + 1440 < b))
    }
    /// Is the way closed at `t`?
    pub fn closed_at(&self, t: WalkTime) -> bool {
        self.holds(t) == self.closed_when
    }
}

const MONTHS: [&str; 12] = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAYS: [&str; 7] = ["mo", "tu", "we", "th", "fr", "sa", "su"];

struct P<'a> {
    s: &'a [u8],
    i: usize,
}

impl<'a> P<'a> {
    fn ws(&mut self) {
        while self.i < self.s.len() && self.s[self.i] == b' ' {
            self.i += 1;
        }
    }
    fn eof(&mut self) -> bool {
        self.ws();
        self.i >= self.s.len()
    }
    fn peek(&mut self) -> u8 {
        self.ws();
        self.s.get(self.i).copied().unwrap_or(0)
    }
    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == c {
            self.i += 1;
            true
        } else {
            false
        }
    }
    fn word(&mut self) -> Option<String> {
        self.ws();
        let st = self.i;
        while self.i < self.s.len() && self.s[self.i].is_ascii_alphabetic() {
            self.i += 1;
        }
        (self.i > st).then(|| String::from_utf8_lossy(&self.s[st..self.i]).to_ascii_lowercase())
    }
    fn num(&mut self) -> Option<u16> {
        self.ws();
        let st = self.i;
        while self.i < self.s.len() && self.s[self.i].is_ascii_digit() {
            self.i += 1;
        }
        if self.i == st || self.i - st > 2 {
            self.i = st;
            return None;
        }
        std::str::from_utf8(&self.s[st..self.i]).ok()?.parse().ok()
    }
    fn peek_word(&mut self) -> Option<String> {
        let save = self.i;
        let w = self.word();
        self.i = save;
        w
    }
    fn peek_month(&mut self) -> bool {
        self.peek_word().is_some_and(|w| MONTHS.contains(&w.as_str()))
    }
    fn peek_day(&mut self) -> bool {
        self.peek_word().is_some_and(|w| DAYS.contains(&w.as_str()) || w == "ph" || w == "sh")
    }
    fn peek_time(&mut self) -> bool {
        self.ws();
        let r = &self.s[self.i.min(self.s.len())..];
        r.len() >= 4 && r[0].is_ascii_digit() && (r[1] == b':' || (r[1].is_ascii_digit() && r.get(2) == Some(&b':')))
    }
    fn time(&mut self) -> Option<u16> {
        let h = self.num()?;
        if !self.eat(b':') {
            return None;
        }
        let m = self.num()?;
        (h <= 24 && m < 60 && h * 60 + m <= 1440).then_some(h * 60 + m)
    }
    /// `Mon [day]`, as `month * 32 + day` (day 0: the month as a whole).
    fn month_day(&mut self) -> Option<(u16, u16)> {
        let w = self.word()?;
        let m = MONTHS.iter().position(|&x| x == w)? as u16 + 1;
        let save = self.i;
        match self.num() {
            Some(d) if (1..=31).contains(&d) && !self.peek_colon() => Some((m, d)),
            Some(_) => {
                self.i = save;
                Some((m, 0))
            }
            None => Some((m, 0)),
        }
    }
    fn peek_colon(&mut self) -> bool {
        self.s.get(self.i) == Some(&b':')
    }
}

/// One rule; `None` if it cannot be read. `ph`: the rule names a public or school holiday.
fn rule(p: &mut P, ph: &mut bool) -> Option<Rule> {
    let mut r = Rule::default();
    // dates
    while p.peek_month() {
        let (m0, d0) = p.month_day()?;
        let (m1, d1) = if p.eat(b'-') {
            if p.peek_month() {
                p.month_day()?
            } else {
                // `Dec 21-31`
                let d = p.num()?;
                if d0 == 0 {
                    return None;
                }
                (m0, d)
            }
        } else {
            (m0, d0)
        };
        let a = m0 * 32 + if d0 == 0 { 1 } else { d0 };
        let b = m1 * 32 + if d1 == 0 { 31 } else { d1 };
        r.dates.push((a, b));
        if !p.eat(b',') {
            break;
        }
    }
    // weekdays
    while p.peek_day() {
        let w = p.word()?;
        if w == "ph" || w == "sh" {
            *ph = true;
        } else {
            let d0 = DAYS.iter().position(|&x| x == w)?;
            let d1 = if p.eat(b'-') {
                let w1 = p.word()?;
                DAYS.iter().position(|&x| x == w1)?
            } else {
                d0
            };
            let mut d = d0;
            loop {
                r.wdays |= 1 << d;
                if d == d1 {
                    break;
                }
                d = (d + 1) % 7;
            }
        }
        if !p.eat(b',') {
            break;
        }
        if !p.peek_day() {
            return None;
        }
    }
    if *ph && r.wdays == 0 && r.dates.is_empty() {
        // only a holiday: it says nothing about any day we can tell
        r.wdays = 0x80;
    }
    // times, or off
    if p.peek_time() {
        loop {
            let a = p.time()?;
            if !p.eat(b'-') {
                return None;
            }
            let mut b = p.time()?;
            if b <= a {
                b += 1440;
            }
            r.times.push((a, b));
            let save = p.i;
            if p.eat(b',') && p.peek_time() {
                continue;
            }
            p.i = save;
            break;
        }
    } else if let Some(w) = p.peek_word() {
        if w == "off" || w == "closed" {
            p.word();
            r.off = true;
        }
    }
    Some(r)
}

fn rules(s: &str) -> Option<Vec<Rule>> {
    let s = s.trim();
    if s.is_empty() || s.len() > 400 {
        return None;
    }
    let mut out: Vec<Rule> = Vec::new();
    for part in s.split(';') {
        if part.trim().is_empty() {
            continue;
        }
        if part.trim() == "24/7" {
            out.push(Rule { times: vec![(0, 1440)], ..Rule::default() });
            continue;
        }
        let mut p = P { s: part.as_bytes(), i: 0 };
        let mut additional = false;
        loop {
            let mut ph = false;
            let mut r = rule(&mut p, &mut ph)?;
            if ph && !r.off {
                return None; // open on holidays we cannot tell
            }
            if r == Rule::default() {
                return None; // nothing read
            }
            r.additional = additional;
            if r.wdays != 0x80 {
                out.push(r);
            }
            if p.eof() {
                break;
            }
            if !p.eat(b',') {
                return None;
            }
            additional = true;
        }
    }
    (!out.is_empty()).then_some(out)
}

/// `opening_hours=*`, if it can be read with certainty.
pub fn parse_opening_hours(s: &str) -> Option<Hours> {
    if s.trim() == "24/7" {
        return Some(Hours { rules: Vec::new(), closed_when: false });
    }
    Some(Hours { rules: rules(s)?, closed_when: false })
}

/// `access:conditional` / `foot:conditional`: the conditions under which the way is closed to walkers
/// (`no @ (…)`, `private @ (…)`; other values are ignored), if there is one and every one of them can be read.
pub fn parse_closing_condition(s: &str) -> Option<Hours> {
    let mut all: Vec<Rule> = Vec::new();
    for part in split_conditions(s) {
        let Some((value, cond)) = part.split_once('@') else { return None };
        match value.trim() {
            "no" | "private" => {}
            // opened again to walkers under some condition: what holds when is not certain
            "yes" | "permissive" | "designated" | "official" => return None,
            _ => continue,
        }
        let cond = cond.trim().trim_start_matches('(').trim_end_matches(')');
        let mut r = rules(cond)?;
        // several conditions: closed when any holds (each its own day set, so none replaces another)
        for x in r.iter_mut().skip(usize::from(all.is_empty())) {
            x.additional = true;
        }
        if !all.is_empty() {
            if let Some(f) = r.first_mut() {
                f.additional = true;
            }
        }
        all.extend(r);
    }
    (!all.is_empty()).then_some(Hours { rules: all, closed_when: true })
}

/// `a @ (x; y); b @ z` → [`a @ (x; y)`, `b @ z`]: `;` inside brackets belongs to the condition.
fn split_conditions(s: &str) -> Vec<&str> {
    let (mut out, mut depth, mut start) = (Vec::new(), 0i32, 0usize);
    for (i, c) in s.char_indices() {
        match c {
            '(' => depth += 1,
            ')' => depth -= 1,
            ';' if depth == 0 => {
                out.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    out.push(&s[start..]);
    out.into_iter().filter(|p| !p.trim().is_empty()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn at(month: u8, mday: u8, wday: u8, h: u16, m: u16) -> WalkTime {
        WalkTime { month, mday, wday, minute: h * 60 + m }
    }
    #[test]
    fn plain_hours() {
        let h = parse_opening_hours("Mo-Fr 06:00-22:00; Sa 08:00-20:00").unwrap();
        assert!(!h.closed_at(at(11, 24, 1, 12, 0)));
        assert!(h.closed_at(at(11, 24, 1, 23, 0)));
        assert!(h.closed_at(at(11, 24, 1, 5, 59)));
        assert!(!h.closed_at(at(11, 28, 5, 19, 59)));
        assert!(h.closed_at(at(11, 28, 5, 20, 5)), "to the minute: a 20:00 closing is closed at 20:05");
        assert!(h.closed_at(at(11, 29, 6, 12, 0)), "a day not named is closed");
    }
    #[test]
    fn overnight_and_24_7() {
        let h = parse_opening_hours("Mo-Su 05:00-01:30").unwrap();
        assert!(!h.closed_at(at(3, 3, 1, 0, 45)), "Monday's hours run into Tuesday");
        assert!(h.closed_at(at(3, 3, 1, 2, 0)));
        assert!(!parse_opening_hours("24/7").unwrap().closed_at(at(1, 1, 0, 3, 0)));
        let h = parse_opening_hours("Mo-Fr 8:00-18:00").unwrap();
        assert!(!h.closed_at(at(5, 5, 1, 9, 0)), "an hour of one digit");
        let h = parse_opening_hours("06:00-22:00; Dec 25 off").unwrap();
        assert!(h.closed_at(at(12, 25, 4, 12, 0)));
        assert!(!h.closed_at(at(12, 26, 5, 12, 0)), "a single day is that day only");
        let h = parse_opening_hours("Mo-Fr 08:00-12:00,13:30-18:00").unwrap();
        assert!(h.closed_at(at(5, 5, 1, 12, 30)));
        assert!(!h.closed_at(at(5, 5, 1, 14, 0)));
    }
    #[test]
    fn later_rules_replace_and_additional_add() {
        let h = parse_opening_hours("Mo-Su 06:00-22:00; Su off").unwrap();
        assert!(h.closed_at(at(6, 7, 6, 12, 0)));
        assert!(!h.closed_at(at(6, 6, 5, 12, 0)));
        let h = parse_opening_hours("Mo-Fr 08:00-12:00, Sa 09:00-11:00").unwrap();
        assert!(!h.closed_at(at(6, 6, 5, 10, 0)));
        assert!(h.closed_at(at(6, 7, 6, 10, 0)));
    }
    #[test]
    fn months_and_seasons() {
        let h = parse_opening_hours("May-Oct").unwrap();
        assert!(!h.closed_at(at(7, 1, 2, 3, 0)));
        assert!(h.closed_at(at(12, 1, 2, 12, 0)));
        let h = parse_opening_hours("Apr-Oct 07:00-21:00; Nov-Mar 08:00-17:00").unwrap();
        assert!(h.closed_at(at(1, 10, 2, 18, 0)));
        assert!(!h.closed_at(at(7, 10, 2, 18, 0)));
        let h = parse_opening_hours("Dec 21-Mar 31 off; 06:00-22:00").unwrap();
        // the later rule (every day) replaces the earlier one: open by day all year
        assert!(!h.closed_at(at(1, 5, 0, 12, 0)));
    }
    #[test]
    fn unreadable_is_open() {
        for s in ["sunrise-sunset", "Mo-Fr 08:00-18:00; PH 10:00-12:00", "week 2-17", "\"on request\"", "Mo-Fr 08:00+", "winter", ""] {
            assert!(parse_opening_hours(s).is_none(), "{s}");
        }
        // holidays closed: the rule is left out, the rest stands
        let h = parse_opening_hours("Mo-Fr 08:00-18:00; PH off").unwrap();
        assert!(!h.closed_at(at(12, 25, 4, 12, 0)));
    }
    #[test]
    fn closing_conditions() {
        let c = parse_closing_condition("no @ (22:00-06:00)").unwrap();
        assert!(c.closed_at(at(5, 5, 1, 23, 0)));
        assert!(c.closed_at(at(5, 5, 1, 3, 0)));
        assert!(!c.closed_at(at(5, 5, 1, 12, 0)));
        let c = parse_closing_condition("no @ (Nov-May)").unwrap();
        assert!(c.closed_at(at(1, 5, 1, 12, 0)));
        assert!(!c.closed_at(at(7, 5, 1, 12, 0)));
        let c = parse_closing_condition("no @ (Dec 21-Mar 31); delivery @ (Mo-Fr 06:00-11:00)").unwrap();
        assert!(c.closed_at(at(2, 1, 1, 12, 0)));
        assert!(!c.closed_at(at(4, 2, 1, 12, 0)));
        assert!(parse_closing_condition("permissive @ (Sa,Su,PH 08:00-24:00)").is_none());
        assert!(parse_closing_condition("no @ (Nov-May); yes @ (Sa)").is_none(), "opened again: not certain");
        assert!(parse_closing_condition("no @ winter").is_none());
    }
}
