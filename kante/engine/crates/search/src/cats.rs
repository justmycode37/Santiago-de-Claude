//! OSM tags → what a traveller would call the thing, and how prominent it is.
//!
//! `classify` picks one human category label and a base prominence (0..=70,
//! same scale as the station scores) from the tags of a named OSM object.
//! Public-transport objects are deliberately absent: stations and stops come
//! from the timetable.

use std::borrow::Cow;

/// The tags we look at, borrowed from the PBF block. Absent = "".
#[derive(Default, Clone, Copy)]
pub struct Tags<'a> {
    pub name: &'a str,
    pub brand: &'a str,
    pub operator: &'a str,
    pub short_name: &'a str,
    pub alt_name: &'a str,
    pub official_name: &'a str,
    pub loc_name: &'a str,
    pub old_name: &'a str,
    pub name_de: &'a str,
    pub name_fr: &'a str,
    pub name_it: &'a str,
    pub name_en: &'a str,
    pub name_rm: &'a str,

    pub hn: &'a str,
    pub street: &'a str,
    pub addr_place: &'a str,
    pub city: &'a str,
    pub postcode: &'a str,

    pub amenity: &'a str,
    pub shop: &'a str,
    pub tourism: &'a str,
    pub leisure: &'a str,
    pub office: &'a str,
    pub healthcare: &'a str,
    pub craft: &'a str,
    pub historic: &'a str,
    pub place: &'a str,
    pub natural: &'a str,
    pub aeroway: &'a str,
    pub man_made: &'a str,
    pub building: &'a str,
    pub highway: &'a str,
    pub railway: &'a str,
    pub public_transport: &'a str,
    pub waterway: &'a str,
    pub landuse: &'a str,
    pub mountain_pass: &'a str,
    pub information: &'a str,
    pub water: &'a str,
    pub religion: &'a str,
    pub access: &'a str,
    pub tower_type: &'a str,
    pub wikidata: &'a str,
    pub wikipedia: &'a str,
    pub population: &'a str,
    pub typ: &'a str,
}

impl<'a> Tags<'a> {
    pub fn collect(it: impl Iterator<Item = (&'a str, &'a str)>) -> Tags<'a> {
        let mut t = Tags::default();
        for (k, v) in it {
            match k {
                "name" => t.name = v,
                "brand" => t.brand = v,
                "operator" => t.operator = v,
                "short_name" => t.short_name = v,
                "alt_name" => t.alt_name = v,
                "official_name" => t.official_name = v,
                "loc_name" => t.loc_name = v,
                "old_name" => t.old_name = v,
                "name:de" => t.name_de = v,
                "name:fr" => t.name_fr = v,
                "name:it" => t.name_it = v,
                "name:en" => t.name_en = v,
                "name:rm" => t.name_rm = v,
                "addr:housenumber" => t.hn = v,
                "addr:street" => t.street = v,
                "addr:place" => t.addr_place = v,
                "addr:city" => t.city = v,
                "addr:postcode" => t.postcode = v,
                "amenity" => t.amenity = v,
                "shop" => t.shop = v,
                "tourism" => t.tourism = v,
                "leisure" => t.leisure = v,
                "office" => t.office = v,
                "healthcare" => t.healthcare = v,
                "craft" => t.craft = v,
                "historic" => t.historic = v,
                "place" => t.place = v,
                "natural" => t.natural = v,
                "aeroway" => t.aeroway = v,
                "man_made" => t.man_made = v,
                "building" => t.building = v,
                "highway" => t.highway = v,
                "railway" => t.railway = v,
                "public_transport" => t.public_transport = v,
                "waterway" => t.waterway = v,
                "landuse" => t.landuse = v,
                "mountain_pass" => t.mountain_pass = v,
                "information" => t.information = v,
                "water" => t.water = v,
                "religion" => t.religion = v,
                "access" => t.access = v,
                "tower:type" => t.tower_type = v,
                "wikidata" => t.wikidata = v,
                "wikipedia" => t.wikipedia = v,
                "population" => t.population = v,
                "type" => t.typ = v,
                _ => {}
            }
        }
        t
    }
}

