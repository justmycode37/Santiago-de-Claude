//! Behaviour of the geocoder on a small hand-made world.

use kante_core::{LatLon, Station, Timetable};
use kante_search::{build_from_raw, Hit, HitKind, PoiInfo, RawData, SearchIndex, CLASS_NATURE, CLASS_PLACE_MAJOR, CLASS_PLACE_MINOR, CLASS_POI};

fn ll(lat: f64, lon: f64) -> LatLon {
    LatLon::from_deg(lat, lon)
}

fn station(id: &str, name: &str, lat: f64, lon: f64, weight: u32, rail: bool) -> Station {
    Station { gtfs_id: id.into(), name: name.into(), pos: ll(lat, lon), didok: 0, stops: vec![], weight, modes: if rail { 1 } else { 4 } }
}

const BERN: (f64, f64) = (46.9488, 7.4391);
const ZURICH: (f64, f64) = (47.3782, 8.5402);

fn world() -> SearchIndex {
    let tt = Timetable {
        feed_version: "test-feed".into(),
        stations: vec![
            station("8507000", "Bern", BERN.0, BERN.1, 10_000, true),
            station("8576646", "Bern, Bahnhof", 46.9481, 7.4402, 3_700, false),
            station("8516161", "Bern Wankdorf", 46.9678, 7.4655, 3_400, true),
            station("8590048", "Bern, Bundesplatz", 46.9470, 7.4439, 700, false),
            station("8589775", "Luzern, Bundesplatz", 47.0464, 8.3083, 860, false),
            station("8579896", "Bern, Hirschengraben", 46.9461, 7.4378, 3_000, false),
            station("8590100", "Bern, Kornhausplatz", 46.9489, 7.4474, 900, false),
            station("8503000", "Zürich HB", ZURICH.0, ZURICH.1, 16_000, true),
            station("8503006", "Zürich Oerlikon", 47.4115, 8.5441, 8_800, true),
            station("8591067", "Zürich, Bahnhofstrasse/HB", 47.3762, 8.5395, 2_000, false),
            station("8501008", "Genève", 46.2102, 6.1425, 4_400, true),
            station("8501026", "Genève-Aéroport", 46.2325, 6.1120, 2_000, true),
            station("8506302", "St. Gallen", 47.4232, 9.3699, 5_100, true),
            station("8504415", "Busswil BE", 47.0987, 7.3186, 1_200, true),
            station("8505213", "Bellinzona", 46.1954, 9.0295, 2_500, true),
            station("8500010", "Basel SBB", 47.5474, 7.5896, 4_400, true),
            station("8507364", "Jungfraujoch", 46.5475, 7.9821, 120, true),
        ],
        ..Timetable::default()
    };
    let mut raw = RawData::default();

    // Bundesgasse in Bern: 1…40 and a 3a, running east.
    for n in 1..=40u32 {
        raw.add_addr("Bundesgasse", &n.to_string(), "3011", "Bern", ll(46.9462, 7.4380 + n as f64 * 0.0002));
    }
    raw.add_addr("Bundesgasse", "3a", "3011", "Bern", ll(46.9463, 7.4386));
    // Mapped twice (building and entrance): must appear once.
    raw.add_addr("Bundesgasse", "7", "3011", "Bern", ll(46.94621, 7.43941));
    // No town, no postcode: inherits them from its neighbours.
    raw.add_addr("Bundesgasse", "42", "", "", ll(46.9462, 7.4466));
    // Postcode only / town only.
    raw.add_addr("Schauplatzgasse", "9", "3011", "", ll(46.9471, 7.4420));
    raw.add_addr("Schauplatzgasse", "11", "", "Bern", ll(46.9471, 7.4422));
    raw.add_addr("Kornhausplatz", "18", "3011", "Bern", ll(46.9488, 7.4471));
    raw.add_addr("Kornhausplatz", "12-14", "3011", "Bern", ll(46.9486, 7.4472));
    // The same street name in three towns.
    raw.add_addr("Bahnhofstrasse", "10", "8001", "Zürich", ll(47.3681, 8.5400));
    raw.add_addr("Bahnhofstrasse", "12", "8001", "Zürich", ll(47.3690, 8.5398));
    raw.add_addr("Bahnhofstrasse", "100", "8001", "Zürich", ll(47.3760, 8.5396));
    raw.add_addr("Bahnhofstrasse", "10", "2502", "Biel/Bienne", ll(47.1340, 7.2440));
    raw.add_addr("Bahnhofstr.", "10", "3600", "Thun", ll(46.7560, 7.6290));
    raw.add_addr("Rue du Mont-Blanc", "3", "1201", "Genève", ll(46.2074, 6.1466));
    raw.add_addr("Rue du 23-Juin", "5", "2900", "Porrentruy", ll(47.4150, 7.0750));
    // A named way without any address: found by name, located by its neighbours.
    raw.add_street("Zytgloggelaube", &[ll(46.9479, 7.4478), ll(46.9479, 7.4486), ll(46.9479, 7.4494)]);
    // The way of a street that also has addresses joins it.
    raw.add_street("Bundesgasse", &[ll(46.9461, 7.4382), ll(46.9461, 7.4460)]);

    raw.add_poi("Bern", "Berne Berna", "City", 70, CLASS_PLACE_MAJOR, "", "", ll(46.9485, 7.4522), 4);
    raw.add_poi("Zürich", "Zurich Zurigo", "City", 70, CLASS_PLACE_MAJOR, "", "", ll(47.3744, 8.5410), 8);
    raw.add_poi("Wabern", "", "Village", 52, CLASS_PLACE_MINOR, "", "", ll(46.9290, 7.4480), 12);
    raw.add_poi("Zytglogge", "Zeitglockenturm Clock Tower", "Attraction", 60, CLASS_POI, "3011", "Bern", ll(46.9480, 7.4478), 16);
    raw.add_poi("Coop", "", "Supermarket", 34, CLASS_POI, "3011", "Bern", ll(46.9486, 7.4397), 20);
    raw.add_poi("Coop", "", "Supermarket", 34, CLASS_POI, "8001", "Zürich", ll(47.3767, 8.5422), 24);
    raw.add_poi("Coop", "", "Supermarket", 34, CLASS_POI, "3600", "Thun", ll(46.7570, 7.6280), 28);
    raw.add_poi("Dr. Noyer", "apotheke pharmacie", "Pharmacy", 32, CLASS_POI, "3011", "Bern", ll(46.9481, 7.4376), 32);
    raw.add_poi("Universität Bern", "", "University", 62, CLASS_POI, "3012", "Bern", ll(46.9511, 7.4379), 36);
    raw.add_poi("Zentrum Paul Klee", "", "Museum", 62, CLASS_POI, "3006", "Bern", ll(46.9491, 7.4743), 40);
    raw.add_poi("Paul Klee", "", "Café", 30, CLASS_POI, "1025", "Saint-Sulpice", ll(46.5182, 6.5680), 44);
    raw.add_poi("Verkehrshaus der Schweiz", "Swiss Museum of Transport", "Museum", 62, CLASS_POI, "6006", "Luzern", ll(47.0528, 8.3365), 48);
    raw.add_poi("McDonald's", "", "Fast food", 28, CLASS_POI, "3011", "Bern", ll(46.9487, 7.4403), 52);
    // No address tags: the locality comes from the nearest addresses.
    raw.add_poi("Bundeshaus", "", "Government office", 48, CLASS_POI, "", "", ll(46.9465, 7.4442), 56);
    raw.add_poi("Gurten", "", "Peak", 36, CLASS_NATURE, "", "", ll(46.9173, 7.4438), 60);
    // Restaurants, found by what they serve as well as by name.
    raw.add_poi("Da Mario", "", "Restaurant", 33, CLASS_POI, "3011", "Bern", ll(46.9490, 7.4410), 64);
    raw.add_poi_info(&PoiInfo { cuisine: "Italian, Pizza".into(), website: "https://damario.example".into(), opening_hours: "Mo-Sa 11:00-23:00".into(), ..PoiInfo::default() }, "italian italienisch pizza pizzeria");
    raw.add_poi("Napoli", "", "Restaurant", 30, CLASS_POI, "8001", "Zürich", ll(47.3770, 8.5400), 68);
    raw.add_poi_info(&PoiInfo { cuisine: "Pizza".into(), ..PoiInfo::default() }, "pizza pizzeria");
    raw.add_poi("Sakura", "", "Restaurant", 30, CLASS_POI, "3011", "Bern", ll(46.9478, 7.4430), 72);
    raw.add_poi_info(&PoiInfo { cuisine: "Sushi, Japanese".into(), image: "https://commons.wikimedia.org/wiki/Special:FilePath/Sakura.jpg?width=400".into(), wikidata: "Q4242".into(), ..PoiInfo::default() }, "sushi japanese japanese japanisch");
    raw.add_poi("Tibits", "", "Restaurant", 33, CLASS_POI, "3011", "Bern", ll(46.9486, 7.4403), 76);
    raw.add_poi_info(&PoiInfo { diet: "Vegan options, Vegetarian".into(), ..PoiInfo::default() }, "vegan vegetarian vegetarisch");
    build_from_raw(&tt, &raw)
}

