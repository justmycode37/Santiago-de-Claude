// How the OSM builders sort an OpenStreetMap object into a category: one source of truth for the Bern builds
// (tools/build-places.mts, tools/build-amenities.mts) and the Switzerland-wide one (tools/build-places-ch.mts).

/** The tags of an OpenStreetMap object, key → value ("amenity" → "cafe"); a tag the object lacks reads as undefined. */
export type OsmTags = Record<string, string>;

// ---- Places (data/places.json, data/ch/osm-places-<group>.json.gz): Google-Maps-style places ----

/** The eight kinds of place the places files are grouped by. */
export type PlaceGroup = "lodging" | "health" | "food_drink" | "attractions_culture" | "worship" | "shopping" | "services" | "leisure_sport";

const set = (s: string) => new Set(s.split(" "));
export const LODGING = set("hotel hostel guest_house apartment motel camp_site caravan_site chalet alpine_hut");
export const HEALTH_AMENITY = set("doctors dentist pharmacy hospital clinic veterinary");
export const FOOD_AMENITY = set("restaurant cafe fast_food bar pub biergarten ice_cream food_court nightclub");
export const FOOD_SHOP = set("bakery pastry confectionery deli butcher cheese chocolate coffee tea wine alcohol beverages greengrocer farm health_food seafood");
export const CULTURE_AMENITY = set("theatre cinema arts_centre library events_venue conference_centre music_venue casino planetarium");
export const CULTURE_TOURISM = set("attraction museum gallery viewpoint artwork zoo theme_park aquarium");
export const SERVICE_AMENITY = set("post_office bank car_rental car_wash fuel charging_station courthouse childcare kindergarten school university college language_school driving_school music_school dancing_school prep_school research_institute community_centre social_facility social_centre police fire_station townhall bureau_de_change money_transfer bicycle_rental car_sharing");
export const LEISURE = set("park garden sports_centre fitness_centre swimming_pool stadium ice_rink pitch dog_park nature_reserve water_park miniature_golf bowling_alley sauna golf_course escape_game amusement_arcade dance horse_riding sports_hall marina");
export const PRIVATE = set("private no permit residents employees delivery agricultural forestry");
/** Places kept without a name; everything else must have one. */
export const UNNAMED_OK = set("parking fuel charging_station");
/** A set as an Overpass value regex: "^(a|b|c)$" with its quotes. */
export const rx = (s: Set<string> | string[]) => `"^(${[...s].join("|")})$"`;

// Precedence (first match wins): lodging > health amenity > food amenity/shop > culture amenity/tourism > worship >
// marketplace > services (amenity, office=coworking/diplomatic, shop=car/car_repair) > leisure > other shop > healthcare=* > office=* > craft=* > historic=*.
export function categorizePlace(t: OsmTags): [group: PlaceGroup, category: string] | null {
  const a = t.amenity, priv = PRIVATE.has(t.access);
  if (LODGING.has(t.tourism)) return ["lodging", t.tourism];
  if (HEALTH_AMENITY.has(a)) return ["health", a];
  if (FOOD_AMENITY.has(a)) return ["food_drink", a];
  if (FOOD_SHOP.has(t.shop)) return ["food_drink", t.shop];
  if (CULTURE_AMENITY.has(a)) return ["attractions_culture", a];
  if (CULTURE_TOURISM.has(t.tourism)) return ["attractions_culture", t.tourism];
  if (t.tourism === "information" && t.information === "office") return ["attractions_culture", "tourist_information"];
  if (a === "place_of_worship") return ["worship", "place_of_worship"];
  if (a === "marketplace") return ["shopping", "marketplace"];
  if (a === "parking") return !priv && (t.capacity || t.name) ? ["services", "parking"] : null;
  if (a === "recycling" && t.recycling_type === "centre") return ["services", "recycling_centre"];
  if (a === "coworking_space" || t.office === "coworking") return ["services", "coworking"];
  if (a === "embassy" || t.office === "diplomatic") return ["services", "embassy"];
  if (SERVICE_AMENITY.has(a)) return ["services", a];
  if (t.shop === "car" || t.shop === "car_repair") return ["services", t.shop];
  if (LEISURE.has(t.leisure)) return priv ? null : ["leisure_sport", t.leisure];
  if (t.shop && t.shop !== "vacant" && t.shop !== "no") return ["shopping", t.shop];
  if (t.healthcare) return ["health", t.healthcare];
  if (t.office) return ["services", t.office];
  if (t.craft) return ["services", t.craft];
  if (t.historic) return ["attractions_culture", t.historic];
  return null;
}

// ---- Amenities (data/amenities.json, data/ch/osm-<category>.json, data/ch/osm-places-amenities.json.gz) ----

/** amenity=<value> that becomes category <value> as-is */
export const AMENITY_SAME = ["bench", "shelter", "shower", "post_office", "post_box", "bank", "bureau_de_change", "money_transfer", "police", "townhall",
  "social_facility", "place_of_worship", "dentist", "veterinary", "telephone", "public_bookcase", "bicycle_repair_station", "bicycle_parking",
  "recycling", "water_point", "internet_cafe", "car_sharing", "taxi", "bicycle_rental", "food_sharing", "give_box", "embassy"];
export const LOCKERS = ["locker", "lockers", "luggage_locker"];

// First match wins, so a library with free wifi stays a library (shortcut: one category per element).
// New categories come after wifi so every element categorized by the old build keeps its category.
export function categorizeAmenity(t: OsmTags) {
  const a = t.amenity;
  if (a === "toilets") return "toilets";
  if (a === "drinking_water" || ((a === "fountain" || t.man_made === "water_tap") && t.drinking_water === "yes")) return "drinking_water";
  if (["pharmacy", "hospital", "clinic", "doctors", "library", "atm", "community_centre"].includes(a)) return a;
  if (t.shop === "supermarket") return "supermarket";
  if (t.internet_access === "wlan" && t["internet_access:fee"] === "no") return "wifi";
  if (t.emergency === "defibrillator") return "aed";
  if (t.emergency === "phone") return "emergency_phone";
  if (AMENITY_SAME.includes(a)) return a;
  if (t.office === "diplomatic") return "embassy";
  if (LOCKERS.includes(a)) return "lockers";
  if (a === "device_charging_station") return "phone_charging";
  if (a === "charging_station") return "ev_charging";
  if (a === "changing_table") return "baby_changing";
  if (a === "vending_machine" && /public_transport_tickets/.test(t.vending ?? "")) return "ticket_machine";
  if (a === "parking_space" && t.parking_space === "disabled") return "disabled_parking";
  if (a === "parking" && t["capacity:disabled"] && !["no", "0"].includes(t["capacity:disabled"])) return "disabled_parking";
  if (t.leisure === "playground") return "playground";
  if (t.highway === "elevator") return "elevator";
  return null;
}
/** The categories data/ch/osm-<category>.json already has (tools/build-amenities-ch.mts): the CH places build leaves them out. */
export const CH_BASIC = new Set(["toilets", "drinking_water", "pharmacy", "hospital", "clinic", "doctors", "library", "atm", "community_centre",
  "supermarket", "wifi", "aed", "emergency_phone", "shelter", "shower", "post_office", "bureau_de_change", "money_transfer", "police",
  "social_facility", "dentist", "public_bookcase", "bicycle_repair_station", "food_sharing", "give_box", "lockers", "phone_charging",
  "disabled_parking", "playground", "elevator"]);
