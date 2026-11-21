//! End-to-end import of a small hand-written feed that exercises the rules of
//! the importer: stop/station grouping, labels and sectors, atlas join,
//! calendars, pattern splitting, frequencies, transfers, repairs and skips.

use kante_core::time::parse_date;
use kante_core::*;
use kante_gtfs::{import, import_with_report, verify, ImportOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

fn q(rows: &[&[&str]]) -> String {
    rows.iter().map(|r| r.iter().map(|f| format!("\"{}\"", f.replace('"', "\"\""))).collect::<Vec<_>>().join(",") + "\r\n").collect()
}

fn write_zip(path: &Path, files: &[(&str, String)]) {
    let mut w = zip::ZipWriter::new(std::fs::File::create(path).unwrap());
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    for (name, body) in files {
        w.start_file(*name, opts).unwrap();
        w.write_all(b"\xEF\xBB\xBF").unwrap();
        w.write_all(body.as_bytes()).unwrap();
    }
    w.finish().unwrap();
}

fn temp_dir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("kante-gtfs-test-{}-{}", name, std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

const E15: &str = "ch:1:sloid:1:1:5";
const GEN: &str = "ch:1:sloid:1_gen:ch:1:sloid:1:1:5_pf:5A-C";
const S1: &str = "ch:1:sloid:1";
const B1: &str = "ch:1:sloid:2:0:1";
const B2: &str = "ch:1:sloid:2:0:2";
const S3: &str = "ch:1:sloid:3";
const UNUSED: &str = "ch:1:sloid:3:0:9";

fn feed() -> Vec<(&'static str, String)> {
    let agency = "agency_id,agency_name,agency_url,agency_timezone\r\n".to_string() + &q(&[&["A1", "Test \"Bahn\" AG", "", "Europe/Zurich"]]);
    let routes = "route_id,agency_id,route_short_name,route_long_name,route_desc,route_type\r\n".to_string()
        + &q(&[&["R1", "A1", "S1", "", "S", "109"], &["R2", "A1", "10", "", "B", "700"], &["R3", "A9", "", "Gondel", "GB", "1300"]]);
    let stops = "stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station,platform_code,original_stop_id,didok\r\n".to_string()
        + &q(&[
            &["P1", "Alpha", "46.0000", "7.0000", "1", "", "", S1, "8500001"],
            &[E15, "Alpha", "46.0010", "7.0000", "", "P1", "5", E15, "8500001"],
            &[GEN, "Alpha", "46.0010", "7.0000", "", "P1", "5A-C", E15, "8500001"],
            &[S1, "Alpha", "46.0000", "7.0000", "", "P1", "", S1, "8500001"],
            &["P2", "Beta, Bahnhof", "46.1000", "7.1000", "1", "", "", "ch:1:sloid:2", "8500002"],
            &[B1, "Beta, Bahnhof", "46.1001", "7.1001", "", "P2", "", B1, "8500002"],
            &[B2, "Beta, Bahnhof", "46.1000", "7.1000", "", "P2", "", B2, "8500002"],
            &["P3", "Gamma", "46.2000", "7.2000", "1", "", "", S3, "8500003"],
            &[S3, "Gamma", "46.2000", "7.2000", "", "P3", "", S3, "8500003"],
            &[UNUSED, "Gamma", "46.2001", "7.2001", "", "P3", "9", UNUSED, "8500003"],
            &["L1", "Lone", "46.3000", "7.3000", "", "", "", "L1", "x"],
            &["P4", "Nowhere", "46.4", "7.4", "1", "", "", "", ""],
        ]);
    let calendar = "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\r\n".to_string()
        + &q(&[
            &["WK", "1", "1", "1", "1", "1", "0", "0", "20260101", "20260131"],
            &["SA", "0", "0", "0", "0", "0", "1", "0", "20251201", "20260117"],
            &["TraCal_1", "0", "0", "0", "0", "0", "0", "0", "20260101", "20260131"],
        ]);
    let calendar_dates = "service_id,date,exception_type\r\n".to_string()
        + &q(&[
            &["WK", "20260102", "2"],
            &["WK", "20260103", "1"],
            &["X1", "20260110", "1"],
            &["TraCal_1", "20260105", "1"],
            &["WK", "20270101", "1"],
        ]);
    let trips = "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,original_trip_id,hints\r\n".to_string()
        + &q(&[
            &["R1", "WK", "t1", "Gamma", "101", "0", "", "ch:1:sjyid:1:101", ""],
            &["R1", "WK", "t2", "Gamma", "102", "0", "", "ch:1:sjyid:1:102", ""],
            &["R1", "WK", "t3", "Gamma", "103", "0", "", "ch:1:sjyid:1:103", ""],
            &["R1", "SA", "t4", "Gamma \"Nord\"", "", "0", "", "ch:1:sjyid:1:101", ""],
            &["R2", "X1", "t5", "Beta", "", "0", "", "", ""],
            &["R3", "WK", "t6", "Lone", "", "0", "", "", ""],
            &["R1", "WK", "t7", "Alpha", "107", "1", "", "", ""],
            &["R9", "WK", "t8", "", "", "", "", "", ""],
            &["R1", "ZZ", "t9", "", "", "", "", "", ""],
            &["R1", "WK", "t10", "", "", "", "", "", ""],
            &["R1", "WK", "t11", "", "", "", "", "", ""],
            &["R2", "WK", "t12", "Gamma", "", "0", "", "", ""],
        ]);
    let stop_times = "trip_id,arrival_time,departure_time,stop_id,stop_sequence,pickup_type,drop_off_type\r\n".to_string()
        + &q(&[
            &["t1", "08:00:00", "08:01:00", E15, "1", "0", "0"],
            &["t1", "08:10:00", "08:10:00", B1, "2", "0", "0"],
            &["t1", "08:20:00", "08:20:00", S3, "5", "0", "0"],
            // t2: rows out of order
            &["t2", "08:30:00", "08:30:00", S3, "3", "0", "0"],
            &["t2", "08:05:00", "08:05:00", E15, "1", "0", "0"],
            &["t2", "08:12:00", "08:12:00", B1, "2", "0", "0"],
            // t3 leaves after t2 and arrives before it
            &["t3", "08:06:00", "08:06:00", E15, "1", "0", "0"],
            &["t3", "08:13:00", "08:13:00", B1, "2", "0", "0"],
            &["t3", "08:25:00", "08:25:00", S3, "3", "0", "0"],
            &["t4", "08:00:00", "08:01:00", GEN, "1", "0", "0"],
            &["t4", "08:10:00", "08:10:00", B1, "2", "0", "0"],
            &["t4", "08:20:00", "08:20:00", S3, "3", "0", "0"],
            &["t5", "24:50:00", "25:00:00", "L1", "1", "0", "1"],
            &["t5", "25:30:00", "25:30:00", B2, "2", "1", "2"],
            &["t6", "00:00:00", "00:00:00", S3, "1", "0", "0"],
            &["t6", "00:04:00", "00:04:00", "L1", "2", "0", "0"],
            &["t7", "08:22:00", "08:22:00", S3, "1", "0", "0"],
            &["t7", "08:40:00", "08:40:00", S1, "2", "0", "0"],
            &["t11", "09:00:00", "09:00:00", S3, "1", "0", "0"],
            &["t12", "09:00:00", "09:00:00", "L1", "1", "3", "0"],
            &["t12", "", "", B2, "2", "0", "0"],
            &["t12", "09:20:00", "", S3, "3", "0", "0"],
            &["t12", "09:15:00", "09:16:00", S1, "4", "0", "0"],
            &["t1", "08:00:00", "08:00:00", "nope", "9", "0", "0"],
            &["nope", "08:00:00", "08:00:00", S3, "1", "0", "0"],
        ]);
    let frequencies = "trip_id,start_time,end_time,headway_secs,exact_times\r\n".to_string()
        + &q(&[&["t6", "08:00:00", "09:00:00", "60", "0"], &["t6", "10:00:00", "10:30:00", "900", "0"], &["nope", "10:00:00", "10:30:00", "900", "0"]]);
    let transfers = "from_stop_id,to_stop_id,from_route_id,to_route_id,from_trip_id,to_trip_id,transfer_type,min_transfer_time,service_id\r\n"
        .to_string()
        + &q(&[
            &[E15, B1, "", "", "", "", "2", "180", ""],
            &[E15, B1, "", "", "", "", "2", "120", ""],
            &[S3, S3, "", "", "", "", "2", "60", ""],
            &[S3, "nope", "", "", "", "", "2", "60", ""],
            &[S3, UNUSED, "", "", "", "", "2", "60", ""],
            &[E15, B1, "R1", "R1", "t1", "t2", "2", "300", ""],
            &[S3, S3, "R1", "R1", "t1", "t7", "4", "", "TraCal_1"],
            &[S3, S3, "R1", "R1", "t1", "nope", "4", "", "TraCal_1"],
            &[S3, S3, "R1", "R1", "t1", "t6", "4", "", "TraCal_1"],
            &[S3, S3, "", "", "", "", "1", "", ""],
        ]);
    let feed_info = "feed_publisher_name,feed_publisher_url,feed_lang,feed_start_date,feed_end_date,feed_version\r\n".to_string()
        + &q(&[&["x", "", "DE", "20260101", "20260131", "v-test"]]);
    vec![
        ("agency.txt", agency),
        ("routes.txt", routes),
        ("stops.txt", stops),
        ("calendar.txt", calendar),
        ("calendar_dates.txt", calendar_dates),
        ("trips.txt", trips),
        ("stop_times.txt", stop_times),
        ("frequencies.txt", frequencies),
        ("transfers.txt", transfers),
        ("feed_info.txt", feed_info),
    ]
}

fn write_atlas(dir: &Path) {
    std::fs::write(
        dir.join("traffic-point.csv"),
        "\u{feff}sloid;designation;designationOperational;compassDirection;trafficPointElementType;wgs84East;wgs84North;parentSloidServicePoint\n\
         ch:1:sloid:1:1:5;5;05;;BOARDING_PLATFORM;7.0005;46.0015;ch:1:sloid:1\n\
         ch:1:sloid:2:0:1;K1;25;90.0;BOARDING_PLATFORM;7.1002;46.1002;ch:1:sloid:2\n\
         ch:1:sloid:2:0:2;;02;;BOARDING_PLATFORM;;;ch:1:sloid:2\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("sectors.csv"),
        "sloid;type;trafficPointSloid;designation;wgs84East;wgs84North\n\
         a;SECTOR;ch:1:sloid:1:1:5;A;7.0010;46.0020\n\
         b;SECTOR;ch:1:sloid:1:1:5;B;7.0020;46.0030\n\
         c;SECTOR;ch:1:sloid:1:1:5;C;7.0030;46.0040\n\
         d;SECTOR;ch:1:sloid:1:1:5;D;7.0040;46.0050\n",
    )
    .unwrap();
    std::fs::write(
        dir.join("prm-platform.csv"),
        "sloid;vehicleAccess\nch:1:sloid:2:0:1;PLATFORM_ACCESS_WITHOUT_ASSISTANCE\nch:1:sloid:2:0:2;TO_BE_COMPLETED\nch:1:sloid:1:1:5;PLATFORM_ACCESS_WITH_ASSISTANCE_WHEN_NOTIFIED\n",
    )
    .unwrap();
}

fn hm(h: i32, m: i32) -> i32 {
    h * 3600 + m * 60
}

#[test]
fn imports_synthetic_feed() {
    let dir = temp_dir("full");
    let zip = dir.join("gtfs.zip");
    write_zip(&zip, &feed());
    write_atlas(&dir);
    let opts = ImportOptions { gtfs_zip: zip, atlas_dir: Some(dir.clone()), min_headway_s: 300 };
    let (tt, rep) = import_with_report(&opts).unwrap();
    verify(&tt).unwrap();

    // ---- counts and skips
    assert_eq!((rep.agencies, rep.routes, rep.trip_rows, rep.stop_rows, rep.stop_time_rows), (1, 3, 12, 12, 25));
    assert_eq!((rep.trips_unknown_route, rep.trips_unknown_service), (1, 1));
    assert_eq!((rep.trips_without_stop_times, rep.trips_single_stop), (1, 1));
    assert_eq!((rep.stop_times_unknown_trip, rep.stop_times_unknown_stop), (1, 1));
    assert!(rep.stop_times_resorted);
    assert_eq!(rep.routes_unknown_agency, 1);
    assert_eq!(rep.calendar_dates_out_of_range, 1);
    assert_eq!(rep.services_only_in_calendar_dates, 1);
    assert_eq!(tt.feed_version, "v-test");
    assert_eq!((tt.start_date, tt.n_days), (parse_date("20260101").unwrap(), 31));
    assert_eq!(tt.agencies.len(), 2);
    assert_eq!(tt.agencies[0].name, "Test \"Bahn\" AG");
    assert_eq!(tt.lines.iter().map(|l| (l.name.as_str(), l.category.as_str(), l.mode)).collect::<Vec<_>>(), vec![
        ("S1", "S", Mode::Rail),
        ("10", "B", Mode::Bus),
        ("Gondel", "GB", Mode::Cableway)
    ]);

    // ---- stations and stops
    let names: Vec<&str> = tt.stations.iter().map(|s| s.name.as_str()).collect();
    assert_eq!(names, vec!["Alpha", "Beta, Bahnhof", "Gamma", "Lone"]);
    assert_eq!(rep.stations_without_stops, 1);
    assert_eq!(tt.stations[0].didok, 8500001);
    assert_eq!(tt.stations[3].didok, 0);
    assert_eq!(tt.stations[0].gtfs_id, "P1");
    assert_eq!(tt.stations[3].gtfs_id, "L1");
    assert_eq!(tt.stops.len(), 7);
    let stop = |id: &str| tt.stops.iter().position(|s| s.gtfs_id == id).unwrap_or_else(|| panic!("no stop {id}")) as u32;
    assert!(tt.stops.iter().all(|s| s.gtfs_id != UNUSED));

    let e15 = &tt.stops[stop(E15) as usize];
    assert_eq!((e15.label.as_str(), e15.sectors.as_str(), e15.precision), ("5", "", Precision::Edge));
    assert_eq!(e15.pos, LatLon::from_deg(46.0015, 7.0005)); // atlas wins over GTFS
    assert_eq!(e15.access, QuayAccess::AssistedOnNotice);
    let gen = &tt.stops[stop(GEN) as usize];
    assert_eq!((gen.label.as_str(), gen.sectors.as_str(), gen.sloid.as_str()), ("5", "A-C", E15));
    assert_eq!(gen.pos, LatLon::from_deg(46.0030, 7.0020)); // centroid of sector points A, B, C
    assert_eq!(gen.precision, Precision::Edge);
    let s1 = &tt.stops[stop(S1) as usize];
    assert_eq!((s1.label.as_str(), s1.precision, s1.compass, s1.access), ("", Precision::Station, -1, QuayAccess::Unknown));
    let b1 = &tt.stops[stop(B1) as usize];
    assert_eq!((b1.label.as_str(), b1.precision, b1.compass, b1.access), ("K1", Precision::Edge, 90, QuayAccess::Autonomous));
    assert_eq!(b1.pos, LatLon::from_deg(46.1002, 7.1002));
    let b2 = &tt.stops[stop(B2) as usize];
    assert_eq!((b2.label.as_str(), b2.precision, b2.access), ("", Precision::EdgeAtStation, QuayAccess::Unknown));
    assert_eq!(b2.pos, tt.stations[1].pos);
    assert_eq!(tt.stops[stop("L1") as usize].precision, Precision::Station);
    assert_eq!(tt.stops[stop(E15) as usize].station, 0);
    assert_eq!(tt.stations[0].stops.len(), 3);
    assert_eq!(tt.stops[stop(B1) as usize].modes, Mode::Rail.bit());
    assert_eq!(tt.stops[stop("L1") as usize].modes, Mode::Bus.bit() | Mode::Cableway.bit());
    assert_eq!(tt.stations[2].modes, Mode::Rail.bit() | Mode::Bus.bit() | Mode::Cableway.bit());
    assert!(tt.stations[0].weight > tt.stations[3].weight && tt.stations[3].weight > 0);

    // ---- calendars
    let trip = |id: &str| (0..tt.trips.len() as u32).find(|&t| tt.trip_gtfs_id(t) == id).unwrap_or_else(|| panic!("no trip {id}"));
    let d = |s: &str| parse_date(s).unwrap();
    let t1 = trip("t1");
    assert!(tt.trip_active(t1, d("20260101"))); // Thursday
    assert!(!tt.trip_active(t1, d("20260102"))); // removed
    assert!(tt.trip_active(t1, d("20260103"))); // Saturday, added
    assert!(!tt.trip_active(t1, d("20260104")));
    assert!(tt.trip_active(t1, d("20260130")) && !tt.trip_active(t1, d("20260131")) && !tt.trip_active(t1, d("20260201")));
    let t4 = trip("t4");
    assert!(tt.trip_active(t4, d("20260110")) && tt.trip_active(t4, d("20260117")) && !tt.trip_active(t4, d("20260124")));
    let t5 = trip("t5");
    assert!(tt.trip_active(t5, d("20260110")) && !tt.trip_active(t5, d("20260111")));
    assert_eq!(rep.trip_rows_active(&tt, d("20260105")), 8); // every WK row of trips.txt: t1 t2 t3 t6 t7 t10 t11 t12
    assert_eq!(tt.day_index(d("20260110")).trips.len(), 2);

    // ---- patterns: t1, t2 together; t3 overtakes t2 and is split off
    let (t2, t3) = (trip("t2"), trip("t3"));
    let p1 = tt.trips[t1 as usize].pattern;
    assert_eq!(tt.trips[t2 as usize].pattern, p1);
    assert_ne!(tt.trips[t3 as usize].pattern, p1);
    assert_ne!(tt.trips[t4 as usize].pattern, p1);
    assert_eq!(t2, t1 + 1);
    assert_eq!(tt.pattern_stops(p1), &[stop(E15), stop(B1), stop(S3)]);
    assert_eq!(tt.trip_times(t1), &[hm(8, 0), hm(8, 1), hm(8, 10), hm(8, 10), hm(8, 20), hm(8, 20)]);
    assert_eq!(tt.trip_times(t2), &[hm(8, 5), hm(8, 5), hm(8, 12), hm(8, 12), hm(8, 30), hm(8, 30)]);
    assert_eq!(tt.patterns[p1 as usize].n_trips, 2);
    assert_eq!(tt.trip_line(t1).name, "S1");
    let tr1 = &tt.trips[t1 as usize];
    assert_eq!((tt.str(tr1.headsign), tt.str(tr1.short_name), tt.str(tr1.sjyid)), ("Gamma", "101", "ch:1:sjyid:1:101"));
    let tr4 = &tt.trips[t4 as usize];
    assert_eq!(tt.str(tr4.headsign), "Gamma \"Nord\"");
    assert_eq!((tr4.short_name, tr4.sjyid), (0, tr1.sjyid)); // empty → index 0; shared sjyid interned once
    assert_eq!(tt.strings[0], "");

    // flags and overnight times
    let p5 = tt.trips[t5 as usize].pattern;
    assert_eq!(tt.pattern_flags(p5), &[FLAG_NO_DROPOFF, FLAG_NO_PICKUP | FLAG_DROPOFF_ON_REQUEST]);
    assert_eq!(tt.trip_times(t5), &[hm(24, 50), hm(25, 0), hm(25, 30), hm(25, 30)]);

    // repaired times: empty row interpolated, half-empty row copied, backwards row clamped
    let t12 = trip("t12");
    assert_eq!(tt.trip_times(t12), &[hm(9, 0), hm(9, 0), hm(9, 10), hm(9, 10), hm(9, 20), hm(9, 20), hm(9, 20), hm(9, 20)]);
    assert_eq!(tt.pattern_flags(tt.trips[t12 as usize].pattern)[0], FLAG_PICKUP_ON_REQUEST);
    assert_eq!((rep.times_interpolated, rep.times_clamped), (2, 1));

    // ---- frequencies: 60 s window on a 300 s grid (13 trips) + 900 s window (3 trips)
    assert!((0..tt.trips.len() as u32).all(|t| tt.trip_gtfs_id(t) != "t6"));
    let freq: Vec<u32> = (0..tt.trips.len() as u32).filter(|&t| tt.trips[t as usize].flags & TRIP_FREQUENCY != 0).collect();
    assert_eq!(freq.len(), 16);
    assert_eq!((rep.frequency_templates, rep.frequency_trips_materialised, rep.frequency_unknown_trip), (1, 16, 1));
    let deps: Vec<i32> = freq.iter().map(|&t| tt.dep(t, 0)).collect();
    let mut want: Vec<i32> = (0..13).map(|k| hm(8, 0) + k * 300).collect();
    want.extend([hm(10, 0), hm(10, 15), hm(10, 30)]);
    assert_eq!(deps, want);
    assert!(freq.iter().all(|&t| tt.arr(t, 1) - tt.dep(t, 0) == 240));
    assert_eq!(tt.trips[freq[0] as usize].headway_s, 60);
    assert_eq!(tt.trips[freq[15] as usize].headway_s, 900);
    assert_eq!(tt.trip_gtfs_id(freq[1]), "t6@08:05:00");
    assert!(freq.windows(2).all(|w| w[1] == w[0] + 1 && tt.trips[w[0] as usize].pattern == tt.trips[w[1] as usize].pattern));
    assert_eq!(tt.trips[t1 as usize].flags, 0);
    assert_eq!(tt.trips[t1 as usize].headway_s, 0);

    // ---- transfers
    let t7 = trip("t7");
    assert_eq!(tt.continuations.len(), 1);
    let c = tt.continuations[0];
    assert_eq!((c.from, c.to), (t1, t7));
    assert!(tt.service_active(c.service, d("20260105")) && !tt.service_active(c.service, d("20260106")));
    assert_eq!(tt.continuations_from(t1).len(), 1);
    assert_eq!(rep.continuations_unknown_trip, 2); // unknown id, and a frequency template
    assert_eq!(tt.official_transfer(stop(E15), stop(B1)), Some(120));
    assert_eq!(tt.official_transfer(stop(S3), stop(S3)), Some(60));
    assert_eq!(tt.official_transfer(stop(B1), stop(E15)), None);
    assert_eq!(tt.official_transfers.len(), 2);
    assert_eq!((rep.transfers_type2_unknown_stop, rep.transfers_type2_not_a_stop, rep.transfers_type2_duplicates), (1, 1, 1));
    assert_eq!((rep.transfers_type2_trip_specific, rep.trip_specific_longer, rep.transfers_type1), (1, 1, 1));

    // ---- stop → patterns index
    let at_b1: Vec<(u32, u16)> = tt.stop_patterns(stop(B1)).to_vec();
    assert_eq!(at_b1.len(), 3);
    assert!(at_b1.iter().all(|&(p, pos)| pos == 1 && tt.pattern_stops(p)[1] == stop(B1)));

    // ---- verify catches broken tables
    let mut bad = tt.clone();
    let off = bad.patterns[p1 as usize].times_off as usize;
    bad.times[off + 6 + 4] = hm(8, 15); // t2 now reaches Gamma before t1
    bad.times[off + 6 + 5] = hm(8, 15);
    assert!(verify(&bad).unwrap_err().to_string().contains("overtakes"));
    let mut bad = tt.clone();
    bad.times[off + 3] = hm(7, 0);
    assert!(verify(&bad).unwrap_err().to_string().contains("backwards"));
    let mut bad = tt.clone();
    bad.patterns[1].trips_off += 1;
    assert!(verify(&bad).unwrap_err().to_string().contains("contiguous"));
    let mut bad = tt.clone();
    bad.pattern_stops[0] = 999;
    assert!(verify(&bad).is_err());
    let mut bad = tt.clone();
    bad.official_transfers.swap(0, 1);
    assert!(verify(&bad).is_err());

    // ---- without atlas: GTFS coordinates, no registry labels
    let tt2 = import(&ImportOptions { atlas_dir: None, ..opts.clone() }).unwrap();
    verify(&tt2).unwrap();
    let find = |id: &str| tt2.stops.iter().find(|s| s.gtfs_id == id).unwrap();
    assert_eq!(find(E15).pos, LatLon::from_deg(46.0010, 7.0000));
    assert_eq!((find(GEN).label.as_str(), find(GEN).sectors.as_str()), ("5", "A-C"));
    assert_eq!((find(B1).label.as_str(), find(B1).precision), ("", Precision::Edge)); // edge by id, own GTFS coordinate
    assert_eq!(find(B2).precision, Precision::EdgeAtStation);
    assert_eq!(tt2.trips.len(), tt.trips.len());

    // ---- frequency floor is an option
    let tt3 = import(&ImportOptions { min_headway_s: 60, ..opts.clone() }).unwrap();
    assert_eq!(tt3.trips.iter().filter(|t| t.flags & TRIP_FREQUENCY != 0).count(), 61 + 3);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn clear_errors() {
    let dir = temp_dir("errors");
    let opts = |zip: &Path| ImportOptions { gtfs_zip: zip.to_path_buf(), atlas_dir: None, min_headway_s: 300 };

    let err = import(&opts(&dir.join("missing.zip"))).unwrap_err();
    assert!(format!("{err:#}").contains("missing.zip"), "{err:#}");

    let zip = dir.join("no-member.zip");
    write_zip(&zip, &feed().into_iter().filter(|(n, _)| *n != "stop_times.txt").collect::<Vec<_>>());
    let err = import(&opts(&zip)).unwrap_err();
    assert!(format!("{err:#}").contains("no member stop_times.txt"), "{err:#}");

    for (member, column) in [("stop_times.txt", "stop_sequence"), ("trips.txt", "service_id"), ("stops.txt", "stop_lat"), ("routes.txt", "route_type"), ("calendar.txt", "friday"), ("transfers.txt", "transfer_type")] {
        let zip = dir.join("no-column.zip");
        let files: Vec<_> = feed().into_iter().map(|(n, body)| if n == member { (n, body.replacen(column, "renamed", 1)) } else { (n, body) }).collect();
        write_zip(&zip, &files);
        let err = format!("{:#}", import(&opts(&zip)).unwrap_err());
        assert!(err.contains(member) && err.contains(&format!("missing column '{column}'")), "{member}/{column}: {err}");
    }

    // Optional members may be absent; the calendar span then defines the feed range.
    let zip = dir.join("minimal.zip");
    let keep = ["agency.txt", "routes.txt", "stops.txt", "calendar.txt", "trips.txt", "stop_times.txt"];
    write_zip(&zip, &feed().into_iter().filter(|(n, _)| keep.contains(n)).collect::<Vec<_>>());
    let tt = import(&opts(&zip)).unwrap();
    verify(&tt).unwrap();
    assert_eq!((tt.start_date, tt.end_date()), (parse_date("20251201").unwrap(), parse_date("20260131").unwrap()));
    assert!(tt.continuations.is_empty() && tt.official_transfers.is_empty());
    assert!(tt.trips.iter().all(|t| t.flags == 0));
    let _ = std::fs::remove_dir_all(&dir);
}
