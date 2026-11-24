//! `GET /api/identify`: which trip is the vehicle a camera sees?
//!
//! The camera gives what it could read (line number, destination text) and where
//! and when it was, optionally the direction the vehicle drives in. The answer is
//! chosen among the vehicles that can actually be there at that moment: those due
//! at the stops around (`/api/due`) and those under way nearby (`/api/vehicles`).
//! Each candidate is scored on the evidence there is; only a clear winner is a
//! match, else the answer is `ambiguous` (with the candidates) or `none`. The
//! score is a ranking, not a calibrated probability.

use crate::json;
use crate::liveapi::{self, DueQuery, Run};
use crate::state::App;
use kante_core::geo::{BBox, LatLon};
use kante_core::*;
use std::collections::HashMap;

/// A winner needs at least this score …
pub const MATCH_MIN: f32 = 0.6;
/// … and this much more than the runner-up.
pub const MATCH_MARGIN: f32 = 0.15;
/// A destination read that fits a candidate worse than this speaks against it.
pub const TEXT_AGAINST: f32 = 0.45;

pub struct IdentifyQuery {
    pub pos: LatLon,
    pub t: i64,
    pub line: String,
    pub headsign: String,
    /// Direction the vehicle drives in, degrees from north.
    pub bearing: Option<f32>,
    /// How far from `pos` the vehicle can be, metres.
    pub radius: f32,
    /// Only these boarding points (from `quay=`), else the stops within `radius`.
    pub stops: Option<Vec<StopIdx>>,
}

// ------------------------------------------------------------------ evidence (pure)

/// What a display line reading says about a candidate's line.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineEvidence {
    Exact,
    /// Equal once letters a display or OCR often confuses with digits are mapped (O/0, I/1, S/5, B/8, Z/2, G/6).
    Confusable,
    Unseen,
    Contradicted,
}

fn alnum(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(|c| c.to_lowercase()).collect()
}

fn confusion_key(s: &str) -> String {
    alnum(s)
        .chars()
        .map(|c| match c {
            'o' => '0',
            'i' | 'l' => '1',
            's' => '5',
            'b' => '8',
            'z' => '2',
            'g' => '6',
            c => c,
        })
        .collect()
}

/// `read` is what the display showed ("10", "S1", "IC 8", "EV"); `name`/`category` the candidate's line.
pub fn line_evidence(read: &str, name: &str, category: &str) -> LineEvidence {
    let r = alnum(read);
    if r.is_empty() {
        return LineEvidence::Unseen;
    }
    let forms = [alnum(name), alnum(&format!("{category}{name}"))];
    if forms.iter().any(|f| !f.is_empty() && *f == r) {
        return LineEvidence::Exact;
    }
    // A display often shows only the number of "S 1" or "IC 8".
    if r.chars().all(|c| c.is_ascii_digit()) && forms.iter().any(|f| f.trim_start_matches(|c: char| c.is_alphabetic()) == r) {
        return LineEvidence::Exact;
    }
    let rk = confusion_key(read);
    if forms.iter().any(|f| !f.is_empty() && confusion_key(f) == rk) {
        return LineEvidence::Confusable;
    }
    LineEvidence::Contradicted
}

/// Lower case, accents folded, and the digits a display or OCR puts for letters read as those letters.
fn fold(w: &str) -> String {
    w.to_lowercase()
        .chars()
        .map(|c| match c {
            'ä' | 'à' | 'â' | 'á' => 'a',
            'ö' | 'ô' | 'ó' | '0' => 'o',
            'ü' | 'ù' | 'û' | 'ú' => 'u',
            'é' | 'è' | 'ê' | 'ë' => 'e',
            'ï' | 'î' | 'í' | '1' => 'i',
            'ç' => 'c',
            '5' => 's',
            '8' => 'b',
            c => c,
        })
        .collect()
}

fn words(s: &str) -> Vec<String> {
    s.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(fold).collect()
}

/// Similarity of two strings, 0…1 (1 − normalised edit distance).
fn similar(a: &str, b: &str) -> f32 {
    let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut cur = vec![i + 1; b.len() + 1];
        for (j, cb) in b.iter().enumerate() {
            cur[j + 1] = (prev[j] + (ca != cb) as usize).min(prev[j + 1] + 1).min(cur[j] + 1);
        }
        prev = cur;
    }
    1.0 - prev[b.len()] as f32 / a.len().max(b.len()) as f32
}

