//! Real-time polling: SIRI-ET and GTFS-RT from opentransportdata.swiss →
//! matched to the timetable → one immutable [`LiveSnapshot`] swapped into the
//! app state after every poll of either feed.
//!
//! SIRI-ET is the primary feed (measured times, platform changes, extra
//! journeys); GTFS-RT, which is regenerated more often, adds trips SIRI-ET
//! lacks and newer forecasts for stops not yet reached
//! ([`LiveSnapshotBuilder::merge_forecasts`]). Each feed keeps its last
//! matched trips, so a poll of one rebuilds the snapshot with the other's last
//! state without parsing it again.
//!
//! Keys, per feed: env `KANTE_OTD_KEY` / `KANTE_OTD_GTFS_RT_KEY`, else
//! `"siri-et"` / `"gtfs-rt"` in `<data>/secrets/otd.json`. Without a GTFS-RT
//! key the SIRI-ET key is tried (one key can be subscribed to both). Without
//! any key the server runs on the timetable.
//! `KANTE_RT_FILE=<siri-et file>` (and `KANTE_RT_GTFS_FILE=<gtfs-rt file>`)
//! load saved documents instead of polling, for offline testing.

use crate::json::{FeedStatus, RealtimeMeta};
use crate::state::App;
use kante_core::{ExtraTrip, LiveView, SOURCE_SIRI_ET};
use kante_rt::{FeedKind, FeedMeta, Fetcher, LiveSnapshotBuilder, MatchedTrip, Matcher, Poller};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

/// What one feed contributed at its last successful poll.
#[derive(Default)]
struct FeedState {
    trips: Vec<MatchedTrip>,
    extras: Vec<ExtraTrip>,
    meta: Option<FeedMeta>,
    journeys: usize,
    /// Unix time of the last successful poll, and the last error since.
    ok_at: Option<i64>,
    error: Option<String>,
    enabled: bool,
    /// Its data was dropped after [`EXPIRE_S`] without an answer; cleared by the next answer.
    expired: bool,
}

impl FeedState {
    /// The feed's data is in use: it answered, and not so long ago that it was dropped.
    fn live(&self) -> bool {
        self.ok_at.is_some() && !self.expired
    }
}

#[derive(Default)]
pub struct Feeds {
    siri: FeedState,
    gtfs: FeedState,
}

fn now_unix() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0)
}

