//! Shared data model for the Kante engine.
//!
//! Every other crate depends on this one and only on this one for cross-crate
//! types. Importers (`kante-gtfs`, `kante-osm`) *produce* these structures,
//! `kante-link` joins them, and the query-time crates (`kante-raptor`,
//! `kante-walk`, `kante-search`, the server) *consume* them.

pub mod geo;
pub mod io;
pub mod live;
pub mod text;
pub mod time;
pub mod timetable;
pub mod walk;

pub use geo::{BBox, LatLon};
pub use live::{DerivedSlot, ExtraCall, ExtraTrip, LiveView, TripLive, OBSERVED_ARR, OBSERVED_DEP, SOURCE_GTFS_RT, SOURCE_SIRI_ET};
pub use timetable::*;
pub use walk::*;
