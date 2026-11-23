//! Interpretation of OSM tags: which ways a pedestrian may use, what kind of
//! edge they become, levels, node barriers, platform attributes.
//!
//! Everything here works on borrowed tag strings and is independent of the PBF
//! reader so it can be unit-tested with literal tag lists.

use kante_core::walk::*;

/// Tags the importer looks at, by key. Empty string = tag absent.
#[derive(Default, Clone, Copy, Debug)]
pub struct Tags<'a> {
    pub highway: &'a str,
    pub railway: &'a str,
    pub public_transport: &'a str,
    pub footway: &'a str,
    pub cycleway: &'a str,
    pub crossing: &'a str,
    pub crossing_signals: &'a str,
    pub crossing_markings: &'a str,
    pub foot: &'a str,
    pub access: &'a str,
    pub area: &'a str,
    pub indoor: &'a str,
    pub level: &'a str,
    pub tunnel: &'a str,
    pub bridge: &'a str,
    pub covered: &'a str,
    pub wheelchair: &'a str,
    pub surface: &'a str,
    pub smoothness: &'a str,
    pub tracktype: &'a str,
    pub sac_scale: &'a str,
    pub step_count: &'a str,
    pub ramp: &'a str,
    pub ramp_wheelchair: &'a str,
    pub incline: &'a str,
    pub conveying: &'a str,
    pub sidewalk: &'a str,
    pub sidewalk_both: &'a str,
    pub sidewalk_left: &'a str,
    pub sidewalk_right: &'a str,
    pub segregated: &'a str,
    pub name: &'a str,
    pub ref_: &'a str,
    pub local_ref: &'a str,
    pub sloid: &'a str,
    pub ifopt: &'a str,
    pub uic_ref: &'a str,
    pub bus: &'a str,
    pub trolleybus: &'a str,
    pub tram: &'a str,
    pub train: &'a str,
    pub subway: &'a str,
    pub light_rail: &'a str,
    pub monorail: &'a str,
    pub ferry: &'a str,
    pub aerialway: &'a str,
    pub funicular: &'a str,
    pub service: &'a str,
    pub motor_vehicle: &'a str,
    pub psv: &'a str,
    pub motorroad: &'a str,
    pub building_part: &'a str,
    pub elevator: &'a str,
    pub room: &'a str,
    pub type_: &'a str,
    pub route: &'a str,
    pub entrance: &'a str,
    pub door: &'a str,
    pub barrier: &'a str,
    pub kerb: &'a str,
    pub locked: &'a str,
    pub maxwidth: &'a str,
    pub width: &'a str,
    pub amenity: &'a str,
    pub station: &'a str,
    pub layer: &'a str,
}

impl<'a> Tags<'a> {
    pub fn collect(it: impl Iterator<Item = (&'a str, &'a str)>) -> Tags<'a> {
        let mut t = Tags::default();
        for (k, v) in it {
            match k {
                "highway" => t.highway = v,
                "railway" => t.railway = v,
                "public_transport" => t.public_transport = v,
                "footway" => t.footway = v,
                "cycleway" => t.cycleway = v,
                "crossing" => t.crossing = v,
                "crossing:signals" => t.crossing_signals = v,
                "crossing:markings" => t.crossing_markings = v,
                "foot" => t.foot = v,
                "access" => t.access = v,
                "area" => t.area = v,
                "indoor" => t.indoor = v,
                "level" => t.level = v,
                "tunnel" => t.tunnel = v,
                "bridge" => t.bridge = v,
                "covered" => t.covered = v,
                "wheelchair" => t.wheelchair = v,
                "surface" => t.surface = v,
                "smoothness" => t.smoothness = v,
                "tracktype" => t.tracktype = v,
                "sac_scale" => t.sac_scale = v,
                "step_count" => t.step_count = v,
                "ramp" => t.ramp = v,
                "ramp:wheelchair" => t.ramp_wheelchair = v,
                "incline" => t.incline = v,
                "conveying" => t.conveying = v,
                "sidewalk" => t.sidewalk = v,
                "sidewalk:both" => t.sidewalk_both = v,
                "sidewalk:left" => t.sidewalk_left = v,
                "sidewalk:right" => t.sidewalk_right = v,
                "segregated" => t.segregated = v,
                "name" => t.name = v,
                "ref" => t.ref_ = v,
                "local_ref" => t.local_ref = v,
                "ref:sloid" => t.sloid = v,
                "ref:IFOPT" => t.ifopt = v,
                "uic_ref" => t.uic_ref = v,
                "bus" => t.bus = v,
                "trolleybus" => t.trolleybus = v,
                "tram" => t.tram = v,
                "train" => t.train = v,
                "subway" => t.subway = v,
                "light_rail" => t.light_rail = v,
                "monorail" => t.monorail = v,
                "ferry" => t.ferry = v,
                "aerialway" => t.aerialway = v,
                "funicular" => t.funicular = v,
                "service" => t.service = v,
                "motor_vehicle" => t.motor_vehicle = v,
                "psv" => t.psv = v,
                "motorroad" => t.motorroad = v,
                "building:part" | "building_part" => t.building_part = v,
                "elevator" => t.elevator = v,
                "room" => t.room = v,
                "type" => t.type_ = v,
                "route" => t.route = v,
                "entrance" => t.entrance = v,
                "door" => t.door = v,
                "barrier" => t.barrier = v,
                "kerb" => t.kerb = v,
                "locked" => t.locked = v,
                "maxwidth" | "maxwidth:physical" => t.maxwidth = v,
                "width" => t.width = v,
                "amenity" => t.amenity = v,
                "station" => t.station = v,
                "layer" => t.layer = v,
                _ => {}
            }
        }
        t
    }

    #[inline]
    pub fn is_platform(&self) -> bool {
        self.highway == "platform" || self.railway == "platform" || self.public_transport == "platform"
    }
}