/// What kind of entry a POI is, for the detail line.
pub const CLASS_POI: u8 = 0;
/// City or town: the detail is just the kind.
pub const CLASS_PLACE_MAJOR: u8 = 1;
/// Village, quarter, hamlet …: the detail carries the postcode / parent town.
pub const CLASS_PLACE_MINOR: u8 = 2;
/// Mountains, lakes and other landscape features.
pub const CLASS_NATURE: u8 = 3;

pub struct Class {
    pub label: Cow<'static, str>,
    pub score: u8,
    pub class: u8,
}

fn c(label: &'static str, score: u8) -> Option<Class> {
    Some(Class { label: Cow::Borrowed(label), score, class: CLASS_POI })
}

/// "bicycle_rental" → "Bicycle rental".
fn humanize(v: &str) -> String {
    let mut s = String::with_capacity(v.len());
    for (i, ch) in v.chars().enumerate() {
        if i == 0 {
            s.extend(ch.to_uppercase());
        } else if ch == '_' {
            s.push(' ');
        } else {
            s.push(ch);
        }
    }
    s
}

fn generic(v: &str, suffix: &str, score: u8) -> Option<Class> {
    if v.is_empty() || v == "yes" || v == "no" || v.len() > 30 || v.contains(';') {
        return None;
    }
    let mut label = humanize(v);
    label.push_str(suffix);
    Some(Class { label: Cow::Owned(label), score, class: CLASS_POI })
}

fn place(t: &Tags) -> Option<Class> {
    let (label, base, class): (&'static str, f32, u8) = match t.place {
        "city" => ("City", 70.0, CLASS_PLACE_MAJOR),
        "town" => ("Town", 60.0, CLASS_PLACE_MAJOR),
        "village" => ("Village", 52.0, CLASS_PLACE_MINOR),
        "suburb" => ("Suburb", 46.0, CLASS_PLACE_MINOR),
        "quarter" => ("Quarter", 44.0, CLASS_PLACE_MINOR),
        "neighbourhood" => ("Neighbourhood", 40.0, CLASS_PLACE_MINOR),
        "hamlet" => ("Hamlet", 40.0, CLASS_PLACE_MINOR),
        "isolated_dwelling" => ("Dwelling", 26.0, CLASS_PLACE_MINOR),
        "farm" => ("Farm", 24.0, CLASS_PLACE_MINOR),
        "locality" => ("Locality", 26.0, CLASS_PLACE_MINOR),
        "square" => ("Square", 40.0, CLASS_POI),
        "island" => ("Island", 36.0, CLASS_NATURE),
        "islet" => ("Island", 26.0, CLASS_NATURE),
        _ => return None,
    };
    // Population nudges places of the same kind: ±4 around the kind's base.
    let mut score = base;
    if matches!(t.place, "city" | "town" | "village") {
        if let Ok(pop) = t.population.trim().parse::<f32>() {
            let typical: f32 = match t.place {
                "city" => 120_000.0,
                "town" => 15_000.0,
                _ => 1_500.0,
            };
            score += (2.5 * (pop.max(1.0) / typical).log10()).clamp(-4.0, 4.0);
        }
    }
    Some(Class { label: Cow::Borrowed(label), score: score.round() as u8, class })
}

