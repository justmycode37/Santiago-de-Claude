//! Real-time polling: SIRI-ET from opentransportdata.swiss → matched to the
//! timetable → an immutable [`LiveSnapshot`] swapped into the app state.
//!
//! Key lookup order: env `KANTE_OTD_KEY`, then `"siri-et"` in
//! `<data>/secrets/otd.json`. Without a key the server runs on the timetable.
//! `KANTE_RT_FILE=<siri-et file>` loads one saved document instead of polling
//! (for offline testing).

use crate::json::RealtimeMeta;
use crate::state::App;
use kante_core::LiveView;
use kante_rt::{FeedKind, Fetcher, LiveSnapshotBuilder, Matcher, Poller};
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Instant;

fn siri_key(app: &App) -> Option<String> {
    if let Ok(k) = std::env::var("KANTE_OTD_KEY") {
        if !k.trim().is_empty() {
            return Some(k.trim().to_string());
        }
    }
    let text = std::fs::read_to_string(app.data_dir.join("secrets/otd.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&text).ok()?;
    v.get("siri-et")?.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// Parse one SIRI-ET document and publish it as the current snapshot.
fn ingest(app: &App, matcher: &Matcher, bytes: &[u8]) {
    let t = Instant::now();
    let mut builder = LiveSnapshotBuilder::with_capacity(8192);
    let mut journeys = 0usize;
    let parsed = kante_rt::parse_siri_et_auto(bytes, |j| {
        journeys += 1;
        if let Some(m) = matcher.apply(&app.tt, &j) {
            builder.push(m);
        }
    });
    match parsed {
        Ok(meta) => {
            let ts = meta.timestamp;
            builder.feed(meta);
            let trips = builder.len();
            let snap = builder.build();
            let mut live = app.live.write();
            live.view = Some(Arc::new(snap) as Arc<dyn LiveView>);
            live.meta = RealtimeMeta { enabled: true, source: Some("siri-et".into()), updated_at: Some(ts), trips: Some(trips), error: None };
            eprintln!("live: {trips} of {journeys} journeys matched, {:.1} MB in {:.2}s", bytes.len() as f32 / 1e6, t.elapsed().as_secs_f32());
        }
        Err(e) => {
            app.live.write().meta.error = Some(format!("parse: {e:#}"));
            eprintln!("live: parse failed: {e:#}");
        }
    }
}

pub fn start(app: Arc<App>) {
    if let Ok(path) = std::env::var("KANTE_RT_FILE") {
        std::thread::spawn(move || {
            let matcher = Matcher::new(&app.tt);
            match std::fs::read(&path) {
                Ok(bytes) => ingest(&app, &matcher, &bytes),
                Err(e) => eprintln!("live: cannot read {path}: {e}"),
            }
        });
        return;
    }
    let Some(key) = siri_key(&app) else {
        eprintln!("live: no API key (KANTE_OTD_KEY or data/secrets/otd.json) — running on the timetable only");
        return;
    };
    app.live.write().meta = RealtimeMeta { enabled: true, source: Some("siri-et".into()), ..Default::default() };
    std::thread::Builder::new()
        .name("live".into())
        .spawn(move || {
            let matcher = Matcher::new(&app.tt);
            let fetcher = Fetcher::new();
            let mut poller = Poller::new(FeedKind::SiriEt);
            let stop = AtomicBool::new(false);
            poller.run(
                &fetcher,
                &key,
                &stop,
                |bytes| ingest(&app, &matcher, &bytes),
                |e| {
                    eprintln!("live: fetch failed: {e}");
                    app.live.write().meta.error = Some(e.to_string());
                },
            );
        })
        .expect("spawn live thread");
}