#[inline]
fn yes(v: &str) -> bool {
    matches!(v, "yes" | "designated" | "permissive" | "official")
}
#[inline]
fn set(v: &str) -> bool {
    !v.is_empty() && v != "no"
}

// ---------------------------------------------------------------- levels

/// Parsed `level=*`, values ×2 (see [`Level2`]). `first`/`last` follow the
/// order written in the tag, `min`/`max` the values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LevelSpec {
    pub first: Level2,
    pub last: Level2,
    pub min: Level2,
    pub max: Level2,
}

impl LevelSpec {
    pub const NONE: LevelSpec = LevelSpec { first: LEVEL_NONE, last: LEVEL_NONE, min: LEVEL_NONE, max: LEVEL_NONE };
    #[inline]
    pub fn is_none(&self) -> bool {
        self.first == LEVEL_NONE
    }
    #[inline]
    pub fn is_multi(&self) -> bool {
        !self.is_none() && self.min != self.max
    }
    pub fn single(v: Level2) -> Self {
        LevelSpec { first: v, last: v, min: v, max: v }
    }
}

fn level_num(s: &str) -> Option<Level2> {
    let v: f32 = s.trim().parse().ok()?;
    if !v.is_finite() || v.abs() > 60.0 {
        return None;
    }
    Some((v * 2.0).round() as Level2)
}

/// All levels named by a `level` tag, ×2, in tag order: `"-1;0"` → `[-2, 0]`,
/// `"0.5"` → `[1]`, `"1-3"` → `[2, 4, 6]`. Unparseable parts are skipped.
pub fn parse_levels(s: &str) -> Vec<Level2> {
    let mut out: Vec<Level2> = Vec::new();
    if s.is_empty() {
        return out;
    }
    for tok in s.split([';', ',']) {
        let tok = tok.trim();
        if tok.is_empty() {
            continue;
        }
        if let Some(v) = level_num(tok) {
            out.push(v);
            continue;
        }
        // range "a-b" (the separator is a '-' that is not the leading sign)
        let bytes = tok.as_bytes();
        let mut done = false;
        for i in 1..bytes.len() {
            if bytes[i] == b'-' {
                if let (Some(a), Some(b)) = (level_num(&tok[..i]), level_num(&tok[i + 1..])) {
                    let (lo, hi) = (a.min(b), a.max(b));
                    if hi as i32 - lo as i32 <= 40 {
                        // whole levels between the ends, in tag direction
                        let mut v = a as i32;
                        let step = if b >= a { 2 } else { -2 };
                        loop {
                            out.push(v as Level2);
                            if v == b as i32 || (step > 0 && v + step > b as i32) || (step < 0 && v + step < b as i32) {
                                break;
                            }
                            v += step;
                        }
                        if *out.last().unwrap() != b {
                            out.push(b);
                        }
                    }
                    done = true;
                    break;
                }
            }
        }
        let _ = done;
    }
    out
}

pub fn level_spec(levels: &[Level2]) -> LevelSpec {
    if levels.is_empty() {
        return LevelSpec::NONE;
    }
    LevelSpec {
        first: levels[0],
        last: *levels.last().unwrap(),
        min: *levels.iter().min().unwrap(),
        max: *levels.iter().max().unwrap(),
    }
}

pub fn parse_level(s: &str) -> LevelSpec {
    if s.is_empty() {
        return LevelSpec::NONE;
    }
    level_spec(&parse_levels(s))
}

// ---------------------------------------------------------------- ways