fn amenity(t: &Tags) -> Option<Class> {
    match t.amenity {
        "restaurant" => c("Restaurant", 30),
        "cafe" => c("Café", 30),
        "bar" => c("Bar", 28),
        "pub" => c("Pub", 28),
        "fast_food" => c("Fast food", 28),
        "biergarten" => c("Beer garden", 28),
        "ice_cream" => c("Ice cream", 26),
        "food_court" => c("Food court", 30),
        "hospital" => c("Hospital", 50),
        "clinic" => c("Clinic", 40),
        "doctors" => c("Doctor", 28),
        "dentist" => c("Dentist", 26),
        "pharmacy" => c("Pharmacy", 32),
        "veterinary" => c("Vet", 24),
        "university" => c("University", 50),
        "college" => c("College", 42),
        "school" => c("School", 36),
        "kindergarten" => c("Kindergarten", 26),
        "library" => c("Library", 38),
        "music_school" => c("Music school", 26),
        "language_school" => c("Language school", 24),
        "driving_school" => c("Driving school", 22),
        "townhall" => c("Town hall", 42),
        "courthouse" => c("Courthouse", 36),
        "police" => c("Police", 36),
        "fire_station" => c("Fire station", 30),
        "post_office" => c("Post office", 36),
        "embassy" => c("Embassy", 34),
        "community_centre" => c("Community centre", 32),
        "social_facility" => c("Social facility", 26),
        "place_of_worship" => match t.religion {
            "christian" => c("Church", 34),
            "muslim" => c("Mosque", 34),
            "jewish" => c("Synagogue", 34),
            "buddhist" | "hindu" => c("Temple", 34),
            _ => c("Place of worship", 32),
        },
        "monastery" => c("Monastery", 38),
        "theatre" => c("Theatre", 44),
        "cinema" => c("Cinema", 40),
        "arts_centre" => c("Arts centre", 38),
        "nightclub" => c("Nightclub", 30),
        "casino" => c("Casino", 36),
        "conference_centre" => c("Conference centre", 40),
        "exhibition_centre" => c("Exhibition centre", 44),
        "events_venue" => c("Event venue", 36),
        "bank" => c("Bank", 30),
        "bureau_de_change" => c("Currency exchange", 26),
        "fuel" => c("Petrol station", 28),
        "charging_station" => c("Charging station", 20),
        "car_rental" => c("Car rental", 30),
        "car_sharing" => c("Car sharing", 22),
        "bicycle_rental" => c("Bike rental", 26),
        "parking" => c("Car park", 24),
        "parking_entrance" => c("Car park entrance", 20),
        "taxi" => c("Taxi rank", 24),
        "marketplace" => c("Market", 36),
        "fountain" => c("Fountain", 24),
        "public_bath" => c("Public bath", 30),
        "childcare" => c("Childcare", 22),
        "nursing_home" | "retirement_home" => c("Care home", 28),
        "prison" => c("Prison", 26),
        "grave_yard" => c("Cemetery", 26),
        "crematorium" => c("Crematorium", 24),
        "shelter" => c("Shelter", 20),
        "studio" => c("Studio", 22),
        "ski_school" => c("Ski school", 26),
        "boat_rental" => c("Boat rental", 26),
        "swimming_pool" => c("Swimming pool", 32),
        "dojo" => c("Dojo", 22),
        // Street furniture and things nobody travels to; stops come from the timetable.
        "bench" | "waste_basket" | "waste_disposal" | "recycling" | "vending_machine" | "telephone" | "post_box"
        | "bicycle_parking" | "motorcycle_parking" | "parking_space" | "drinking_water" | "toilets" | "atm"
        | "clock" | "hunting_stand" | "bbq" | "grit_bin" | "shower" | "watering_place" | "water_point"
        | "feeding_place" | "game_feeding" | "letter_box" | "table" | "lounger" | "compressed_air"
        | "bicycle_repair_station" | "give_box" | "public_bookcase" | "loading_dock" | "trolley_bay"
        | "photo_booth" | "bus_station" | "ferry_terminal" | "vacuum_cleaner" | "sanitary_dump_station"
        | "smoking_area" | "kneipp_water_cure" | "weighbridge" | "device_charging_station" | "parcel_locker"
        | "" => None,
        v => generic(v, "", 22),
    }
}