/// How well the destination text read on a display fits a destination (or a via):
/// each word read is matched to its most similar word of the name, and the name's
/// own words that the reading covers count too ("Ostermundigen Rüti" ↔ "Ostermundigen, Rüti";
/// "Bern" alone fits "Bern, Bahnhof" only partly).
pub fn text_fit(read: &str, name: &str) -> f32 {
    let (r, n) = (words(read), words(name));
    if r.is_empty() || n.is_empty() {
        return 0.0;
    }
    let best = |w: &String, among: &[String]| among.iter().map(|x| similar(w, x)).fold(0.0f32, f32::max);
    let read_fit = r.iter().map(|w| best(w, &n)).sum::<f32>() / r.len() as f32;
    let name_cover = n.iter().map(|w| best(w, &r)).filter(|&s| s >= 0.75).count() as f32 / n.len() as f32;
    0.7 * read_fit + 0.3 * name_cover
}

/// Smallest angle between two bearings, degrees.
pub fn angle_diff(a: f32, b: f32) -> f32 {
    let d = (a - b).rem_euclid(360.0);
    if d > 180.0 {
        360.0 - d
    } else {
        d
    }
}

/// The evidence one candidate has, and its score.
#[derive(Clone, Debug)]
pub struct Evidence {
    pub line: LineEvidence,
    /// Best fit of the read destination text to the headsign or a via; None when no text was read.
    pub text: Option<f32>,
    pub distance_m: f32,
    /// Seconds from the moment asked about to when the vehicle is at the nearest point (0 when it is there).
    pub time_off_s: i64,
    pub bearing_diff: Option<f32>,
}

impl Evidence {
    /// None: ruled out (another line read, or driving the other way).
    pub fn score(&self, radius: f32) -> Option<f32> {
        if self.line == LineEvidence::Contradicted || self.bearing_diff.is_some_and(|d| d > 120.0) {
            return None;
        }
        // A destination was read and it is not this one: listed, never a match.
        let text_against = self.text.is_some_and(|t| t < TEXT_AGAINST);
        let line = match self.line {
            LineEvidence::Exact => 1.0,
            LineEvidence::Confusable => 0.75,
            _ => 0.35,
        };
        let text = self.text.map(|t| ((t - 0.3) / 0.6).clamp(0.0, 1.0)).unwrap_or(0.35);
        let place = (-(self.distance_m / radius.max(50.0))).exp() * (-(self.time_off_s.abs() as f32) / 120.0).exp();
        let bearing = self.bearing_diff.map(|d| 1.0 - (d / 120.0).clamp(0.0, 1.0)).unwrap_or(0.5);
        let s = 0.35 * line + 0.3 * text + 0.25 * place + 0.1 * bearing;
        Some(if text_against { s.min(MATCH_MIN - 0.05) } else { s })
    }
}

/// Whether a vehicle under way `d` metres from the camera is a candidate: only within the
/// radius asked for, and never when the question is about a named boarding point.
pub fn admit_moving(d: f32, radius: f32, quay_named: bool) -> bool {
    !quay_named && d <= radius
}

// ------------------------------------------------------------------ candidates

struct Cand {
    trip_id: String,
    service_date: String,
    line: json::LineBadge,
    headsign: String,
    vias: Vec<String>,
    /// The call the vehicle is at or heading for.
    seq: u16,
    quay_id: Option<String>,
    ev: Evidence,
    live_info: json::LiveInfo,
    extra: bool,
    cancelled: bool,
}

fn text_of(read: &str, headsign: &str, vias: &[String]) -> Option<f32> {
    if words(read).is_empty() {
        return None;
    }
    Some(std::iter::once(headsign).chain(vias.iter().map(String::as_str)).map(|n| text_fit(read, n)).fold(0.0f32, f32::max))
}

fn run_of(app: &App, live: Option<&dyn LiveView>, trip_id: &str, date: &str) -> Option<Run> {
    let date = time::parse_date(date)?;
    if trip_id.starts_with("extra:") {
        return live.and_then(|l| l.extra(trip_id)).map(Run::of_extra);
    }
    let trip = app.router.find_trip(trip_id)?;
    Some(Run::of_trip(app, trip, date, live.and_then(|l| l.trip(date, trip))))
}