fn secret(app: &App, env: &str, name: &str) -> Option<String> {
    if let Ok(k) = std::env::var(env) {
        if !k.trim().is_empty() {
            return Some(k.trim().to_string());
        }
    }
    let text = std::fs::read_to_string(app.data_dir.join("secrets/otd.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get(name)?.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Parse one document of `kind` and keep its matched trips.
fn ingest(app: &App, matcher: &Matcher, kind: FeedKind, bytes: &[u8]) {
    let t = Instant::now();
    let tt = &app.tt;
    let mut trips = Vec::with_capacity(8192);
    let mut extras = Vec::new();
    let mut journeys = 0usize;
    let mut sink = |j: kante_rt::RtJourney| {
        journeys += 1;
        match matcher.apply(tt, &j) {
            Some(mut m) => {
                m.live.sources = match kind {
                    FeedKind::SiriEt => SOURCE_SIRI_ET,
                    FeedKind::GtfsRt => kante_core::SOURCE_GTFS_RT,
                };
                trips.push(m);
            }
            // Only SIRI-ET names the lines and destinations of added journeys.
            None if j.extra && kind == FeedKind::SiriEt => extras.extend(matcher.extra_trip(tt, &j)),
            None => {}
        }
    };
    let parsed = match kind {
        FeedKind::SiriEt => kante_rt::parse_siri_et_auto(bytes, &mut sink),
        FeedKind::GtfsRt => {
            // The document is small: read it whole first, so that trip ids of another
            // timetable version can be set aside before matching (the journey id and
            // the stops still find the trip).
            let mut all = Vec::new();
            match kante_rt::parse_gtfs_rt(bytes, |j| all.push(j)) {
                Ok(meta) => {
                    let other = !meta.feed_version.is_empty() && meta.feed_version != tt.feed_version;
                    if other {
                        eprintln!("live: gtfs-rt refers to timetable {} but {} is loaded; matching without its trip ids", meta.feed_version, tt.feed_version);
                    }
                    for mut j in all {
                        if other {
                            j.trip_id.clear();
                        }
                        sink(j);
                    }
                    Ok(meta)
                }
                Err(e) => Err(e),
            }
        }
    };
    let mut feeds = app.feeds.lock();
    let st = match kind {
        FeedKind::SiriEt => &mut feeds.siri,
        FeedKind::GtfsRt => &mut feeds.gtfs,
    };
    st.enabled = true;
    match parsed {
        Ok(meta) => {
            eprintln!(
                "live: {}: {} of {journeys} journeys matched, {} extra, {:.1} MB in {:.2}s",
                kind.as_str(),
                trips.len(),
                extras.len(),
                bytes.len() as f32 / 1e6,
                t.elapsed().as_secs_f32()
            );
            st.trips = trips;
            st.extras = extras;
            st.meta = Some(meta);
            st.journeys = journeys;
            st.ok_at = Some(now_unix());
            st.error = None;
            st.expired = false;
        }
        Err(e) => {
            eprintln!("live: {}: parse failed: {e:#}", kind.as_str());
            st.error = Some(format!("parse: {e:#}"));
            return;
        }
    }
    publish(app, &feeds);
}

/// Build the snapshot from both feeds' last state and swap it in.
fn publish(app: &App, feeds: &Feeds) {
    let tt = &app.tt;
    let mut b = LiveSnapshotBuilder::with_capacity(feeds.siri.trips.len() + 1024);
    for m in &feeds.siri.trips {
        b.push(m.clone());
    }
    for e in &feeds.siri.extras {
        b.push_extra(e.clone());
    }
    for m in &feeds.gtfs.trips {
        b.merge_forecasts(tt, m.clone());
    }
    for f in [&feeds.siri, &feeds.gtfs] {
        if let Some(meta) = &f.meta {
            b.feed(meta.clone());
        }
    }
    let trips = b.len();
    let snap = b.build();
    let extras = snap.extras().len();
    let view = live_view_of(snap);
    let mut live = app.live.write();
    live.meta = match &view {
        Some(v) => meta_of(feeds, Some(v.1), Some(trips), Some(extras)),
        // every feed has expired: running on the timetable, and saying so
        None => meta_of(feeds, None, None, None),
    };
    live.view = view.map(|(v, _)| v);
    drop(live);
    app.bump_live();
}

/// The snapshot to serve and its time, or none when no feed contributed to it (all expired):
/// an empty snapshot would make every answer look live, dated 1 January 1970.
fn live_view_of(snap: kante_rt::LiveSnapshot) -> Option<(Arc<dyn LiveView>, i64)> {
    if snap.feeds.is_empty() {
        return None;
    }
    let t = snap.timestamp();
    Some((Arc::new(snap) as Arc<dyn LiveView>, t))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn meta_tells_a_dropped_feed() {
        let mut feeds = Feeds::default();
        feeds.siri = FeedState { enabled: true, ok_at: Some(1_795_260_000), journeys: 13_000, ..Default::default() };
        let m = meta_of(&feeds, Some(1_795_260_000), Some(13_000), Some(0));
        assert_eq!((m.source.as_deref(), m.error.as_deref()), (Some("siri-et"), None));
        // 30 minutes without an answer: dropped
        feeds.siri.expired = true;
        feeds.siri.journeys = 0;
        let m = meta_of(&feeds, None, None, None);
        assert_eq!(m.source, None, "no feed in use");
        assert!(m.error.as_deref().unwrap().contains("dropped"), "{:?}", m.error);
        assert!(m.updated_at.is_none());
        let f = &m.feeds[0];
        assert_eq!((f.journeys, f.matched), (None, None));
        assert_eq!(f.polled_at, Some(1_795_260_000), "when it last answered");
        assert!(f.error.is_some());
    }

    #[test]
    fn no_feed_means_no_live_view() {
        assert!(live_view_of(LiveSnapshotBuilder::new().build()).is_none(), "all feeds expired: timetable only");
        let mut b = LiveSnapshotBuilder::new();
        b.feed(FeedMeta { timestamp: 1_795_262_000, journeys: 0, source: "siri-et", feed_version: String::new() });
        let (_, t) = live_view_of(b.build()).expect("a feed answered, even with nothing in it");
        assert_eq!(t, 1_795_262_000);
    }
}

fn status(name: &'static str, f: &FeedState) -> Option<FeedStatus> {
    f.enabled.then(|| FeedStatus {
        name,
        updated_at: f.meta.as_ref().map(|m| m.timestamp),
        // when it last answered, also after its data was dropped
        polled_at: f.ok_at,
        journeys: f.live().then_some(f.journeys),
        matched: f.live().then_some(f.trips.len()),
        error: f.error.clone().or_else(|| f.expired.then(|| format!("no answer for {} min: its data was dropped", EXPIRE_S / 60))),
    })
}

fn meta_of(feeds: &Feeds, updated_at: Option<i64>, trips: Option<usize>, extras: Option<usize>) -> RealtimeMeta {
    let source = match (feeds.siri.live(), feeds.gtfs.live()) {
        (true, true) => Some("siri-et+gtfs-rt".to_string()),
        (true, false) => Some("siri-et".to_string()),
        (false, true) => Some("gtfs-rt".to_string()),
        (false, false) => None,
    };
    let error = [&feeds.siri, &feeds.gtfs].iter().filter(|f| !f.live()).find_map(|f| {
        f.error.clone().or_else(|| f.expired.then(|| format!("no answer for {} min: its data was dropped", EXPIRE_S / 60)))
    });
    RealtimeMeta {
        enabled: feeds.siri.enabled || feeds.gtfs.enabled,
        source,
        updated_at,
        trips,
        extras,
        error,
        feeds: [status("siri-et", &feeds.siri), status("gtfs-rt", &feeds.gtfs)].into_iter().flatten().collect(),
    }
}

fn failed(app: &App, kind: FeedKind, e: String) {
    eprintln!("live: {}: fetch failed: {e}", kind.as_str());
    let mut feeds = app.feeds.lock();
    let st = match kind {
        FeedKind::SiriEt => &mut feeds.siri,
        FeedKind::GtfsRt => &mut feeds.gtfs,
    };
    st.error = Some(e);
    let mut live = app.live.write();
    let (u, t, x) = (live.meta.updated_at, live.meta.trips, live.meta.extras);
    live.meta = meta_of(&feeds, u, t, x);
}

/// A feed that has not been fetched for this long is dropped from the snapshot: its delays are
/// too old to plan with (they are shown as `stale` well before, after 5 minutes).
const EXPIRE_S: i64 = 1800;

/// Every minute: drop the data of a feed that has been failing for [`EXPIRE_S`].
fn expire(app: Arc<App>) {
    std::thread::Builder::new()
        .name("live-expiry".into())
        .spawn(move || loop {
            std::thread::sleep(std::time::Duration::from_secs(60));
            let now = now_unix();
            let mut guard = app.feeds.lock();
            let feeds = &mut *guard;
            let mut dropped = false;
            for (name, f) in [("siri-et", &mut feeds.siri), ("gtfs-rt", &mut feeds.gtfs)] {
                if !f.expired && f.ok_at.is_some_and(|t| now - t > EXPIRE_S) {
                    eprintln!("live: {name}: no data for {} min, dropping it until the feed answers again", EXPIRE_S / 60);
                    f.trips.clear();
                    f.extras.clear();
                    f.meta = None;
                    f.journeys = 0;
                    f.expired = true;
                    dropped = true;
                }
            }
            if dropped {
                publish(&app, feeds);
            }
        })
        .expect("spawn live expiry thread");
}

fn poll(app: Arc<App>, kind: FeedKind, key: String) {
    app.feeds.lock().gtfs.enabled |= kind == FeedKind::GtfsRt;
    app.feeds.lock().siri.enabled |= kind == FeedKind::SiriEt;
    std::thread::Builder::new()
        .name(format!("live-{}", kind.as_str()))
        .spawn(move || {
            let matcher = Matcher::new(&app.tt);
            let fetcher = Fetcher::new();
            let mut poller = Poller::new(kind);
            let stop = AtomicBool::new(false);
            poller.run(&fetcher, &key, &stop, |bytes| ingest(&app, &matcher, kind, &bytes), |e| failed(&app, kind, e.to_string()));
        })
        .expect("spawn live thread");
}

pub fn start(app: Arc<App>) {
    let files = [(FeedKind::SiriEt, std::env::var("KANTE_RT_FILE").ok()), (FeedKind::GtfsRt, std::env::var("KANTE_RT_GTFS_FILE").ok())];
    if files.iter().any(|(_, f)| f.is_some()) {
        std::thread::spawn(move || {
            let matcher = Matcher::new(&app.tt);
            for (kind, path) in files {
                let Some(path) = path else { continue };
                match std::fs::read(&path) {
                    Ok(bytes) => ingest(&app, &matcher, kind, &bytes),
                    Err(e) => eprintln!("live: cannot read {path}: {e}"),
                }
            }
        });
        return;
    }
    let siri = secret(&app, "KANTE_OTD_KEY", "siri-et");
    let gtfs = secret(&app, "KANTE_OTD_GTFS_RT_KEY", "gtfs-rt").or_else(|| siri.clone());
    if siri.is_none() && gtfs.is_none() {
        eprintln!("live: no API key (KANTE_OTD_KEY or data/secrets/otd.json) — running on the timetable only");
        return;
    }
    expire(app.clone());
    if let Some(k) = siri {
        poll(app.clone(), FeedKind::SiriEt, k);
    }
    if let Some(k) = gtfs {
        poll(app.clone(), FeedKind::GtfsRt, k);
    }
    let feeds = app.feeds.lock();
    app.live.write().meta = meta_of(&feeds, None, None, None);
}