fn names(hits: &[Hit]) -> Vec<&str> {
    hits.iter().map(|h| h.name.as_str()).collect()
}

fn first(ix: &SearchIndex, q: &str) -> Hit {
    ix.search(q, None, 5).into_iter().next().unwrap_or_else(|| panic!("no result for {q:?}"))
}

#[test]
fn word_order_does_not_matter() {
    let ix = world();
    assert_eq!(first(&ix, "bern bahnhof").name, "Bern, Bahnhof");
    assert_eq!(first(&ix, "bahnhof bern").name, "Bern, Bahnhof");
    assert_eq!(first(&ix, "3 rue du mont-blanc genève").name, "Rue du Mont-Blanc 3");
    assert_eq!(first(&ix, "genève mont-blanc rue du 3").name, "Rue du Mont-Blanc 3");
}

#[test]
fn case_diacritics_and_swiss_spellings() {
    let ix = world();
    for q in ["zürich hb", "ZURICH HB", "zuerich hb", "zurich hbf", "Zürich Hauptbahnhof", "zurigo hb"] {
        assert_eq!(first(&ix, q).name, "Zürich HB", "{q}");
    }
    for q in ["geneve aero", "Genève-Aéroport", "genf flughafen", "geneva airport"] {
        assert_eq!(first(&ix, q).name, "Genève-Aéroport", "{q}");
    }
    for q in ["genf", "geneva", "geneve", "Genève"] {
        assert_eq!(first(&ix, q).name, "Genève", "{q}");
    }
    for q in ["st gallen", "st. gallen", "sankt gallen", "saint gallen", "sankt gal"] {
        assert_eq!(first(&ix, q).name, "St. Gallen", "{q}");
    }
    for q in ["bahnhofstr 10 zurich", "bahnhofstr. 10 zürich", "Bahnhofstrasse 10, 8001 Zürich", "bahnhofstraße 10 zuerich"] {
        let h = first(&ix, q);
        assert_eq!((h.name.as_str(), h.detail.as_str()), ("Bahnhofstrasse 10", "8001 Zürich"), "{q}");
    }
    // "Bahnhofstr." in the data is the same street as "Bahnhofstrasse" in the query.
    assert_eq!(first(&ix, "bahnhofstrasse 10 thun").detail, "3600 Thun");
    assert_eq!(first(&ix, "mcdonalds").name, "McDonald's");
    assert_eq!(first(&ix, "mcdonald's bern").name, "McDonald's");
}