/// Produces walk edges.
pub const R_WALK: u16 = 1 << 0;
/// Closed polygon to be crossed by synthetic edges.
pub const R_AREA: u16 = 1 << 1;
/// Listed in `OsmExtract::platforms`.
pub const R_PLATFORM: u16 = 1 << 2;
/// Lift mapped as a way / area.
pub const R_LIFT: u16 = 1 << 3;
pub const R_LIFT_PRIVATE: u16 = 1 << 4;
pub const R_CARR_ROAD: u16 = 1 << 5;
pub const R_CARR_TRAM: u16 = 1 << 6;
pub const R_CARR_RAIL: u16 = 1 << 7;
/// `railway=platform_edge`: listed as a platform without walk edges.
pub const R_PLATFORM_EDGE: u16 = 1 << 8;
/// Member of a kept multipolygon relation (its nodes are needed for rings).
pub const R_MEMBER: u16 = 1 << 9;
/// Walk class inherited from the relation the way is a ring of.
pub const R_INHERITED: u16 = 1 << 10;

#[derive(Clone, Copy, Debug)]
pub struct WayClass {
    pub roles: u16,
    pub kind: EdgeKind,
    pub flags: u16,
    pub level: LevelSpec,
    /// +1 the way runs uphill in drawing direction, -1 downhill, 0 unknown.
    pub incline: i8,
    /// `step_count`, 0 if absent.
    pub step_count: u16,
    /// `layer` (or +1 / -1 for an untagged bridge / tunnel). Never turned into
    /// a level; only used to tell floors apart at a lift whose ways carry no
    /// `level`.
    pub layer: i8,
}

impl WayClass {
    pub const NONE: WayClass =
        WayClass { roles: 0, kind: EdgeKind::Footway, flags: 0, level: LevelSpec::NONE, incline: 0, step_count: 0, layer: 0 };
}

fn paved(surface: &str) -> bool {
    matches!(
        surface,
        "asphalt" | "paved" | "concrete" | "paving_stones" | "concrete:plates" | "concrete:lanes" | "metal" | "wood" | "bricks" | "brick"
    )
}

fn rough(t: &Tags) -> bool {
    matches!(
        t.surface,
        "gravel"
            | "ground"
            | "dirt"
            | "earth"
            | "grass"
            | "sand"
            | "unpaved"
            | "cobblestone"
            | "unhewn_cobblestone"
            | "sett"
            | "pebblestone"
            | "mud"
            | "rock"
            | "stone"
            | "woodchips"
            | "grass_paver"
            | "snow"
            | "ice"
            | "scree"
    ) || matches!(t.smoothness, "bad" | "very_bad" | "horrible" | "very_horrible" | "impassable")
        || matches!(t.tracktype, "grade3" | "grade4" | "grade5")
        || !(t.sac_scale.is_empty() || t.sac_scale == "hiking" || t.sac_scale == "strolling")
}

fn has_sidewalk(t: &Tags) -> bool {
    matches!(t.sidewalk, "both" | "left" | "right" | "yes")
        || t.sidewalk_both == "yes"
        || t.sidewalk_left == "yes"
        || t.sidewalk_right == "yes"
}

fn incline(v: &str) -> i8 {
    match v {
        "" => 0,
        "up" => 1,
        "down" => -1,
        _ => {
            let num: String = v.chars().take_while(|c| c.is_ascii_digit() || *c == '-' || *c == '+' || *c == '.').collect();
            match num.parse::<f32>() {
                Ok(x) if x > 0.0 => 1,
                Ok(x) if x < 0.0 => -1,
                _ => 0,
            }
        }
    }
}

/// Is this (untagged-as-highway) polygon a lift shaft?
fn lift_area(t: &Tags) -> bool {
    t.highway == "elevator"
        || (t.highway.is_empty()
            && (t.building_part == "elevator"
                || t.indoor == "elevator"
                || t.room == "elevator"
                || (t.elevator == "yes" && (matches!(t.indoor, "room" | "area" | "yes") || !t.building_part.is_empty()))))
}