fn tourism(t: &Tags) -> Option<Class> {
    match t.tourism {
        "museum" => c("Museum", 48),
        "attraction" => c("Attraction", 46),
        "zoo" => c("Zoo", 50),
        "theme_park" => c("Theme park", 48),
        "aquarium" => c("Aquarium", 46),
        "gallery" => c("Gallery", 34),
        "viewpoint" => c("Viewpoint", 34),
        "hotel" => c("Hotel", 34),
        "hostel" => c("Hostel", 32),
        "motel" => c("Motel", 28),
        "guest_house" => c("Guest house", 26),
        "apartment" => c("Holiday apartment", 18),
        "chalet" => c("Chalet", 16),
        "alpine_hut" => c("Mountain hut", 38),
        "wilderness_hut" => c("Hut", 26),
        "camp_site" => c("Campsite", 32),
        "caravan_site" => c("Caravan site", 26),
        "picnic_site" => c("Picnic site", 20),
        "artwork" => c("Artwork", 22),
        "information" => match t.information {
            "office" | "visitor_centre" => c("Tourist information", 36),
            _ => None, // guideposts, boards, maps: tens of thousands of hiking signs
        },
        "" | "yes" => None,
        v => generic(v, "", 22),
    }
}

fn leisure(t: &Tags) -> Option<Class> {
    match t.leisure {
        "stadium" => c("Stadium", 46),
        "sports_centre" => c("Sports centre", 36),
        "sports_hall" => c("Sports hall", 32),
        "swimming_pool" => {
            if t.access == "private" {
                None
            } else {
                c("Swimming pool", 32)
            }
        }
        "water_park" => c("Water park", 42),
        "ice_rink" => c("Ice rink", 38),
        "park" => c("Park", 38),
        "garden" => c("Garden", 28),
        "nature_reserve" => c("Nature reserve", 34),
        "golf_course" => c("Golf course", 34),
        "marina" => c("Marina", 30),
        "fitness_centre" => c("Gym", 26),
        "playground" => c("Playground", 20),
        "pitch" => c("Sports pitch", 18),
        "track" => c("Sports track", 18),
        "miniature_golf" => c("Minigolf", 26),
        "dog_park" => c("Dog park", 20),
        "horse_riding" => c("Riding centre", 22),
        "bowling_alley" => c("Bowling", 26),
        "beach_resort" => c("Lido", 34),
        "bathing_place" => c("Bathing place", 30),
        "dance" => c("Dance venue", 22),
        "escape_game" => c("Escape room", 24),
        "sauna" => c("Sauna", 26),
        "common" => c("Common", 22),
        "firepit" => c("Fire pit", 16),
        "picnic_table" | "slipway" | "outdoor_seating" | "bleachers" | "hackerspace" | "" => None,
        v => generic(v, "", 20),
    }
}

fn shop(t: &Tags) -> Option<Class> {
    match t.shop {
        "supermarket" => c("Supermarket", 34),
        "mall" => c("Shopping centre", 44),
        "department_store" => c("Department store", 40),
        "convenience" => c("Convenience store", 26),
        "bakery" => c("Bakery", 26),
        "kiosk" => c("Kiosk", 22),
        "butcher" => c("Butcher", 24),
        "chemist" => c("Chemist", 26),
        "clothes" => c("Clothes shop", 24),
        "books" => c("Bookshop", 26),
        "electronics" => c("Electronics shop", 26),
        "bicycle" => c("Bike shop", 26),
        "sports" => c("Sports shop", 26),
        "outdoor" => c("Outdoor shop", 26),
        "hairdresser" => c("Hairdresser", 20),
        "beauty" => c("Beauty salon", 20),
        "florist" => c("Florist", 22),
        "optician" => c("Optician", 22),
        "jewelry" => c("Jeweller", 22),
        "travel_agency" => c("Travel agency", 24),
        "car" => c("Car dealer", 22),
        "car_repair" => c("Car repair", 22),
        "furniture" => c("Furniture shop", 24),
        "shoes" => c("Shoe shop", 24),
        "laundry" => c("Laundry", 22),
        "dry_cleaning" => c("Dry cleaner", 20),
        "gift" => c("Gift shop", 22),
        "toys" => c("Toy shop", 24),
        "hardware" | "doityourself" => c("DIY store", 28),
        "garden_centre" => c("Garden centre", 26),
        "alcohol" | "wine" => c("Wine shop", 22),
        "beverages" => c("Drinks shop", 22),
        "cheese" => c("Cheese shop", 24),
        "chocolate" => c("Chocolate shop", 24),
        "confectionery" | "pastry" => c("Confectionery", 24),
        "deli" => c("Delicatessen", 24),
        "farm" => c("Farm shop", 22),
        "greengrocer" => c("Greengrocer", 22),
        "mobile_phone" => c("Phone shop", 22),
        "computer" => c("Computer shop", 22),
        "stationery" => c("Stationery shop", 22),
        "newsagent" => c("Newsagent", 22),
        "tobacco" => c("Tobacconist", 20),
        "variety_store" => c("Variety store", 24),
        "second_hand" | "charity" => c("Second-hand shop", 22),
        "pet" => c("Pet shop", 22),
        "ticket" => c("Ticket office", 30),
        "vacant" | "no" | "" => None,
        _ => c("Shop", 22),
    }
}