#[test]
fn the_last_word_is_a_prefix_every_word_must_match() {
    let ix = world();
    assert_eq!(first(&ix, "bern bah").name, "Bern, Bahnhof");
    assert_eq!(first(&ix, "zyt").name, "Zytglogge");
    assert_eq!(first(&ix, "geneve aer").name, "Genève-Aéroport");
    // A longer first word also works as a prefix…
    assert_eq!(first(&ix, "uni bern").name, "Universität Bern");
    // …but nothing matches if a word matches nowhere.
    assert!(ix.search("bern xylophon", None, 5).is_empty());
    assert!(ix.search("", None, 5).is_empty());
    assert!(ix.search("  ,; ", None, 5).is_empty());
    assert!(ix.search("bern", None, 0).is_empty());
    assert_eq!(ix.search("b", None, 3).len(), 3);
}

#[test]
fn stations_rank_by_weight_and_exact_names_first() {
    let ix = world();
    let bern = ix.search("bern", None, 6);
    assert_eq!(bern[0].name, "Bern");
    assert_eq!(bern[0].kind, HitKind::Station);
    assert_eq!(bern[0].id, "st:8507000");
    assert_eq!(bern[0].station, Some(0));
    assert_eq!(bern[0].detail, "");
    assert_eq!(bern[1].name, "Bern, Bahnhof");
    // The city is offered too, after the big stations.
    let city = bern.iter().position(|h| h.kind == HitKind::Poi && h.name == "Bern").expect("city of Bern");
    assert!(city >= 2, "{:?}", names(&bern));
    assert_eq!(bern[city].detail, "City");

    assert_eq!(names(&ix.search("zurich", None, 2)), ["Zürich HB", "Zürich Oerlikon"]);
    assert_eq!(first(&ix, "z").name, "Zürich HB");
    // A canton suffix is not a name: "be" means Bern, not "Busswil BE".
    assert_eq!(names(&ix.search("be", None, 2)), ["Bern", "Bellinzona"]);
    // The stop's own name counts as a full match, busier stop first.
    assert_eq!(names(&ix.search("bundesplatz", None, 2)), ["Luzern, Bundesplatz", "Bern, Bundesplatz"]);
    assert_eq!(first(&ix, "wankdorf").name, "Bern Wankdorf");
    assert_eq!(first(&ix, "jungfraujoch").name, "Jungfraujoch");
    // Stations before places before streets for the same words.
    let k: Vec<HitKind> = ix.search("zytglogge", None, 5).iter().map(|h| h.kind).collect();
    assert_eq!(k, [HitKind::Poi, HitKind::Address]);
}