/// Classify a way (or, with `relation = true`, the tags of a multipolygon).
/// `closed`: first node == last node and at least 4 refs.
pub fn classify_way(t: &Tags, closed: bool, relation: bool) -> WayClass {
    let mut c = WayClass::NONE;
    let hw = t.highway;
    let foot_yes = yes(t.foot);
    let foot_no = matches!(t.foot, "no" | "private");
    let access_no = matches!(t.access, "no" | "private" | "military") && !foot_yes;
    let platform = t.is_platform();

    // --- reference lines for "which side of the street"
    if !relation && t.area != "yes" {
        let road = matches!(
            hw,
            "motorway"
                | "motorway_link"
                | "trunk"
                | "trunk_link"
                | "primary"
                | "primary_link"
                | "secondary"
                | "secondary_link"
                | "tertiary"
                | "tertiary_link"
                | "unclassified"
                | "residential"
                | "living_street"
                | "service"
                | "road"
                | "busway"
                | "bus_guideway"
        );
        let transit_ok = yes(t.bus) || yes(t.psv) || yes(t.motor_vehicle);
        if road {
            let closed_to_vehicles = matches!(t.access, "no" | "private" | "military") && !transit_ok;
            if !closed_to_vehicles && !matches!(t.service, "parking_aisle" | "driveway") {
                c.roles |= R_CARR_ROAD;
            }
        } else if hw == "pedestrian" && transit_ok {
            c.roles |= R_CARR_ROAD;
        }
        match t.railway {
            "tram" => c.roles |= R_CARR_TRAM,
            "rail" | "light_rail" | "narrow_gauge" | "subway" => c.roles |= R_CARR_RAIL,
            "platform_edge" => c.roles |= R_PLATFORM_EDGE,
            _ => {}
        }
    }

    if platform {
        c.roles |= R_PLATFORM;
    }
    c.level = parse_level(t.level);
    c.layer = match t.layer.trim().parse::<i8>() {
        Ok(v) => v,
        Err(_) if set(t.bridge) => 1,
        Err(_) if set(t.tunnel) && t.tunnel != "building_passage" && t.covered != "arcade" => -1,
        Err(_) => 0,
    };

    // --- lifts mapped as ways
    if lift_area(t) && !platform {
        c.roles |= R_LIFT;
        if access_no {
            c.roles |= R_LIFT_PRIVATE;
        }
        c.kind = EdgeKind::Lift;
        if t.wheelchair == "no" {
            c.flags |= EF_WHEELCHAIR_NO;
        } else if matches!(t.wheelchair, "yes" | "designated") {
            c.flags |= EF_WHEELCHAIR_YES;
        }
        return c;
    }

    // --- may a pedestrian use it, and as what
    let conveying = set(t.conveying);
    let indoor = set(t.indoor);
    let crossing = t.footway == "crossing" || t.cycleway == "crossing" || set(t.crossing);
    let sidewalk = has_sidewalk(t);
    let mut extra: u16 = 0;
    let kind: Option<EdgeKind> = if foot_no || access_no {
        None
    } else if platform {
        Some(EdgeKind::Platform)
    } else {
        match hw {
            "steps" => Some(if conveying { EdgeKind::Escalator } else { EdgeKind::Steps }),
            "footway" | "path" if conveying => Some(EdgeKind::Escalator),
            "footway" => Some(if t.footway == "sidewalk" {
                EdgeKind::Sidewalk
            } else if crossing {
                EdgeKind::Crossing
            } else if indoor {
                EdgeKind::Corridor
            } else {
                EdgeKind::Footway
            }),
            "path" => Some(if t.footway == "sidewalk" {
                EdgeKind::Sidewalk
            } else if crossing {
                EdgeKind::Crossing
            } else if indoor {
                EdgeKind::Corridor
            } else if paved(t.surface) {
                EdgeKind::Footway
            } else {
                EdgeKind::Path
            }),
            "cycleway" => Some(if crossing {
                EdgeKind::Crossing
            } else if foot_yes || !t.segregated.is_empty() {
                EdgeKind::Footway
            } else {
                EdgeKind::Road
            }),
            "bridleway" if foot_yes => Some(EdgeKind::Path),
            "pedestrian" => Some(EdgeKind::Pedestrian),
            "corridor" => {
                extra |= EF_INDOOR;
                Some(EdgeKind::Corridor)
            }
            "track" => Some(if t.tracktype == "grade1" || paved(t.surface) { EdgeKind::Road } else { EdgeKind::Path }),
            "living_street" | "residential" | "service" | "unclassified" | "road" => {
                if sidewalk {
                    extra |= EF_HAS_SIDEWALK;
                }
                Some(EdgeKind::Road)
            }
            "tertiary" | "tertiary_link" | "secondary" | "secondary_link" | "primary" | "primary_link" | "trunk" | "trunk_link" => {
                let trunk = hw.starts_with("trunk");
                if (t.motorroad == "yes" || (trunk && !sidewalk)) && !foot_yes {
                    None
                } else if sidewalk {
                    extra |= EF_HAS_SIDEWALK;
                    Some(EdgeKind::Road)
                } else {
                    Some(EdgeKind::RoadBusy)
                }
            }
            _ => None,
        }
    };

    let area_ok = closed || relation;
    if let Some(mut kind) = kind {
        c.roles |= R_WALK;
        let ped_area = matches!(hw, "pedestrian" | "footway") && (t.area == "yes" || relation) && !platform;
        let plat_area = platform && t.area != "no";
        if area_ok && (ped_area || plat_area) {
            c.roles |= R_AREA;
            if ped_area {
                kind = EdgeKind::Pedestrian;
            }
        }
        c.kind = kind;
        c.flags |= extra;
        // an arcade along a street is often tagged as a tunnel too; it is open to the street
        if set(t.tunnel) && !(t.covered == "arcade" && t.tunnel != "building_passage") {
            c.flags |= EF_TUNNEL;
            if t.tunnel == "building_passage" {
                c.flags |= EF_COVERED;
            }
        }
        if set(t.bridge) {
            c.flags |= EF_BRIDGE;
        }
        if set(t.covered) {
            c.flags |= EF_COVERED;
        }
        if indoor {
            c.flags |= EF_INDOOR;
        }
        if t.wheelchair == "no" {
            c.flags |= EF_WHEELCHAIR_NO;
        } else if matches!(t.wheelchair, "yes" | "designated") {
            c.flags |= EF_WHEELCHAIR_YES;
        }
        if rough(t) {
            c.flags |= EF_ROUGH;
        }
        match kind {
            EdgeKind::Crossing => {
                if t.crossing == "traffic_signals" || t.crossing_signals == "yes" {
                    c.flags |= EF_SIGNALS;
                } else if matches!(t.crossing, "zebra" | "marked" | "uncontrolled") || set(t.crossing_markings) {
                    c.flags |= EF_MARKED;
                }
            }
            EdgeKind::Steps | EdgeKind::Escalator => {
                if kind == EdgeKind::Steps && (t.ramp == "yes" || t.ramp_wheelchair == "yes") {
                    c.flags |= EF_RAMP;
                }
                if kind == EdgeKind::Escalator {
                    match t.conveying {
                        "forward" => c.flags |= EF_ONEWAY_AB,
                        "backward" => c.flags |= EF_ONEWAY_BA,
                        _ => {}
                    }
                }
                c.step_count = t.step_count.trim().parse::<u16>().unwrap_or(0);
            }
            _ => {}
        }
        c.incline = incline(t.incline);
    } else if area_ok && hw.is_empty() && !platform && matches!(t.indoor, "corridor" | "area") && !foot_no && !access_no {
        // Indoor corridor drawn as a polygon without a centre line: crossed by
        // synthetic edges between the points where other ways touch it; its
        // outline (the walls) is not walked.
        c.roles |= R_AREA;
        c.kind = EdgeKind::Corridor;
        c.flags |= EF_INDOOR;
    }
    c
}