fn healthcare(t: &Tags) -> Option<Class> {
    match t.healthcare {
        "hospital" => c("Hospital", 48),
        "clinic" => c("Clinic", 38),
        "doctor" => c("Doctor", 28),
        "dentist" => c("Dentist", 26),
        "pharmacy" => c("Pharmacy", 30),
        "physiotherapist" => c("Physiotherapist", 22),
        "psychotherapist" => c("Psychotherapist", 20),
        "optometrist" => c("Optometrist", 22),
        "laboratory" => c("Medical laboratory", 22),
        "" => None,
        _ => c("Health care", 22),
    }
}

fn historic(t: &Tags) -> Option<Class> {
    match t.historic {
        "castle" => c("Castle", 46),
        "monument" => c("Monument", 36),
        "memorial" => c("Memorial", 24),
        "ruins" => c("Ruins", 32),
        "archaeological_site" => c("Archaeological site", 30),
        "church" => c("Church", 36),
        "monastery" => c("Monastery", 40),
        "fort" => c("Fort", 36),
        "city_gate" => c("City gate", 38),
        "tower" => c("Historic tower", 34),
        "manor" => c("Manor", 34),
        "building" => c("Historic building", 28),
        "wayside_cross" | "wayside_shrine" => c("Wayside shrine", 14),
        "boundary_stone" | "milestone" | "" | "no" => None,
        _ => c("Historic site", 24),
    }
}

fn natural(t: &Tags) -> Option<Class> {
    let n = |label, score| Some(Class { label: Cow::Borrowed(label), score, class: CLASS_NATURE });
    match t.natural {
        "peak" => n("Peak", 36),
        "volcano" => n("Peak", 36),
        "saddle" => n("Mountain pass", 32),
        "glacier" => n("Glacier", 36),
        "water" => match t.water {
            "river" | "canal" | "stream" | "ditch" | "drain" | "basin" | "wastewater" | "moat" | "fountain" => None,
            "pond" => n("Pond", 22),
            "reservoir" => n("Reservoir", 36),
            _ => n("Lake", 40),
        },
        "cave_entrance" => n("Cave", 28),
        "beach" => n("Beach", 30),
        "bay" => n("Bay", 26),
        "cape" => n("Headland", 24),
        "valley" => n("Valley", 30),
        "gorge" => n("Gorge", 30),
        "ridge" => n("Ridge", 24),
        "hot_spring" => n("Hot spring", 30),
        "wood" => n("Forest", 22),
        _ => None,
    }
}