#[test]
fn rail_stations_answer_to_bahnhof_and_hb() {
    let ix = world();
    assert_eq!(first(&ix, "bern hb").name, "Bern");
    assert_eq!(names(&ix.search("bern bahnhof", None, 2)), ["Bern, Bahnhof", "Bern"]);
    assert_eq!(first(&ix, "gare genève").name, "Genève");
    assert_eq!(first(&ix, "basel hb").name, "Basel SBB");
}

#[test]
fn places_and_categories() {
    let ix = world();
    let z = first(&ix, "zytglogge");
    assert_eq!((z.kind, z.detail.as_str()), (HitKind::Poi, "Attraction · Bern"));
    assert_eq!(z.id, "poi:16");
    assert_eq!(z.station, None);
    // Most of the name typed beats an exact match on something obscure.
    assert_eq!(first(&ix, "paul klee").name, "Zentrum Paul Klee");
    // Name + locality.
    let v = ix.search("luzern verkehrshaus", None, 3);
    assert_eq!(v[0].name, "Verkehrshaus der Schweiz");
    assert_eq!(v[0].detail, "Museum · Luzern");
    assert_eq!(first(&ix, "coop thun").detail, "Supermarket · Thun");
    // Other names of a place, and the category word in another language.
    assert_eq!(first(&ix, "zeitglockenturm").name, "Zytglogge");
    assert_eq!(first(&ix, "apotheke").name, "Dr. Noyer");
    assert_eq!(first(&ix, "pharmacie bern").name, "Dr. Noyer");
    // A place without address tags gets its locality from the houses around it.
    assert_eq!(first(&ix, "bundeshaus").detail, "Government office · Bern");
    assert_eq!(first(&ix, "gurten").detail, "Peak · Bern");
    assert_eq!(first(&ix, "wabern").detail, "Village · 3011 Bern");
}

