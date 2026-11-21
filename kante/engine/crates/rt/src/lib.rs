//! kante-rt — live data for the Kante engine (see `docs/ARCHITECTURE.md`).
//!
//! Sources are the two national feeds of opentransportdata.swiss: **SIRI-ET**
//! (XML, 60–150 MB, the richer one: measured times, platform names) and
//! **GTFS-RT TripUpdates** (protobuf, carries the static trip id).
//!
//! | Step | Entry point |
//! |---|---|
//! | download | [`fetch`], [`Fetcher`], paced by a [`Poller`] |
//! | parse | [`parse_siri_et`] (streaming, constant memory), [`parse_gtfs_rt`] → [`RtJourney`] |
//! | match | [`Matcher::apply`] → [`MatchedTrip`] with a [`kante_core::TripLive`] |
//! | serve | [`LiveSnapshotBuilder`] → [`LiveSnapshot`] (implements [`kante_core::LiveView`]) |
//!
//! How a server uses it (one background thread per feed):
//!
//! ```no_run
//! use kante_rt::{FeedKind, Fetcher, LiveSnapshotBuilder, Matcher, Poller};
//! use std::sync::{atomic::AtomicBool, Arc, RwLock};
//! # fn timetable() -> Arc<kante_core::Timetable> { unimplemented!() }
//! let tt = timetable();
//! let matcher = Matcher::new(&tt);                       // once, ~0.3 s
//! let live: Arc<RwLock<Arc<kante_rt::LiveSnapshot>>> = Default::default();
//! let stop = AtomicBool::new(false);
//! let key = std::env::var("KANTE_OTD_KEY").unwrap_or_default();
//! Poller::new(FeedKind::SiriEt).run(
//!     &Fetcher::new(),
//!     &key,
//!     &stop,
//!     |bytes| {
//!         let mut b = LiveSnapshotBuilder::with_capacity(8192);
//!         if b.add_siri_et(&tt, &matcher, &bytes[..]).is_ok() {
//!             *live.write().unwrap() = Arc::new(b.build());   // swap; queries keep their Arc
//!         }
//!     },
//!     |err| eprintln!("siri-et: {err}"),
//! );
//! ```
//!
//! To combine both feeds in one snapshot add SIRI-ET first and GTFS-RT second
//! ([`LiveSnapshotBuilder::add_gtfs_rt`] only fills trips SIRI-ET did not cover).
//!
//! `rt-inspect` (in `src/bin`) runs all of this on saved feed files and prints
//! what the feeds contain and how well they match a `timetable.bin`.

pub mod fetch;
pub mod gtfsrt;
pub mod matcher;
pub mod model;
pub mod siri;
pub mod snapshot;

pub use fetch::{fetch, FetchError, Fetcher, PollPolicy, Poller};
pub use gtfsrt::parse_gtfs_rt;
pub use matcher::{MatchMethod, MatchOptions, MatchedTrip, Matcher, Unmatched};
pub use model::{FeedKind, FeedMeta, RtCall, RtJourney};
pub use siri::{parse_siri_et, parse_siri_et_auto, parse_siri_et_gz};
pub use snapshot::{LiveSnapshot, LiveSnapshotBuilder, MatchCounts, LATE_THRESHOLD};