/// Buildings that are destinations in their own right.
fn building(t: &Tags) -> Option<Class> {
    match t.building {
        "church" | "cathedral" | "chapel" => c("Church", 30),
        "mosque" => c("Mosque", 30),
        "synagogue" => c("Synagogue", 30),
        "university" | "college" => c("University building", 34),
        "school" => c("School", 30),
        "hospital" => c("Hospital", 40),
        "public" | "civic" | "government" => c("Public building", 32),
        "stadium" | "grandstand" => c("Stadium", 36),
        "sports_hall" | "sports_centre" => c("Sports hall", 30),
        "museum" => c("Museum", 40),
        "hotel" => c("Hotel", 30),
        "castle" => c("Castle", 40),
        "commercial" | "retail" | "office" => c("Building", 20),
        "train_station" | "transportation" | "" | "no" => None,
        _ => {
            if t.wikidata.is_empty() {
                None
            } else {
                c("Building", 28)
            }
        }
    }
}

fn man_made(t: &Tags) -> Option<Class> {
    match t.man_made {
        "tower" => {
            if t.tower_type == "observation" {
                c("Observation tower", 34)
            } else if matches!(t.tower_type, "communication" | "" | "bell_tower" | "cooling" | "watchtower") {
                c("Tower", 24)
            } else {
                None
            }
        }
        "bridge" => c("Bridge", 30),
        "observatory" => c("Observatory", 34),
        "lighthouse" => c("Lighthouse", 30),
        "pier" => c("Pier", 22),
        _ => None,
    }
}

/// Category of a named object, or `None` if it is not something to search for.
pub fn classify(t: &Tags) -> Option<Class> {
    // Timetable territory.
    if !t.public_transport.is_empty() || matches!(t.railway, "station" | "halt" | "tram_stop" | "stop" | "platform") {
        // …unless the object is clearly also something else (a shop on a platform keeps its shop tag).
        if t.shop.is_empty() && t.tourism.is_empty() && !matches!(t.amenity, "restaurant" | "cafe" | "fast_food" | "bar") {
            return None;
        }
    }
    let mut cls = place(t)
        .or_else(|| match t.aeroway {
            "aerodrome" => c("Airport", 52),
            "terminal" => c("Airport terminal", 46),
            "heliport" => c("Heliport", 24),
            _ => None,
        })
        .or_else(|| tourism(t))
        .or_else(|| amenity(t))
        .or_else(|| leisure(t))
        .or_else(|| shop(t))
        .or_else(|| healthcare(t))
        .or_else(|| historic(t))
        .or_else(|| {
            if t.mountain_pass == "yes" {
                Some(Class { label: Cow::Borrowed("Mountain pass"), score: 40, class: CLASS_NATURE })
            } else {
                None
            }
        })
        .or_else(|| natural(t))
        .or_else(|| {
            if t.waterway == "waterfall" {
                Some(Class { label: Cow::Borrowed("Waterfall"), score: 34, class: CLASS_NATURE })
            } else {
                None
            }
        })
        .or_else(|| match t.office {
            "" | "no" | "vacant" => None,
            "government" | "administrative" => c("Government office", 34),
            "diplomatic" => c("Embassy", 34),
            "company" => c("Company", 20),
            "insurance" => c("Insurance", 20),
            "lawyer" | "notary" => c("Law office", 20),
            "estate_agent" => c("Estate agent", 20),
            "association" | "ngo" | "foundation" => c("Organisation", 22),
            "educational_institution" => c("Educational institution", 26),
            "employment_agency" => c("Employment agency", 22),
            _ => c("Office", 20),
        })
        .or_else(|| match t.craft {
            "" | "no" => None,
            "brewery" => c("Brewery", 28),
            "winery" => c("Winery", 28),
            v => generic(v, "", 18),
        })
        .or_else(|| man_made(t))
        .or_else(|| match t.highway {
            "services" => c("Motorway services", 30),
            "rest_area" => c("Rest area", 26),
            _ => None,
        })
        .or_else(|| match t.landuse {
            "cemetery" => c("Cemetery", 28),
            "winter_sports" => c("Ski area", 36),
            _ => None,
        })
        .or_else(|| building(t))?;
    // The one cheap "well-known" signal OSM has: somebody linked a Wikidata item.
    if cls.class == CLASS_POI || cls.class == CLASS_NATURE {
        if !t.wikidata.is_empty() {
            cls.score += 14;
        } else if !t.wikipedia.is_empty() {
            cls.score += 12;
        }
        cls.score = cls.score.min(68);
    }
    Some(cls)
}