#[test]
fn house_numbers() {
    let ix = world();
    for q in ["bundesgasse 3 bern", "bundesgasse 3", "Bundesgasse 3, 3011 Bern", "3 bundesgasse", "bern bundesgasse 3", "bundesgasse 3 3011"] {
        let h = first(&ix, q);
        assert_eq!((h.kind, h.name.as_str(), h.detail.as_str()), (HitKind::Address, "Bundesgasse 3", "3011 Bern"), "{q}");
        assert!(h.id.starts_with("addr:"));
    }
    assert_eq!(first(&ix, "bundesgasse 3a").name, "Bundesgasse 3a");
    assert_eq!(first(&ix, "Bundesgasse 3A bern").name, "Bundesgasse 3a");
    // Still typing the number: the exact house, then 3a, then 30…39.
    let typing = ix.search("bundesgasse 3", None, 6);
    assert_eq!(names(&typing)[..2], ["Bundesgasse 3", "Bundesgasse 3a"]);
    assert!(typing[2..].iter().all(|h| h.name.starts_with("Bundesgasse 3") && h.name.len() == "Bundesgasse 30".len()), "{:?}", names(&typing));
    // Not the last word: only the exact house and its letter variants.
    let done = ix.search("bundesgasse 3 bern", None, 6);
    assert_eq!(names(&done), ["Bundesgasse 3", "Bundesgasse 3a"]);
    // A range is found by its first number.
    assert_eq!(first(&ix, "kornhausplatz 12").name, "Kornhausplatz 12-14");
    // An address query puts the address first even where a stop has the street's name.
    let k = ix.search("kornhausplatz 18", None, 3);
    assert_eq!((k[0].kind, k[0].name.as_str()), (HitKind::Address, "Kornhausplatz 18"));
    // Street name, number and postcode pick the right town.
    assert_eq!(first(&ix, "bahnhofstrasse 10 8001").detail, "8001 Zürich");
    assert_eq!(first(&ix, "bahnhofstrasse 10 biel").detail, "2502 Biel/Bienne");
    assert_eq!(ix.search("bahnhofstrasse 10", None, 5).iter().filter(|h| h.name == "Bahnhofstrasse 10").count(), 3);
    // A number that belongs to the street name.
    assert_eq!(first(&ix, "rue du 23 juin 5").name, "Rue du 23-Juin 5");
    assert_eq!(first(&ix, "rue du 23 juin").name, "Rue du 23-Juin");
    // The same house mapped twice is one result.
    assert_eq!(ix.search("bundesgasse 7 bern", None, 5).len(), 1);
}

#[test]
fn the_street_while_the_number_is_missing() {
    let ix = world();
    let s = ix.search("bundesgas", None, 5).into_iter().find(|h| h.kind == HitKind::Address).expect("street");
    assert_eq!((s.name.as_str(), s.detail.as_str()), ("Bundesgasse", "3011 Bern"));
    // Positioned at a house in the middle of the street, not at an end.
    assert!(s.pos.dist_m(&ll(46.9462, 7.4422)) < 150.0, "{:?}", s.pos);
    // One entry per street and locality.
    let streets: Vec<Hit> = ix.search("bahnhofstrasse", None, 10).into_iter().filter(|h| h.kind == HitKind::Address).collect();
    let mut towns: Vec<&str> = streets.iter().map(|h| h.detail.as_str()).collect();
    towns.sort();
    assert_eq!(towns, ["2502 Biel/Bienne", "3600 Thun", "8001 Zürich"]);
    // A number the street does not have: the street is offered instead.
    assert_eq!(first(&ix, "bundesgasse 999").name, "Bundesgasse");
    // A street known only from a named way.
    let z = first(&ix, "zytgloggelaube");
    assert_eq!((z.kind, z.detail.as_str()), (HitKind::Address, "3011 Bern"));
}