pub fn identify(app: &App, q: &IdentifyQuery) -> json::IdentifyResponse {
    let tt = &app.tt;
    let live_arc = app.live_view();
    let live = live_arc.as_deref();
    let mut cands: HashMap<(String, String), Cand> = HashMap::new();
    let mut keep = |c: Cand| {
        let key = (c.trip_id.clone(), c.service_date.clone());
        let better = cands.get(&key).is_none_or(|o| c.ev.score(q.radius).unwrap_or(-1.0) > o.ev.score(q.radius).unwrap_or(-1.0));
        if better {
            cands.insert(key, c);
        }
    };

    // 1. Due at the boarding points around: standing there, just arriving or just gone.
    let stops = q.stops.clone().unwrap_or_else(|| {
        let mut v = Vec::new();
        app.stop_grid.around(q.pos, q.radius, |s| {
            if tt.stops[s as usize].pos.dist_m(&q.pos) <= q.radius {
                v.push(s);
            }
        });
        v
    });
    if !stops.is_empty() {
        let due = liveapi::due_in(app, live, &DueQuery { stops, t: q.t, before: 180, after: 300, limit: 200, to: None });
        for d in due.due {
            let quay = app.stop_ids.get(&d.quay_id).map(|&s| tt.stops[s as usize].pos);
            let at = d.arr.or(d.dep).unwrap_or(q.t);
            let gone = d.dep.unwrap_or(at);
            let time_off_s = if q.t < at { at - q.t } else if q.t > gone { q.t - gone } else { 0 };
            let travel = match d.state {
                "departed" => d.depart_bearing.or(d.approach_bearing),
                "approaching" => d.approach_bearing.or(d.depart_bearing),
                _ => d.depart_bearing.or(d.approach_bearing),
            };
            let ev = Evidence {
                line: line_evidence(&q.line, &d.line.name, &d.line.category),
                text: text_of(&q.headsign, &d.headsign, &d.vias),
                distance_m: quay.map(|p| p.dist_m(&q.pos)).unwrap_or(q.radius),
                time_off_s,
                bearing_diff: q.bearing.zip(travel).map(|(a, b)| angle_diff(a, b)),
            };
            keep(Cand {
                trip_id: d.trip_id,
                service_date: d.service_date,
                line: d.line,
                headsign: d.headsign,
                vias: d.vias,
                seq: d.seq,
                quay_id: Some(d.quay_id),
                ev,
                live_info: d.live_info,
                extra: d.extra,
                cancelled: d.cancelled,
            });
        }
    }

    // 2. Under way nearby, between stops: within `radius` of the camera, and only when no
    //    boarding point was named (a vehicle between stops is at none).
    let moving = if q.stops.is_some() { Vec::new() } else { liveapi::vehicles_in(app, live, &BBox::around(q.pos, q.radius), q.t).vehicles };
    for x in moving {
        let (a, b) = (LatLon::from_deg(x.from[1], x.from[0]), LatLon::from_deg(x.to[1], x.to[0]));
        let here = a.lerp(&b, x.frac);
        let d = here.dist_m(&q.pos);
        if !admit_moving(d, q.radius, q.stops.is_some()) {
            continue;
        }
        let travel = (a.dist_m(&b) > 5.0).then(|| a.bearing_deg(&b));
        let vias = run_of(app, live, &x.trip_id, &x.service_date)
            .filter(|r| !r.calls.is_empty())
            .map(|r| {
                let next = x.next_seq as usize;
                let own = tt.stops[r.calls[next.min(r.calls.len() - 1)].stop as usize].station;
                let mut out = vec![tt.stations[own as usize].name.clone()];
                out.extend(r.calls[(next + 1).min(r.calls.len())..].iter().filter(|c| !c.skipped).take(4).map(|c| tt.stations[tt.stops[c.stop as usize].station as usize].name.clone()));
                out.dedup();
                out
            })
            .unwrap_or_default();
        let ev = Evidence {
            line: line_evidence(&q.line, &x.line.name, &x.line.category),
            text: text_of(&q.headsign, &x.headsign, &vias),
            distance_m: d,
            time_off_s: 0,
            bearing_diff: q.bearing.zip(travel).map(|(a, b)| angle_diff(a, b)),
        };
        keep(Cand {
            trip_id: x.trip_id,
            service_date: x.service_date,
            line: x.line,
            headsign: x.headsign,
            vias,
            seq: x.next_seq,
            quay_id: None,
            ev,
            live_info: x.live_info,
            extra: x.extra,
            cancelled: false,
        });
    }

    // 3. Rank and decide.
    let mut ranked: Vec<(f32, Cand)> = cands.into_values().filter(|c| !c.cancelled).filter_map(|c| c.ev.score(q.radius).map(|s| (s, c))).collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    let best = ranked.first().map(|r| r.0).unwrap_or(0.0);
    let second = ranked.get(1).map(|r| r.0).unwrap_or(0.0);
    let result = if ranked.is_empty() || best < 0.4 {
        "none"
    } else if best >= MATCH_MIN && best - second >= MATCH_MARGIN {
        "match"
    } else {
        "ambiguous"
    };
    let candidates: Vec<json::IdentifyCandidate> = ranked
        .into_iter()
        .take(5)
        .map(|(score, c)| {
            let downstream = run_of(app, live, &c.trip_id, &c.service_date)
                .map(|r| {
                    r.calls
                        .iter()
                        .enumerate()
                        .skip(c.seq as usize)
                        .filter(|(_, x)| !x.skipped)
                        .map(|(i, x)| json::DownstreamStop {
                            seq: i as u16,
                            station: tt.stations[tt.stops[x.stop as usize].station as usize].name.clone(),
                            quay_id: tt.stops[x.stop as usize].gtfs_id.clone(),
                            arr: x.arr,
                        })
                        .collect()
                })
                .unwrap_or_default();
            json::IdentifyCandidate {
                trip_id: c.trip_id,
                service_date: c.service_date,
                score: (score * 1000.0).round() / 1000.0,
                line: c.line,
                headsign: c.headsign,
                seq: c.seq,
                quay_id: c.quay_id,
                downstream,
                evidence: json::IdentifyEvidence {
                    line: match c.ev.line {
                        LineEvidence::Exact => "exact",
                        LineEvidence::Confusable => "confusable",
                        LineEvidence::Unseen => "unseen",
                        LineEvidence::Contradicted => "contradicted",
                    },
                    text: c.ev.text.map(|t| (t * 100.0).round() / 100.0),
                    distance_m: c.ev.distance_m.round() as u32,
                    time_off_s: c.ev.time_off_s,
                    bearing_diff: c.ev.bearing_diff.map(f32::round),
                },
                live_info: c.live_info,
                extra: c.extra,
            }
        })
        .collect();
    json::IdentifyResponse {
        t: q.t,
        result,
        confidence: (result == "match").then(|| (best * 1000.0).round() / 1000.0),
        candidates,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn line_readings() {
        assert_eq!(line_evidence("10", "10", "T"), LineEvidence::Exact);
        assert_eq!(line_evidence("S1", "S1", "S"), LineEvidence::Exact);
        assert_eq!(line_evidence("S 1", "S1", "S"), LineEvidence::Exact);
        assert_eq!(line_evidence("1", "S1", "S"), LineEvidence::Exact, "a display often shows only the number");
        assert_eq!(line_evidence("IC 8", "IC8", "IC"), LineEvidence::Exact);
        assert_eq!(line_evidence("1O", "10", "T"), LineEvidence::Confusable);
        assert_eq!(line_evidence("", "10", "T"), LineEvidence::Unseen);
        assert_eq!(line_evidence("12", "10", "T"), LineEvidence::Contradicted);
        assert_eq!(line_evidence("10", "S10", "S"), LineEvidence::Exact);
        assert_eq!(line_evidence("1", "10", "T"), LineEvidence::Contradicted, "1 is not 10");
    }

    #[test]
    fn destination_text() {
        assert!(text_fit("Ostermundigen Rüti", "Ostermundigen, Rüti") > 0.95);
        assert!(text_fit("Ostermundigen Rut1", "Ostermundigen, Rüti") > 0.75, "a misread letter");
        assert!(text_fit("Bern", "Bern, Bahnhof") > 0.6);
        assert!(text_fit("Bern", "Bern, Bahnhof") < text_fit("Bern Bahnhof", "Bern, Bahnhof"));
        assert!(text_fit("Wabern", "Ostermundigen, Rüti") < 0.4);
    }

    #[test]
    fn moving_vehicles_stay_inside_the_question() {
        assert!(admit_moving(15.0, 20.0, false));
        assert!(!admit_moving(150.0, 20.0, false), "150 m away is outside a 20 m radius");
        assert!(!admit_moving(5.0, 120.0, true), "a named boarding point admits no vehicle between stops");
    }

    #[test]
    fn bearings() {
        assert_eq!(angle_diff(10.0, 350.0), 20.0);
        assert_eq!(angle_diff(0.0, 180.0), 180.0);
        assert_eq!(angle_diff(90.0, 90.0), 0.0);
    }

    #[test]
    fn scores_rank_the_evidence() {
        let ev = |line, text, d, b| Evidence { line, text, distance_m: d, time_off_s: 0, bearing_diff: b };
        let sure = ev(LineEvidence::Exact, Some(0.95), 20.0, Some(10.0)).score(150.0).unwrap();
        let other_way = ev(LineEvidence::Exact, Some(0.2), 20.0, Some(170.0)).score(150.0);
        let unread = ev(LineEvidence::Unseen, None, 20.0, None).score(150.0).unwrap();
        assert!(sure >= MATCH_MIN, "{sure}");
        assert_eq!(other_way, None, "driving the other way is ruled out");
        assert!(unread < MATCH_MIN, "nothing read is never a match on its own: {unread}");
        assert_eq!(ev(LineEvidence::Contradicted, Some(1.0), 0.0, None).score(150.0), None);
        let wrong_text = ev(LineEvidence::Exact, Some(0.16), 5.0, None).score(150.0).unwrap();
        assert!(wrong_text < MATCH_MIN, "a destination that does not fit is never a match: {wrong_text}");
    }
}