// ---------------------------------------------------------------- nodes

/// Nobody passes this node on foot.
pub const X_BLOCK: u8 = 1 << 0;
/// Marked crossing without signals.
pub const X_MARKED: u8 = 1 << 1;
pub const X_LIFT_PRIVATE: u8 = 1 << 2;
pub const X_WC_YES: u8 = 1 << 3;
pub const X_WC_NO: u8 = 1 << 4;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NodeClass {
    pub nf: u8,
    pub extra: u8,
}

fn metres(v: &str) -> Option<f32> {
    let num: String = v.trim().chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
    let x: f32 = num.parse().ok()?;
    if v.contains("cm") {
        Some(x / 100.0)
    } else {
        Some(x)
    }
}

pub fn classify_node(t: &Tags) -> NodeClass {
    let mut c = NodeClass::default();
    let foot_yes = yes(t.foot);
    if t.highway == "elevator" {
        c.nf |= NF_ELEVATOR;
        if matches!(t.access, "no" | "private") && !foot_yes {
            c.extra |= X_LIFT_PRIVATE;
        }
        if t.wheelchair == "no" {
            c.extra |= X_WC_NO;
        } else if matches!(t.wheelchair, "yes" | "designated") {
            c.extra |= X_WC_YES;
        }
    }
    if t.highway == "crossing" || (t.highway == "traffic_signals" && set(t.crossing)) {
        if t.crossing == "traffic_signals" || t.crossing_signals == "yes" || t.highway == "traffic_signals" {
            c.nf |= NF_CROSSING_SIGNALS;
        } else {
            c.nf |= NF_CROSSING;
            if matches!(t.crossing, "zebra" | "marked" | "uncontrolled") || set(t.crossing_markings) {
                c.extra |= X_MARKED;
            }
        }
    }
    if set(t.entrance) {
        c.nf |= NF_ENTRANCE;
    }
    if set(t.door) || t.indoor == "door" {
        c.nf |= NF_DOOR;
    }
    if !t.barrier.is_empty() && t.barrier != "no" {
        let closed_by_tag = ((matches!(t.access, "no" | "private" | "military")) && !foot_yes)
            || matches!(t.foot, "no" | "private")
            || t.locked == "yes";
        let solid = matches!(t.barrier, "wall" | "fence" | "hedge" | "retaining_wall" | "city_wall" | "guard_rail" | "handrail" | "ditch");
        if closed_by_tag || (solid && !foot_yes) {
            c.extra |= X_BLOCK;
        }
        let narrow = t.barrier == "cycle_barrier"
            && metres(t.maxwidth).or_else(|| metres(t.width)).map(|w| w < 0.9).unwrap_or(false);
        let no_wc = matches!(
            t.barrier,
            "stile" | "turnstile" | "full-height_turnstile" | "kissing_gate" | "steps" | "step" | "horse_stile" | "squeeze_stile" | "log" | "debris"
        ) || narrow
            || (t.barrier == "kerb" && t.kerb == "raised")
            || t.wheelchair == "no";
        if no_wc && !matches!(t.wheelchair, "yes" | "designated") {
            c.nf |= NF_NO_WHEELCHAIR;
        }
    }
    if t.kerb == "raised" && !matches!(t.wheelchair, "yes" | "designated") {
        c.nf |= NF_NO_WHEELCHAIR;
    }
    c
}