#[test]
fn missing_town_and_postcode_are_inherited() {
    let ix = world();
    assert_eq!(first(&ix, "bundesgasse 42").detail, "3011 Bern");
    assert_eq!(first(&ix, "schauplatzgasse 9").detail, "3011 Bern");
    assert_eq!(first(&ix, "schauplatzgasse 11").detail, "3011 Bern");
}

#[test]
fn typos() {
    let ix = world();
    for q in ["hirschengrabn", "hirschengrabenn", "hirschengarben", "hirschengrabem", "xirschengraben", "hirshengraben"] {
        assert_eq!(first(&ix, q).name, "Bern, Hirschengraben", "{q}");
    }
    assert_eq!(first(&ix, "zurihc hb").name, "Zürich HB");
    assert_eq!(first(&ix, "bundesgase 3 bern").name, "Bundesgasse 3");
    assert_eq!(first(&ix, "zytgloge").name, "Zytglogge");
    // A typo, and the word is not finished either.
    assert_eq!(first(&ix, "hirshengr").name, "Bern, Hirschengraben");
    // A correct query is not widened: nothing else is called Bellinzona.
    assert_eq!(names(&ix.search("bellinzona", None, 5)), ["Bellinzona"]);
    // The corrected match ranks below a real one.
    let exact = first(&ix, "hirschengraben").score;
    let fuzzy = first(&ix, "hirschengrabn").score;
    assert!(fuzzy < exact);
}

#[test]
fn proximity() {
    let ix = world();
    let near_bern = Some(ll(BERN.0, BERN.1));
    let near_zurich = Some(ll(ZURICH.0, ZURICH.1));
    assert_eq!(ix.search("coop", near_bern, 3)[0].detail, "Supermarket · Bern");
    assert_eq!(ix.search("coop", near_zurich, 3)[0].detail, "Supermarket · Zürich");
    assert_eq!(ix.search("coop", near_bern, 3).len(), 3);
    assert_eq!(ix.search("bahnhofstrasse 10", near_zurich, 3)[0].detail, "8001 Zürich");
    assert_eq!(ix.search("bahnhofstrasse 10", Some(ll(47.1340, 7.2440)), 3)[0].detail, "2502 Biel/Bienne");
    assert_eq!(ix.search("bundesplatz", near_bern, 3)[0].name, "Bern, Bundesplatz");
    let b = ix.search("bahnhof", near_bern, 3);
    assert!(names(&b)[..2].contains(&"Bern") && names(&b)[..2].contains(&"Bern, Bahnhof"), "{:?}", names(&b));
    // Being close does not bury an exact name elsewhere.
    assert_eq!(ix.search("bern", near_zurich, 3)[0].name, "Bern");
    assert_eq!(ix.search("genève", near_zurich, 3)[0].name, "Genève");
    // A one-letter query prefers what is around: the stop at Zürich's
    // Bahnhofstrasse before Bern and Basel.
    assert_eq!(ix.search("b", near_zurich, 5)[0].name, "Zürich, Bahnhofstrasse/HB");
    assert_eq!(ix.search("b", None, 5)[0].name, "Bern");
}