/// What people type when they mean the category, in the four languages a
/// Swiss traveller might use. Indexed as alternative-name words, so
/// "apotheke" finds a pharmacy called "Dr. Noyer".
pub fn keywords(label: &str) -> &'static str {
    match label {
        "Pharmacy" => "apotheke pharmacie farmacia pharmacy",
        "Hospital" => "spital hôpital ospedale krankenhaus hospital",
        "Clinic" => "klinik clinique clinica",
        "Doctor" => "arzt praxis médecin medico doctor",
        "Dentist" => "zahnarzt dentiste dentista",
        "Post office" => "post poste posta",
        "Supermarket" => "supermarkt supermarché supermercato supermarket",
        "Restaurant" => "restaurant ristorante",
        "Café" => "cafe kaffee",
        "Fast food" => "imbiss takeaway",
        "Hotel" => "hotel",
        "Hostel" => "hostel jugendherberge",
        "Bank" => "bank banque banca",
        "Police" => "polizei police polizia",
        "Museum" => "museum musée museo",
        "Car park" => "parking parkhaus parkplatz",
        "Petrol station" => "tankstelle benzin essence benzina",
        "School" => "schule école scuola",
        "University" => "universität université università uni hochschule",
        "Library" => "bibliothek bibliothèque biblioteca",
        "Cinema" => "kino cinéma cinema",
        "Theatre" => "theater théâtre teatro",
        "Bakery" => "bäckerei boulangerie panetteria",
        "Church" => "kirche église chiesa",
        "Castle" => "schloss burg château castello",
        "Lake" => "see lac lago",
        "Peak" => "berg gipfel",
        "Viewpoint" => "aussichtspunkt aussicht",
        "Swimming pool" => "schwimmbad hallenbad freibad badi piscine piscina",
        "Lido" => "strandbad badi",
        "Playground" => "spielplatz",
        "Zoo" => "zoo tierpark",
        "Stadium" => "stadion stade stadio",
        "Town hall" => "rathaus gemeindehaus mairie municipio",
        "Bike rental" => "veloverleih velo bike",
        "Car sharing" => "carsharing",
        "Car rental" => "autovermietung mietwagen",
        "Taxi rank" => "taxi",
        "Hairdresser" => "coiffeur friseur",
        "Charging station" => "ladestation",
        "Shopping centre" => "einkaufszentrum shopping",
        "Mountain hut" => "hütte berghütte cabane capanna",
        "Campsite" => "camping campingplatz",
        "Tourist information" => "tourismus tourist info",
        "Airport" => "flughafen aéroport aeroporto airport",
        "Fire station" => "feuerwehr",
        "Cemetery" => "friedhof cimetière cimitero",
        "Gym" => "fitness",
        "Ticket office" => "billett ticket",
        "Embassy" => "botschaft ambassade",
        "Market" => "markt marché mercato",
        "Ski area" => "skigebiet",
        "Mountain pass" => "pass col passo",
        "Glacier" => "gletscher",
        "Waterfall" => "wasserfall cascade",
        "Bookshop" => "buchhandlung librairie",
        "Florist" => "blumen fleuriste",
        "Butcher" => "metzgerei boucherie",
        "Optician" => "optiker",
        "Chemist" => "drogerie",
        "Kiosk" => "kiosk",
        _ => "",
    }
}

/// Named ways of these classes become searchable streets.
pub fn is_street(highway: &str) -> bool {
    matches!(
        highway,
        "primary"
            | "secondary"
            | "tertiary"
            | "unclassified"
            | "residential"
            | "living_street"
            | "pedestrian"
            | "service"
            | "footway"
            | "path"
            | "steps"
            | "cycleway"
            | "track"
            | "trunk"
            | "road"
            | "primary_link"
            | "secondary_link"
            | "tertiary_link"
            | "bridleway"
    )
}