// ---------------------------------------------------------------- platforms

pub const M_BUS: u8 = 1 << 0;
pub const M_TRAM: u8 = 1 << 1;
pub const M_TRAIN: u8 = 1 << 2;
pub const M_SUBWAY: u8 = 1 << 3;
pub const M_FERRY: u8 = 1 << 4;
pub const M_AERIAL: u8 = 1 << 5;

/// Mode bits for a `route=*` value of a route relation.
pub fn route_modes(route: &str) -> u8 {
    match route {
        "bus" | "trolleybus" | "coach" | "share_taxi" => M_BUS,
        "tram" => M_TRAM,
        "train" | "railway" => M_TRAIN,
        "subway" | "light_rail" | "monorail" => M_SUBWAY,
        "ferry" => M_FERRY,
        "funicular" | "aerialway" | "gondola" | "cable_car" => M_AERIAL,
        _ => 0,
    }
}

pub fn mode_hints(t: &Tags) -> u8 {
    let mut m = 0;
    if yes(t.bus) || yes(t.trolleybus) || t.highway == "bus_stop" {
        m |= M_BUS;
    }
    if yes(t.tram) || t.railway == "tram_stop" {
        m |= M_TRAM;
    }
    if yes(t.train) || t.railway == "halt" {
        m |= M_TRAIN;
    }
    if yes(t.subway) || yes(t.light_rail) || yes(t.monorail) || matches!(t.station, "subway" | "light_rail") {
        m |= M_SUBWAY;
    }
    if yes(t.ferry) || t.amenity == "ferry_terminal" {
        m |= M_FERRY;
    }
    if yes(t.aerialway) || yes(t.funicular) || t.aerialway == "station" || t.station == "funicular" {
        m |= M_AERIAL;
    }
    m
}

/// Which kind of stop object a tagged node is, if any.
pub fn node_platform_kind(t: &Tags) -> Option<PlatformKind> {
    if t.public_transport == "platform" || t.highway == "bus_stop" || t.highway == "platform" || t.railway == "platform" {
        Some(PlatformKind::PlatformNode)
    } else if t.public_transport == "stop_position" || matches!(t.railway, "tram_stop" | "stop" | "halt") {
        Some(PlatformKind::StopPosition)
    } else if t.amenity == "ferry_terminal" || t.aerialway == "station" {
        Some(PlatformKind::PlatformNode)
    } else {
        None
    }
}

/// `ref` then `local_ref`, split on `;` `/` `,`, trimmed, de-duplicated.
pub fn split_refs(ref_: &str, local_ref: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for src in [ref_, local_ref] {
        for part in src.split([';', '/', ',']) {
            let p = part.trim();
            if !p.is_empty() && p.len() <= 24 && !out.iter().any(|x| x == p) {
                out.push(p.to_string());
            }
        }
    }
    out
}

/// Attributes of a platform / stop object taken from its own tags.
#[derive(Clone, Debug, Default)]
pub struct PlatInfo {
    pub refs: Vec<String>,
    pub name: String,
    pub sloid: String,
    pub uic_ref: u32,
    pub modes: u8,
    pub level: Level2,
}