#[test]
fn resolve_returns_the_same_hit() {
    let ix = world();
    let mut seen = 0;
    for q in ["bern", "zurich hb", "bundesgasse 3", "bundesgasse", "coop", "zytglogge", "bahnhofstrasse 10", "gurten", "b", "wabern", "zytgloggelaube"] {
        for h in ix.search(q, None, 8) {
            let r = ix.resolve(&h.id).unwrap_or_else(|| panic!("resolve {}", h.id));
            assert_eq!((r.kind, &r.id, &r.name, &r.detail, r.pos, r.station), (h.kind, &h.id, &h.name, &h.detail, h.pos, h.station), "{q}");
            seen += 1;
        }
    }
    assert!(seen > 30);
    for bad in ["", "st:", "st:nope", "poi:", "poi:x", "poi:999999", "addr:", "addr:-1", "addr:99999998", "addr:99999999", "coord:1,2", "bern"] {
        assert!(ix.resolve(bad).is_none(), "{bad}");
    }
}

#[test]
fn reverse() {
    let ix = world();
    // On top of a house.
    let h = ix.reverse(ll(46.94622, 7.43862)).expect("house");
    assert_eq!((h.kind, h.name.as_str(), h.detail.as_str()), (HitKind::Address, "Bundesgasse 3", "3011 Bern"));
    assert!(h.score < 10.0);
    assert_eq!(ix.resolve(&h.id).map(|r| r.name), Some("Bundesgasse 3".to_string()));
    // 80 m from the nearest house, but on a named street.
    let s = ix.reverse(ll(46.9479, 7.4490)).expect("street");
    assert_eq!((s.name.as_str(), s.detail.as_str()), ("Zytgloggelaube", "3011 Bern"));
    // Open country: the nearest named place.
    let g = ix.reverse(ll(46.9180, 7.4440)).expect("place");
    assert_eq!(g.name, "Gurten");
    let w = ix.reverse(ll(46.9300, 7.4500)).expect("place");
    assert_eq!(w.name, "Wabern");
    // Far from everything.
    assert!(ix.reverse(ll(45.0, 12.0)).is_none());
    assert!(ix.reverse(LatLon::NONE).is_none());
}

#[test]
fn survives_the_cache_file() {
    let ix = world();
    let path = std::path::Path::new(env!("CARGO_TARGET_TMPDIR")).join("search-test.bin");
    kante_core::io::save(&path, kante_search::SEARCH_SCHEMA, &ix).unwrap();
    let back: SearchIndex = kante_core::io::load(&path, kante_search::SEARCH_SCHEMA).unwrap();
    std::fs::remove_file(&path).ok();
    assert_eq!(back.feed_version(), "test-feed");
    assert_eq!(back.station_count(), 17);
    for q in ["bern", "bundesgasse 3 bern", "coop", "hirschengrabn"] {
        assert_eq!(names(&back.search(q, None, 5)), names(&ix.search(q, None, 5)));
    }
    let st = back.stats();
    assert_eq!((st.stations, st.places, st.houses), (17, 19, 53));
    assert_eq!(back.search("da mario", None, 1)[0].info, ix.search("da mario", None, 1)[0].info);
    // Bundesgasse, Schauplatzgasse, Kornhausplatz, Bahnhofstrasse ×3, Mont-Blanc, 23-Juin, Zytgloggelaube.
    assert_eq!(st.streets, 9);
}

#[test]
fn stations_only_and_empty() {
    let tt = Timetable { stations: vec![station("1", "Bern", BERN.0, BERN.1, 5, true), station("2", "", 0.0, 0.0, 1, true)], ..Timetable::default() };
    let ix = kante_search::build(&tt, None, None).unwrap();
    assert_eq!(names(&ix.search("ber", None, 5)), ["Bern"]);
    assert!(ix.reverse(ll(BERN.0, BERN.1)).is_none());
    assert!(ix.resolve("st:2").is_none());
    let empty = kante_search::build(&Timetable::default(), None, None).unwrap();
    assert!(empty.search("bern", None, 5).is_empty());
    assert!(empty.reverse(ll(BERN.0, BERN.1)).is_none());
    assert!(empty.resolve("st:1").is_none());
    assert!(SearchIndex::default().search("bern", Some(ll(BERN.0, BERN.1)), 5).is_empty());
    assert!(SearchIndex::default().reverse(ll(BERN.0, BERN.1)).is_none());
}

#[test]
fn hostile_input() {
    let ix = world();
    let long = "bern ".repeat(5000);
    for q in ["\u{0}\u{1f}", "'''", "💥💥💥 bern", "a b c d e f g h i j k l m n o p", "99999999999999999999 bern", "bundesgasse 99999", long.as_str(), "ßßßß", "ǅǅ", "bern\u{1f}x"] {
        let _ = ix.search(q, Some(ll(BERN.0, BERN.1)), 10);
        let _ = ix.search(q, None, 10);
    }
    for id in ["addr:18446744073709551615", "poi:18446744073709551615", "addr:18446744073709551616"] {
        assert!(ix.resolve(id).is_none());
    }
    let _ = ix.reverse(LatLon { lat: i32::MAX, lon: i32::MIN + 1 });
    let _ = ix.search("bern", Some(LatLon { lat: i32::MAX, lon: i32::MAX }), 5);
}

#[test]
fn places_by_what_they_serve() {
    let ix = world();
    let bern = Some(ll(BERN.0, BERN.1));
    let zurich = Some(ll(ZURICH.0, ZURICH.1));
    // The pizzeria near you first, the other one too.
    assert_eq!(names(&ix.search("pizza", bern, 5)), ["Da Mario", "Napoli"]);
    assert_eq!(names(&ix.search("pizza", zurich, 5)), ["Napoli", "Da Mario"]);
    assert_eq!(first(&ix, "pizzeria zürich").name, "Napoli");
    assert_eq!(first(&ix, "sushi").name, "Sakura");
    assert_eq!(first(&ix, "japanisch").name, "Sakura");
    assert_eq!(first(&ix, "vegan").name, "Tibits");
    // the category's own name, in words
    assert_eq!(first(&ix, "fast food").name, "McDonald's");
    // A category word finds every restaurant, nearest first.
    let found = ix.search("restaurant", bern, 10);
    let near = names(&found);
    assert_eq!(&near[..3], ["Tibits", "Da Mario", "Sakura"]);
    assert!(near.contains(&"Napoli"));
    // A short prefix is not yet a cuisine ("pi" is not "pizza").
    assert!(!names(&ix.search("pi", bern, 10)).contains(&"Da Mario"));
}

#[test]
fn places_carry_icon_category_and_details() {
    let ix = world();
    let h = first(&ix, "da mario");
    assert_eq!((h.kind, h.icon.as_str(), h.category.as_str()), (HitKind::Poi, "restaurant", "Restaurant"));
    let info = h.info.as_deref().expect("details");
    assert_eq!(info.cuisine, "Italian, Pizza");
    assert_eq!(info.website, "https://damario.example");
    assert_eq!(info.opening_hours, "Mo-Sa 11:00-23:00");
    assert!(info.image.is_empty());
    // the same details from its id, and from a search near by
    assert_eq!(ix.resolve(&h.id).and_then(|r| r.info).as_deref(), Some(info));
    let s = first(&ix, "sakura");
    assert_eq!(s.info.as_ref().map(|i| (i.image.as_str(), i.wikidata.as_str())), Some(("https://commons.wikimedia.org/wiki/Special:FilePath/Sakura.jpg?width=400", "Q4242")));
    // a place without details has none
    assert!(first(&ix, "zytglogge").info.is_none());
    assert_eq!(first(&ix, "zytglogge").icon, "sight");
    assert_eq!(first(&ix, "dr noyer").icon, "pharmacy");
    assert_eq!(first(&ix, "gurten").icon, "mountain");
    assert_eq!(first(&ix, "wabern").icon, "village");
    assert_eq!(first(&ix, "zürich hb").icon, "station");
    assert_eq!(first(&ix, "bundesgasse 3").icon, "address");
    let other = ix.search("coop", None, 5);
    assert!(other.iter().all(|h| h.icon == "grocery" && h.category == "Supermarket" && h.info.is_none()));
}