pub fn plat_info(t: &Tags) -> PlatInfo {
    let sloid = if !t.sloid.is_empty() {
        t.sloid
    } else if t.ifopt.contains("sloid") {
        t.ifopt
    } else {
        ""
    };
    let lv = parse_level(t.level);
    PlatInfo {
        refs: split_refs(t.ref_, t.local_ref),
        name: t.name.to_string(),
        sloid: sloid.trim().to_string(),
        uic_ref: t.uic_ref.trim().parse::<u32>().unwrap_or(0),
        modes: mode_hints(t),
        level: lv.first,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tg<'a>(kv: &[(&'a str, &'a str)]) -> Tags<'a> {
        Tags::collect(kv.iter().copied())
    }

    #[test]
    fn levels() {
        assert_eq!(parse_levels("-1"), vec![-2]);
        assert_eq!(parse_levels("0;1"), vec![0, 2]);
        assert_eq!(parse_levels("-1;0"), vec![-2, 0]);
        assert_eq!(parse_levels("0.5"), vec![1]);
        assert_eq!(parse_levels("1-3"), vec![2, 4, 6]);
        assert_eq!(parse_levels("-2--1"), vec![-4, -2]);
        assert_eq!(parse_levels("-1-1"), vec![-2, 0, 2]);
        assert_eq!(parse_levels(" 0 ; -1 "), vec![0, -2]);
        assert_eq!(parse_levels("EG"), Vec::<i8>::new());
        assert_eq!(parse_levels("999"), Vec::<i8>::new());
        let l = parse_level("0;-1");
        assert_eq!((l.first, l.last, l.min, l.max), (0, -2, -2, 0));
        assert!(l.is_multi());
        assert!(parse_level("").is_none());
        assert!(!parse_level("2").is_multi());
    }

    #[test]
    fn walkable_kinds() {
        let c = classify_way(&tg(&[("highway", "footway"), ("footway", "sidewalk")]), false, false);
        assert_eq!((c.roles & R_WALK != 0, c.kind), (true, EdgeKind::Sidewalk));
        let c = classify_way(&tg(&[("highway", "footway"), ("footway", "crossing"), ("crossing", "traffic_signals")]), false, false);
        assert_eq!(c.kind, EdgeKind::Crossing);
        assert!(c.flags & EF_SIGNALS != 0 && c.flags & EF_MARKED == 0);
        let c = classify_way(&tg(&[("highway", "footway"), ("crossing", "zebra")]), false, false);
        assert_eq!(c.kind, EdgeKind::Crossing);
        assert!(c.flags & EF_MARKED != 0);
        let c = classify_way(&tg(&[("highway", "footway"), ("indoor", "yes"), ("level", "-1"), ("tunnel", "yes")]), false, false);
        assert_eq!(c.kind, EdgeKind::Corridor);
        assert!(c.flags & EF_INDOOR != 0 && c.flags & EF_TUNNEL != 0);
        assert_eq!(c.level.first, -2);
        assert_eq!(classify_way(&tg(&[("highway", "motorway")]), false, false).roles & R_WALK, 0);
        assert_eq!(classify_way(&tg(&[("highway", "construction")]), false, false).roles, 0);
        assert_eq!(classify_way(&tg(&[("highway", "footway"), ("foot", "no")]), false, false).roles & R_WALK, 0);
        assert_eq!(classify_way(&tg(&[("highway", "service"), ("access", "private")]), false, false).roles, 0);
        assert!(classify_way(&tg(&[("highway", "service"), ("access", "private"), ("foot", "yes")]), false, false).roles & R_WALK != 0);
        assert_eq!(classify_way(&tg(&[("highway", "bridleway")]), false, false).roles & R_WALK, 0);
        assert_eq!(classify_way(&tg(&[("highway", "trunk")]), false, false).roles & R_WALK, 0);
        let c = classify_way(&tg(&[("highway", "trunk"), ("sidewalk", "right")]), false, false);
        assert!(c.roles & R_WALK != 0 && c.kind == EdgeKind::Road && c.flags & EF_HAS_SIDEWALK != 0);
        let c = classify_way(&tg(&[("highway", "secondary")]), false, false);
        assert!(c.kind == EdgeKind::RoadBusy && c.roles & R_CARR_ROAD != 0);
        let c = classify_way(&tg(&[("highway", "tertiary"), ("sidewalk", "both")]), false, false);
        assert!(c.kind == EdgeKind::Road && c.flags & EF_HAS_SIDEWALK != 0);
        let c = classify_way(&tg(&[("highway", "path"), ("surface", "gravel")]), false, false);
        assert!(c.kind == EdgeKind::Path && c.flags & EF_ROUGH != 0);
        assert_eq!(classify_way(&tg(&[("indoor", "room"), ("shop", "bakery")]), true, false).roles, 0);
    }

    #[test]
    fn stairs_escalators() {
        let c = classify_way(&tg(&[("highway", "steps"), ("step_count", "24"), ("incline", "up"), ("ramp", "yes"), ("level", "-1;0")]), false, false);
        assert_eq!(c.kind, EdgeKind::Steps);
        assert_eq!((c.step_count, c.incline), (24, 1));
        assert!(c.flags & EF_RAMP != 0 && c.level.is_multi());
        let c = classify_way(&tg(&[("highway", "steps"), ("conveying", "backward"), ("incline", "down")]), false, false);
        assert_eq!(c.kind, EdgeKind::Escalator);
        assert!(c.flags & EF_ONEWAY_BA != 0 && c.flags & EF_ONEWAY_AB == 0);
        assert_eq!(c.incline, -1);
        let c = classify_way(&tg(&[("highway", "steps"), ("conveying", "reversible")]), false, false);
        assert!(c.kind == EdgeKind::Escalator && c.flags & (EF_ONEWAY_AB | EF_ONEWAY_BA) == 0);
        let c = classify_way(&tg(&[("highway", "footway"), ("conveying", "forward")]), false, false);
        assert!(c.kind == EdgeKind::Escalator && c.flags & EF_ONEWAY_AB != 0);
        assert_eq!(classify_way(&tg(&[("highway", "steps"), ("incline", "-12%")]), false, false).incline, -1);
    }

    #[test]
    fn areas_platforms_lifts() {
        let c = classify_way(&tg(&[("highway", "pedestrian"), ("area", "yes")]), true, false);
        assert!(c.roles & R_AREA != 0 && c.roles & R_WALK != 0 && c.kind == EdgeKind::Pedestrian);
        let c = classify_way(&tg(&[("highway", "pedestrian"), ("area", "yes")]), false, false);
        assert!(c.roles & R_AREA == 0);
        let c = classify_way(&tg(&[("highway", "pedestrian"), ("type", "multipolygon")]), false, true);
        assert!(c.roles & R_AREA != 0);
        let c = classify_way(&tg(&[("railway", "platform"), ("ref", "7;8"), ("level", "0")]), true, false);
        assert!(c.roles & (R_AREA | R_WALK | R_PLATFORM) == (R_AREA | R_WALK | R_PLATFORM) && c.kind == EdgeKind::Platform);
        let c = classify_way(&tg(&[("public_transport", "platform"), ("highway", "footway")]), false, false);
        assert!(c.kind == EdgeKind::Platform && c.roles & R_AREA == 0);
        let c = classify_way(&tg(&[("highway", "elevator"), ("indoor", "yes"), ("level", "-1;0;1")]), true, false);
        assert!(c.roles & R_LIFT != 0 && c.roles & R_WALK == 0);
        let c = classify_way(&tg(&[("railway", "tram")]), false, false);
        assert!(c.roles == R_CARR_TRAM);
        let c = classify_way(&tg(&[("highway", "service"), ("access", "no"), ("bus", "yes")]), false, false);
        assert!(c.roles & R_CARR_ROAD != 0 && c.roles & R_WALK == 0);
        let c = classify_way(&tg(&[("indoor", "corridor"), ("level", "1")]), true, false);
        assert!(c.roles == R_AREA && c.kind == EdgeKind::Corridor);
    }

    #[test]
    fn nodes() {
        let c = classify_node(&tg(&[("highway", "elevator"), ("wheelchair", "yes"), ("level", "0;-1")]));
        assert!(c.nf & NF_ELEVATOR != 0 && c.extra & X_WC_YES != 0);
        let c = classify_node(&tg(&[("highway", "crossing"), ("crossing", "traffic_signals")]));
        assert_eq!(c.nf, NF_CROSSING_SIGNALS);
        let c = classify_node(&tg(&[("highway", "crossing"), ("crossing", "zebra")]));
        assert!(c.nf == NF_CROSSING && c.extra & X_MARKED != 0);
        assert!(classify_node(&tg(&[("barrier", "stile")])).nf & NF_NO_WHEELCHAIR != 0);
        assert_eq!(classify_node(&tg(&[("barrier", "bollard")])), NodeClass::default());
        assert!(classify_node(&tg(&[("barrier", "gate"), ("access", "private")])).extra & X_BLOCK != 0);
        assert!(classify_node(&tg(&[("barrier", "gate")])).extra & X_BLOCK == 0);
        assert!(classify_node(&tg(&[("barrier", "fence")])).extra & X_BLOCK != 0);
        assert!(classify_node(&tg(&[("barrier", "cycle_barrier"), ("maxwidth", "0.8")])).nf & NF_NO_WHEELCHAIR != 0);
        assert!(classify_node(&tg(&[("barrier", "cycle_barrier")])).nf & NF_NO_WHEELCHAIR == 0);
        assert!(classify_node(&tg(&[("kerb", "raised")])).nf & NF_NO_WHEELCHAIR != 0);
        let c = classify_node(&tg(&[("entrance", "main"), ("door", "hinged")]));
        assert!(c.nf & NF_ENTRANCE != 0 && c.nf & NF_DOOR != 0);
    }

    #[test]
    fn platform_info() {
        let p = plat_info(&tg(&[("ref", "7;8"), ("local_ref", "7 / 8"), ("uic_ref", "8507000"), ("level", "-2"), ("train", "yes"), ("name", "Bern")]));
        assert_eq!(p.refs, vec!["7", "8"]);
        assert_eq!((p.uic_ref, p.level, p.modes, p.name.as_str()), (8507000, -4, M_TRAIN, "Bern"));
        assert_eq!(split_refs("K1", ""), vec!["K1"]);
        assert_eq!(split_refs("A, B", "C"), vec!["A", "B", "C"]);
        let t = tg(&[("highway", "bus_stop")]);
        assert_eq!(node_platform_kind(&t), Some(PlatformKind::PlatformNode));
        assert_eq!(mode_hints(&t), M_BUS);
        assert_eq!(node_platform_kind(&tg(&[("public_transport", "stop_position")])), Some(PlatformKind::StopPosition));
    }
}
