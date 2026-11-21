#!/usr/bin/env python3
"""Build stations3d/<key>.js: a 3D model of a multi-level station with its walking graph (format: stations3d/SCHEMA.md).

Sources:
  - OpenStreetMap via Overpass: everything in the station's bounding box (indoor mapping with level=*, paths, stairs,
    lifts, platforms, tracks, buildings). Downloads are cached in tools/cache/<key>.osm.json.
  - platforms.js (ATLAS, built by tools/build_platforms.py): the platforms / stop edges of the complex's stops.

Usage:
  python tools/build_station3d.py            # build every station in STATIONS
  python tools/build_station3d.py bern       # build one
  python tools/build_station3d.py --refresh  # download OpenStreetMap again instead of using the cache
  python tools/build_station3d.py bern --osm FILE.json   # use an Overpass JSON file ("out body geom") instead
  python tools/build_station3d.py --data DIR  # open-data layers from DIR/<key>/ instead of tools/station3d_data/

Requires Python 3.9+ with shapely 2 (which brings numpy): pip install shapely
  Shapely does the polygon work (cleaning, unions, "can I walk straight from here to there inside this square").

To add a station, add an entry to STATIONS (bounding box, stop ids, level table). Heights and names of the levels are
plain numbers / texts in that table.

What the tool does, in order (Builder.run; each step is one method):
  1. read OSM, drop everything that is not open today (construction, proposed, razed, disused, private, opening later)
  2. collect walkable polygons (platforms, squares, indoor floors), rooms, paths, stairs, lifts
  3. find the OSM platform of every ATLAS stop edge
  4. give every path node a level: from level=*, from the ends of stairs and ramps, and for paths without a level by
     interpolating heights between the places where they meet levelled ones (see solve_levels). Where OSM has no
     level=* at all: a train platform is on the level of its track, the steps counted on the stairs give the rises,
     and a path on a bridge or in a tunnel that came out at the height of the tracks it crosses is put on the level
     that clears them (repair_crossings)
  5. build the walking graph: paths, lifts, a spine along each platform, straight links across open areas
  6. tie the stop edges, entrances and points of interest to it
  7. keep the part of the graph that connects all stops, simplify it, add tracks and building massing
  8. one stop per platform number with all its nodes, closures, floors where OSM only has paths, and the open-data
     layers (enrich)
  9. check the result and print a report (--verbose for every finding)

Open-data layers of a station (measured heights, sectors, station furniture, real roofs) are read from
tools/station3d_data/<key>/ when they are there (--data DIR for another folder; see the README.md in it). Without them
the model is built from OpenStreetMap and ATLAS alone.
"""
import argparse
import datetime
import heapq
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

try:
    import numpy as np
    import shapely
    from shapely.geometry import LineString, MultiPoint, MultiPolygon, Point, Polygon, box
    from shapely.ops import nearest_points, substring, unary_union
    from shapely.prepared import prep
    from shapely.strtree import STRtree
except ImportError:  # pragma: no cover
    raise SystemExit('build_station3d.py needs shapely 2 (pip install shapely)')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, 'stations3d')
CACHE_DIR = os.path.join(ROOT, 'tools', 'cache')
DATA_DIR = os.path.join(ROOT, 'tools', 'station3d_data')   # open-data layers per station, see its README.md
PLATFORMS_JS = os.path.join(ROOT, 'platforms.js')
UA = 'station3d-builder/1.0'
OVERPASS = ['https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
            'https://overpass.private.coffee/api/interpreter']

# ---------------------------------------------------------------------------------------------------------------------
# Stations. Everything that is a judgement about one place lives here.
#   bbox      south, west, north, east of the OpenStreetMap download
#   extent    the part that goes into the model, in local metres around origin: minX, minY, maxX, maxY;
#             extent_cut lists boxes to leave out of it
#   uics      stop ids of the complex (platforms.js / transport.opendata.ch)
#   levels    OSM level -> (height in metres relative to level 0, English name). Levels that turn out to carry no
#             public walkable space are left out of the model; levels missing here get "Level N" and a height
#             extrapolated with level_height.
#   entrances named ways in: [name, x, y, level] in local metres; tied to the nearest graph node on that level within
#             25 m. The first is the main entrance (validation starts its step-free search there). Doors that carry
#             a name in OSM are added when no entry here is within 20 m of them.
#   pois      extra points of interest OSM does not have: [kind, name, x, y, level]
#   closed    platforms that are shut today: {uic, refs, note, until}. Their stops and areas stay in the model and
#             get closed: true and the note, so the app can say so. Ignored from the "until" date on.
#   area_names  names for walkable areas OSM leaves unnamed: [x, y, level, name] (a point inside the area)
#   ground    places where the level of the street is known: [x, y, level]. The nearest ground path within 40 m is
#             put on that level; the heights of paths without level=* are interpolated between such fixed points.
#   spot_heights  measured heights of the street from the station's heights.json: [id, 'ground' | 'bridge'];
#   spots     the same given here: [x, y, metres relative to level 0, 'ground' | 'bridge']. The nearest path of that
#             kind without level=* (within 40 m, on a bridge 20 m) is put on that height.
#   closed    see above; 'whole': True closes the platform area and every stair, escalator, ramp and lift on it too,
#             'from' / 'until' are dates, 'remark' is a note on the stop that does not close it
#   opens     {'date': ...}: paths OSM has as highway=construction with a start date in the future are in the model,
#             closed until this date (the official one, where OSM's differs)
#   exit_names  [x, y, name]: the stairs, escalators and lifts that end within 8 m of the point get this name
#   notices   texts for the app: [{'text', 'from'?, 'until'?}]
#   extend_platforms  island platforms (one of their numbers each) to extend along the SBB kerb lines of
#             platform_edges.geojson where the OSM outline stops short
#   layers    files in tools/station3d_data/<key>/ the model is meant to have (a message is printed when one is
#             missing; the model is then built without it)
#   credits   attribution for sources used in this table
#   decks     bridges nobody walks on that belong to the picture (a motorway viaduct over the stop): [x, y, top, name],
#             a point inside the man_made=bridge outline, the height of its top in metres, a name
#   structures  the same for a bridge or a tunnel OSM gives no level: [x, y, level]. The nearest path on a bridge or
#             in a tunnel (within 15 m) is put on that level, whole. Only needed where neither level=* nor the
#             steps counted on its stairs nor the tracks it crosses say how high it is.
#   squares   [x, y]: a point on a square that is open to walk across, where OSM has only its outline as
#             place=square (and the pavements along its edges as highway=pedestrian areas, with a bus or tram loop
#             between them). The outline becomes one square to walk on, together with the pedestrian areas in it.
#   links     walks OSM has no path for, each with the evidence for it: [x1, y1, x2, y2, level]. Each end is put on
#             the nearest path on that level (within 8 m); the link is flagged inferred in the model.
#   osm_edits  corrections to the OpenStreetMap download, each with its evidence next to it, applied before
#             anything is read from it (local metres):
#               ['move', node id, x, y]            a node to where the thing really is
#               ['node', name, x, y]               a new node, for the ways below
#               ['way', [node id | name | [x, y], ...], {tags}]   a new way (a ring ends on its first point)
#               ['drop', way id]                   a way that is wrong, or that the ways above replace
#   skip_edges  [uic, x, y, why]: an ATLAS stop edge that is wrong (the edge of that stop id within 10 m of the
#             point is left out), with the evidence in `why`
#   stop_areas  [uic, ref or name, x, y, why]: the platform area at the point belongs to that stop too (its nodes
#             are added to the stop's), where ATLAS has one edge for two platforms, e.g. a metro's two side platforms
#   stop_names  [x, y, name, mode]: the stop without a platform number within 10 m of the point gets this name and
#             mode ('tram' | 'bus'), where ATLAS has one name and one mode for the tram and the bus edges of a stop.
#   modes_from_osm  True: the same for the edges with a letter, from OSM: an edge whose letter OSM has on a bus or
#             tram stop position or platform near it is a tram stop when one of them is tram=yes, else a bus stop.
#             (Always done for a stop id that OSM has as a railway station, where ATLAS calls it bus or tram.)
#   level_shift  boxes in which OSM counts the floors differently from the rest of the station (a shopping centre
#             that calls its ground floor level 1): [minX, minY, maxX, maxY, shift]. The shift is added to every
#             level=* of the things that lie in the box entirely.
# ---------------------------------------------------------------------------------------------------------------------
STATIONS = {
    'bern': {
        'name': 'Bern',
        'origin': (7.4391, 46.9488),
        'bbox': (46.9448, 7.4300, 46.9530, 7.4445),
        'extent': (-620, -350, 285, 390),
        'extent_cut': [(-520, -350, -290, -130),    # Kocherpark and Laupenstrasse west: not part of the complex
                       # west of -520 only the strip with platform 49/50, whose SBB kerb runs to -602 (sector N)
                       (-620, -350, -520, -80), (-620, -40, -520, 390)],
        'uics': ['8507000', '8507785', '8576646', '8588990', '8579896', '8581351', '8579748', '8571357'],
        # Heights relative to the surface of the SBB platforms, 540.74 m above sea level (measured: swissSURFACE3D
        # along the SBB platform edges; tools/station3d_data/bern/heights.json and its README).
        #   -2  today's RBS platforms: estimate, not measurable. Two readings say about one storey below the
        #       underpass ("one floor below the hall", "about 530 m above sea level"), which would be -9.5 or lower;
        #       but the one ramp OSM has between the hall and these platforms is 27 m long and would then be steeper
        #       than 16 %, which no public ramp is. -8.5 keeps it at 13 %. (517 m in ATLAS is the new station.)
        #   -1  underpasses and lower hall: -5 from the project cross-section; not measurable (the open stairwells
        #       only give upper bounds: -4.0 Neuengass-Unterführung, -2.9 Christoffel-Unterführung)
        #    1  Welle: estimate +6.3 to +6.8 (not measurable). OSM also has the gallery of the main hall (about
        #       +4.5) and the Bollwerk footbridge on level 1; one level has one height.
        #    2  deck over the platforms with the PostAuto station: measured +8.2 to +8.3
        #    3  parking deck: estimate. OSM counts 44 steps from level 2 (7.5 to 8.8 m), and its level-3 paths come
        #       out on the street at the Obergericht, measured +17.5. The streets of the Länggasse that OSM has no
        #       level for lie between 3 and 4 (measured +17.5 to +21).
        #    4  Grosse Schanze park: measured +19.75;  5  university terrace: measured +21.6
        # A level number holds unrelated places here (Welle, gallery and footbridges on 1; PostAuto deck and the
        # north arm of the Welle on 2), so the names of levels 1 to 3 claim nothing; the areas carry the names.
        # Level 0 is the platforms, the ground floor of the station and the streets around it: "Street level" is
        # what a step reads that arrives on it anywhere but on a platform or a named floor.
        'levels': {
            -2: (-8.5, 'RBS station'),
            -1: (-5.0, 'Lower level'),
            0: (0.0, 'Street level'),
            1: (6.5, 'Level 1'),
            2: (8.2, 'Level 2'),
            3: (17.0, 'Level 3'),
            4: (19.8, 'Grosse Schanze'),
            5: (21.6, 'University terrace'),
        },
        'level_height': 4.0,
        'entrances': [
            ['Bahnhofplatz (main hall)', 72, -26, 0],
            ['Neuengasse', 131, 41, 0],
            ['Baldachin (Christoffel-Unterführung)', 98, -104, 0],
            ['Bahnhofplatz lift', 97, -82, 0],
            ['Loeb-Egge', 107, -154, 0],
            ['Generationenhaus (edge F)', 50, -36, 0],
            ['Bollwerk (edges G and H)', 98, -5, 0],
            ['Hirschengraben', -98, -240, 0],
            ['Bollwerk 10 (gallery footbridge)', 101, 161, 1],
            ['Welle (Schanzenbrücke)', -168, -60, 1],
            ['PostAuto station', -15, 28, 2],
            ['Grosse Schanze (lifts)', -68, 85, 4],
        ],
        'pois': [
            # OSM has no meeting point; a defibrillator there is described as "beim Treffpunkt"
            ['meeting-point', 'Treffpunkt', 74, 17, -1],
        ],
        'closed': [
            # zukunftbahnhofbern.ch, 20.07.2026: platform 3/4 is being raised and reopens at the timetable change.
            # OSM shows that state: no ramp or stairs from 3/4 to the underpass, only the Welle.
            {'uic': '8507000', 'refs': ['3', '4'], 'until': '2026-12-13', 'whole': True,
             'note': 'Platform 3/4 is closed for works until 13 December 2026'},
            {'uic': '8507000', 'refs': ['1'], 'from': '2026-12-13', 'until': '2029-03-01',
             'note': 'Track 1 is closed for works until early 2029'},
            {'uic': '8507000', 'refs': ['2'],
             'remark': 'Track 2 is partly closed for works from 13 December 2026 until early 2029'},
        ],
        # the new stairs and ramp from platform 3/4 to the main underpass (OSM: start_date 21.12.2026)
        'opens': {'date': '2026-12-13',
                  'note': 'The new stairs and ramp between platform 3/4 and the main underpass open on '
                          '13 December 2026'},
        'notices': [
            {'text': 'Construction in the main underpass: follow the signs on site'},
            {'text': 'Platform 3/4 is closed for works until 13 December 2026', 'until': '2026-12-13'},
            {'text': 'Track 1 is closed for works until early 2029', 'from': '2026-12-13', 'until': '2029-03-01'},
        ],
        'area_names': [
            [57, 24, -1, 'Bahnhofshalle'],
            [110, 36, -1, 'Neuengass-Unterführung'],
            [-20, 30, -1, 'Main underpass'],
            [75, 60, -2, 'RBS station'],
            [-30, 20, 2, 'PostAuto station'],
            # floors the builder makes from paths (OSM has no area there)
            [72, -10, 0, 'Main hall'],
            [-290, -40, 1, 'Footbridge to platforms 49/50'],
            [94, 107, 1, 'Gallery footbridge'],
            [-69, 90, 3, 'Parking deck'],
        ],
        # SBB's description for blind travellers: from the Christoffel-Unterführung stairs lead up under the
        # Baldachin (edges A to E) on the left and to the exit Loeb-Egge (edges I to L) on the right. OSM has stairs
        # and escalators at both and calls them "Bubenbergplatz".
        'exit_names': [[96, -100, 'Baldachin'], [112, -145, 'Loeb-Egge'], [104, -152, 'Loeb-Egge']],
        'layers': ['heights.json', 'sectors.json', 'spans.json', 'boards.json', 'furniture.json', 'shell_mesh.json',
                   'shell.geojson', 'platform_edges.geojson'],
        # OSM draws these two islands 50 to 80 m shorter at the west end than the SBB kerb lines run
        'extend_platforms': ['12', '49'],
        # Survey fixed points and LiDAR medians of heights.json (ids as in that file) ...
        'spot_heights': [
            ['bahnhofplatz_1', 'ground'], ['bahnhofplatz_2', 'ground'],
            ['bubenbergplatz_1', 'ground'], ['bubenbergplatz_2', 'ground'], ['bubenbergplatz_3', 'ground'],
            ['bollwerk_south', 'ground'], ['bollwerk_mid', 'ground'], ['bollwerk_north', 'ground'],
            ['schanzenstrasse_north', 'ground'], ['grosse_schanze', 'ground'], ['grosse_schanze_uni', 'ground'],
            ['schanzenbruecke_0', 'bridge'], ['schanzenbruecke_1', 'bridge'], ['schanzenbruecke_2', 'bridge'],
            ['schanzenbruecke_3', 'bridge'],
        ],
        # ... and swisstopo terrain (height service of api3.geo.admin.ch, 21.11.2026) where that file has none:
        # Hirschengraben edges A, E, F and D, Neuengasse, Obergericht, Universität, Länggasse, Schanzenstrasse stop
        'spots': [
            [-120, -262, -1.1, 'ground'], [-144, -181, 0.6, 'ground'], [-226, -162, -0.4, 'ground'],
            [-73, -308, -1.7, 'ground'], [150, 40, -0.5, 'ground'],
            [-219, 138, 18.6, 'ground'], [-213, 122, 17.5, 'ground'], [-263, 213, 20.9, 'ground'],
            [-287, 266, 20.5, 'ground'], [-317, 275, 20.2, 'ground'], [-152, -95, 5.0, 'ground'],
        ],
    },
    'europaplatz': {
        'name': 'Bern Europaplatz',
        'origin': (7.4066, 46.9437),
        'bbox': (46.9420, 7.4040, 46.9456, 7.4095),
        'extent': (-170, -130, 180, 170),
        'uics': ['8504108', '8507082', '8580939'],
        # Three levels on top of each other. OSM has level=* on all platforms (BLS 1/2: -1, SBB 3/4: 1).
        # Heights: ATLAS has the BLS platform at 546.4 and the SBB platforms at 557.5 m above sea level, 11.1 m
        # apart; swisstopo terrain (swissALTI3D, height service of api3.geo.admin.ch, 21.11.2026) gives 546.5-547.1 in
        # the trench and 556.2-557.5 on the embankment. Level 0 is the street, and the street slopes: tram stop 555.5,
        # Europaplatz square 553.0, Freiburgstrasse bridge over the BLS line about 552.7 (the stairs from it count
        # 37 and 35 steps = 6.0-6.3 m down to 546.5), pedestrian underpass below the SBB line 551.5. The model draws
        # level 0 flat at 552.5, so that both platforms are as far from it as their stairs and ramps climb:
        # BLS -6.1 (546.4), SBB +5.0 (557.5). The tram stop is really 3 m above that, the SBB underpass 1 m below.
        'levels': {
            -1: (-6.1, 'Platforms 1/2'),
            0: (0.0, 'Street level'),
            1: (5.0, 'Platforms 3/4'),
        },
        'level_height': 5.0,
        'entrances': [
            ['Europaplatz', 5, 0, 0],
            ['Freiburgstrasse (east)', 112, -13, 0],
            ['Freiburgstrasse (west)', -70, -92, 0],
            ['Bahnstrasse', 157, 52, 0],
        ],
        # The A12 motorway viaduct above the tram stop and the SBB line. No measured height: it has to clear the
        # overhead line of the SBB tracks on level 1 (about 6 m) and is about 2 m thick: top at 13.5 m (estimate).
        'decks': [[-4, -100, 13.5, 'A12 viaduct']],
        'credits': ['© swisstopo'],                 # terrain heights
    },
    'wankdorf': {
        'name': 'Bern Wankdorf',
        'origin': (7.4655, 46.9672),
        'bbox': (46.9650, 7.4610, 46.9695, 7.4695),
        'extent': (-240, -120, 190, 150),
        'extent_cut': [(-240, 85, -140, 150)],      # WankdorfCity office blocks
        'uics': ['8516161', '8590129', '8595543'],
        # OSM has no level=* on the platforms and layer=1 / bridge=yes on the footbridge. Level 0 is the platforms
        # (ATLAS: 550.0 m above sea level; swisstopo terrain 549.9-550.9) together with the squares on both sides:
        # Rosalia-Wenger-Platz in the north is level with platform 7 (550.0-550.2), the tram stop in the south lies
        # 1.5 m higher (551.8-552.2; ten steps or a ramp down to platform 1).
        # Level 1 is the footbridge: OSM counts 45, 50 and 51 steps up from platforms 2/3, 5/6 and 7 (7.7-8.7 m at
        # 17 cm a step) and 37 steps from the tram stop (6.3 m): deck at 558.2-558.5 m, 8.3 m above the platforms.
        # The Stauffacherstrasse bridge at the east end of the platforms is level 1 too (47 steps = 8.0 m from
        # platform 1); its other stairs have no step count in OSM.
        'levels': {
            0: (0.0, 'Street level'),
            1: (8.3, 'Footbridge'),
        },
        'level_height': 4.0,
        'entrances': [
            ['Max-Dätwyler-Platz', -75, -50, 0],
            ['Rosalia-Wenger-Platz', -73, 72, 0],
            ['Stauffacherstrasse (bridge)', 130, -82, 1],
        ],
        'structures': [[135, -71, 1]],              # Stauffacherstrasse bridge, south half
        # swisstopo terrain: 549.9 at the foot of the small footbridge east of platform 2/3, 552.1-553.0 on its path
        # to Stauffacherstrasse: street level
        'ground': [[72, -37, 0], [152, -63, 0], [100, -45, 0]],
        'layers': ['sectors.json', 'spans.json', 'boards.json', 'furniture.json'],
        'credits': ['© swisstopo'],                 # terrain heights
    },
    'bruennen': {
        'name': 'Bern Brünnen Westside',
        'origin': (7.3752, 46.9440),
        'bbox': (46.9422, 7.3715, 46.9460, 7.3790),
        'extent': (-140, -60, 140, 85),
        'extent_cut': [(-140, 8, -70, 85)],         # the Westside centre itself
        'uics': ['8516154', '8582262'],
        # Two levels. The square with the tram loop and the bus stop (Gilberte-de-Courgenay-Platz) is level 0; the
        # railway runs along its south side on a terrace one storey higher, level 1, with a platform on each side
        # of the two tracks. Three stairs and a lift lead from the square up to platform 1. Platform 2 is reached
        # through a passage under the tracks, level with the square (OSM: tunnel=yes, layer=-1), with stairs and a
        # lift up at its far end, and by a footpath from Winterholzstrasse on the hillside behind it.
        # Heights: ATLAS has the tram and bus edges at 553.5 and 553.6 m above sea level and the two platform edges
        # at 558.0 and 558.7; swisstopo terrain (swissALTI3D, height service of api3.geo.admin.ch, 21.11.2026)
        # gives 553.3-553.4 on the square and 557.8-558.7 along platform 1; OSM counts 30, 32 and 33 steps from the
        # square to platform 1 and 31 from the passage to platform 2 (5.1-5.6 m at 17 cm a step). Level 1 is drawn
        # 5.0 m above the square (558.4 m), in the middle of these figures.
        # OSM has level=1 on platform 1 only (nothing on platform 2, the stairs, the lifts and the passage), and
        # the Westside centre next door counts its own floors from the basement: its ground floor, on the square,
        # is level=1 there (level:ref=0). level_shift puts the centre on the count of the station.
        'levels': {
            0: (0.0, 'Street level'),
            1: (5.0, 'Platform level'),
        },
        'level_height': 5.0,
        'level_shift': [(-400, 5, -45, 300, -1)],
        # The square is one open paved surface (swisstopo aerial image): OSM has its outline as place=square, the
        # pavements along its edge as two pedestrian areas and nothing across the tram loop and the bus bays.
        'squares': [[-10, 40]],
        'entrances': [
            ['Gilberte-de-Courgenay-Platz', 24, 18, 0],     # the square, at the mouth of the underpass
            ['Westside centre', -63, 45, 0],
            ['Riedbachstrasse', 38, 61, 0],
            ['Ramuzstrasse', 18, 76, 0],
            ['Winterholzstrasse', 94, 19, 1],
        ],
        'area_names': [[27, 10, 0, 'Underpass']],
        # The islands of the tram and the bus on the square are raised: the ATLAS accessibility data (PRM) has
        # their boarding edges at 27 cm (tram) and 16 cm (bus). Links across their long sides are for walkers only
        # (wheelchair: false, made by the builder for every square); a wheelchair goes round by the ends. OSM also
        # has the kerb between the pavements and the loop (way 654589097, barrier=kerb, no height, no lowered
        # points): it is not in the model. Both islands are wheelchair=yes in OSM and step-free in ATLAS, so there
        # are lowered kerbs; where they are is not in any source used here.
        # ATLAS has one name and the mode "bus" for the tram and the bus edges. The island under the roof next to
        # platform 1 is the tram's (OSM railway=platform with the tram stop position, 27 cm edge), the one north
        # of it the bus's (OSM highway=platform, bus stop position, 16 cm edge).
        'stop_names': [
            [13, 19, 'Bern Brünnen Westside, Bahnhof (tram)', 'tram'],
            [-2, 27, 'Bern Brünnen Westside, Bahnhof (bus)', 'bus'],
        ],
        # The footpath from the east end of platform 2 to Winterholzstrasse (way 67834886, no level in OSM) climbs
        # the slope behind the platform: swisstopo terrain (as above) gives 558.6 m where it leaves the platform,
        # 559.0 at its barrier 5 m on, 562.0 at its top and 561.7 on the street, 3.4 m in 37 m (9 %): its top is
        # 8.4 m above the square in this model, the street 8.1 m. The terrain model reads 0.6 m high at the
        # platform edge (ATLAS: 558.0), so the slope is good to about half a metre. The builder puts ground
        # within 0.15 of a level on that level and steepens the rest to make up for it (snap): the two heights
        # below are given 0.25 m lower so that the model comes out at 8.4 and 8.1 m, and the barrier, 0.4 m up,
        # stays on the level of the platform. The path then climbs 3.4 m in its last 31 m (11 %).
        # The path has a double cycle barrier (OSM: openable); whether a wheelchair passes it is not known.
        'spots': [[89.13, 19.17, 8.13, 'ground'], [93.53, 19.36, 7.9, 'ground']],
        'layers': ['furniture.json'],
        'credits': ['© swisstopo'],                 # terrain heights
    },
    'buempliz-nord': {
        'name': 'Bern Bümpliz Nord',
        'origin': (7.3900, 46.9459),
        'bbox': (46.9443, 7.3870, 46.9477, 7.3930),
        'extent': (-125, -70, 125, 60),
        'extent_cut': [(27, -70, 125, -45)],        # the paths around the Fellergut centre, south-east of the exit
        'uics': ['8504489', '8579523'],
        # Two levels. Level 0: the tracks with platform 2 at the station building and the island platform 4/5, the
        # forecourt and Mühledorfstrasse with the bus stop. Level -1: the pedestrian underpass, about 100 m long,
        # from the low ground on the Fellerstrasse side under the tracks, the station building and Mühledorfstrasse
        # to the Fellergut centre. It comes out level at both ends; stairs and a lift join it to the forecourt, stairs
        # to the island platform, and a side passage leads to the lift of the island platform.
        # OSM has no level=* here except on that lift ("0;-2"); the underpass is tunnel=yes with layer=-2, the side
        # passage layer=-1. Both are the one lower level of this model (-1): the builder puts the underpass there
        # because it passes under the tracks. The "-2" of the lift is in no table and no path arrives on it.
        # Heights: ATLAS has the platform edges at 555.3-555.4 m above sea level; swisstopo terrain (swissALTI3D,
        # height service of api3.geo.admin.ch, 21.11.2026) gives 555.5-555.8 on the platforms and the forecourt,
        # 555.0-556.3 on Mühledorfstrasse, 551.7 at the north mouth of the underpass, 552.1-552.3 along the side
        # passage and 552.4-552.7 at its south end. OSM counts 25 steps from the underpass to the forecourt (4.3 m at
        # 17 cm a step) and 18 from the side passage to the island platform (3.1 m). The underpass is drawn 3.7 m
        # below the platforms (551.7 m): the measured mouth, and the middle of the two stairs. An estimate to
        # within about half a metre: the floor itself cannot be measured from the air.
        'levels': {
            -1: (-3.7, 'Underpass'),
            0: (0.0, 'Street level'),
        },
        'level_height': 3.7,
        # Corrections to OpenStreetMap from the cadastral survey of the City of Bern (Amtliche Vermessung, open data
        # of Geoinformation Stadt Bern; the outlines used are in Santiago-de-Claude-research/bern-transit-3d/
        # bern-research/stations/data/focus/8504489-bern-buempliz-nord.geojson), checked against the swisstopo
        # aerial image on 21.11.2026.
        'osm_edits': [
            # The stairs between the main underpass and the island platform. The survey has two ("Wichtige
            # Treppe"), one each side of the underpass, 9.4 m long: the west one from its foot at (-5.8, 18.5) up
            # to (-15.1, 16.8), the east one from (3.8, 20.2) up to (13.0, 21.9). OSM has only the west one (way
            # 1355631683), drawn from the middle of the underpass to the foot of the real stairs, so its top
            # came out 8.6 m too far east, in the small building that stands over the underpass there.
            ['move', 14166031860, -5.84, 18.47],
            ['move', 12546099519, -15.06, 16.82],
            ['drop', 1355631683],
            ['way', [12546099518, 14166031860], {'highway': 'footway', 'tunnel': 'yes', 'layer': '-2'}],
            ['way', [14166031860, 12546099519], {'highway': 'steps', 'incline': 'up'}],
            ['node', 'east foot', 3.75, 20.21],
            ['way', [12546099518, 'east foot'], {'highway': 'footway', 'tunnel': 'yes', 'layer': '-2'}],
            ['way', ['east foot', [13.0, 21.86]], {'highway': 'steps', 'incline': 'up'}],
            # The stairs between the side passage and the island platform (OSM way 1372264312, 18 steps): in the
            # survey from the foot at (-29.6, 14.8), on the west wall of the passage, up to (-37.2, 12.5); OSM
            # has them 7 m further east, across the passage. The path on the platform from their top to the lift
            # (way 1372264311) goes with them, past the north side of the stairwell.
            ['node', 'side foot', -29.64, 14.84],
            ['move', 12706575454, -37.19, 12.5],
            ['move', 12706575455, -30.5, 16.2],
            ['drop', 1372264312],
            ['way', [12706575453, 'side foot'], {'highway': 'footway', 'tunnel': 'yes', 'layer': '-1'}],
            ['way', ['side foot', 12706575454], {'highway': 'steps', 'incline': 'up', 'step_count': '18'}],
            # The station building. OSM has one outline for the building, the open forecourt under its roof and
            # the pavilion with the lift (way 96140022, 4 storeys): in the model the forecourt, its stairs and the
            # lift then stand inside a block. The survey has the building itself (x -57 to -13) and the pavilion
            # (x -5 to 12) as two buildings with the forecourt between them. Storeys of the building as in OSM;
            # the pavilion has one (aerial image). The roof over the forecourt is in neither source and is left out.
            ['drop', 96140022],
            ['way', [[-21.25, -5.84], [-22.43, -6.15], [-21.99, -8.58], [-37.49, -11.37], [-57.13, -15.04],
                     [-55.71, -22.89], [-36.04, -19.32], [-35.41, -22.74], [-12.75, -18.65], [-14.82, -7.3],
                     [-15.55, -4.75], [-21.25, -5.84]],
             {'building': 'train_station', 'building:levels': '4', 'roof:levels': '1'}],
            ['way', [[-5.01, -5.54], [-3.71, -5.66], [-2.56, -11.95], [-3.72, -12.5], [11.58, -9.75], [10.31, -2.76],
                     [-5.01, -5.54]], {'building': 'yes', 'building:levels': '1'}],
            # The roof over the island platform (survey: "Unterstand", 65 m long). Its height is not in any
            # source: 4 m is an estimate.
            ['way', [[-13.41, 20.14], [-23.24, 18.37], [-45.49, 14.37], [-44.52, 8.79], [19.36, 20.12],
                     [18.39, 25.71], [-13.41, 20.14]], {'building': 'roof', 'height': '4'}],
        ],
        # ATLAS has one name for the two bus edges. They are on opposite sides of Mühledorfstrasse.
        'stop_names': [
            [-26, -39, 'Bern Bümpliz Nord, Bahnhof (station side)', 'bus'],
            [52, -36, 'Bern Bümpliz Nord, Bahnhof (across the road)', 'bus'],
        ],
        'entrances': [
            ['Mühledorfstrasse', -9, -28, 0],
            ['Fellerstrasse (underpass)', -4, 27, -1],      # its north exit
            ['Fellergut (underpass)', 24, -67, -1],         # its south exit
        ],
        # Mühledorfstrasse in front of the station: OSM has the two pavements and no crossing between them for
        # 100 m either way. The swisstopo aerial image shows a raised crossing table there (chequered ramps at
        # x = 0 and x = 12): people cross on it to the bus stop on the far side.
        'links': [[6, -33, 6, -44, 0]],
        # The side passage to the lift of the island platform, and the two short pieces between the underpass, the
        # stairs and the lift at the station building: floors of the underpass, flat. (The steps counted on their
        # stairs put them 0.6 m above and below the level, which would make ramps of them.)
        # The same for the three pieces of floor between the underpass and the feet of the stairs to the island
        # platform (osm_edits above; the two main stairs have no steps counted), and for the underpass itself,
        # which the steps counted on the stairs at its two ends would otherwise tilt by 0.4 m.
        'structures': [[-23.4, 20, -1], [-12, 26, -1], [11.7, -10.9, -1], [9.4, -10.4, -1],
                       [-2.8, 18.8, -1], [2.0, 19.7, -1], [-26.2, 15.9, -1], [12.5, -30, -1]],
        'layers': ['furniture.json'],
        'credits': ['© swisstopo', 'Geodaten Stadt Bern'],   # terrain heights, aerial image; cadastral survey
    },
    'zurich': {
        'name': 'Zürich HB',
        'origin': (8.5375, 47.3780),
        'bbox': (47.3748, 8.5322, 47.3808, 8.5430),
        # The station building with the main hall in the east, the platforms 3-18 to the west, Löwenstrasse (31-34)
        # under the tracks, Museumstrasse (41-44) under the north side, the SZU station and ShopVille under
        # Bahnhofplatz, and the tram and bus stops around it. Central (across the Limmat), the long-distance bus
        # station at Sihlquai and Löwenplatz are left out.
        'extent': (-340, -280, 380, 240),
        # The SZU station (8503088, tracks 21/22 on level -2) is left out for now: it is being rebuilt and closed
        # until the timetable change of 13 December 2026 (szu.ch), and OSM has it as disused with its platform gone.
        # Add it back once OSM has the new platform.
        'uics': ['8503000', '8587348', '8587349', '8591067', '8591368', '8591367'],
        'notices': [
            {'text': 'The SZU station (tracks 21/22, Uetliberg and Sihltal lines) is closed for its rebuild until '
                     '13 December 2026', 'until': '2026-12-13'},
        ],
        # OSM numbers the floors of the whole complex in one scheme: 0 = the platforms 3-18 and the main hall, -1 =
        # ShopVille, -2 = the passages (Löwenstrasse, Gessnerallee, Sihlquai, Bahnhofstrasse) and the SZU station,
        # -3 = Museumstrasse, -4 = Löwenstrasse. Heights relative to the surface of platforms 3-18 (track 408 m above
        # sea level by OSM ele):
        #   -1  -5.8   31 stairs from level 0, median 34 steps (17 cm a step)
        #   -2  -8.3   48 steps from level 0 (8 stairs), 14-16 steps from -1: -8.2 / -8.4
        #   -3  -14.5  39-40 steps from -2: -15.0; tracks of 41-44 at 394 m (OSM ele): -14
        #   -4  -16.3  50 steps from -2 (-16.8), 62 from -1 (-16.3); tracks of 31-34 at 392 m (OSM ele): -16
        # One level has one height: the SZU tracks (OSM ele 396, -12) are on -2 like the passages above them.
        # Levels 1 and up are the upper floors of the station building and its neighbours (offices, a canteen,
        # stairwells): no measured heights, extrapolated with level_height; the builder leaves out those that
        # carry no public walkable space.
        'levels': {
            -4: (-16.3, 'Löwenstrasse'),
            -3: (-14.5, 'Museumstrasse'),
            -2: (-8.3, 'Passages'),
            -1: (-5.8, 'ShopVille'),
            0: (0.0, 'Street level'),
        },
        'level_height': 4.0,
        'entrances': [
            ['Bahnhofplatz', 194, -75, 0],
        ],
        # SBB open data (tools/station3d_sbb_layers.py zurich): sector signs of tracks 3-18 (the signs carry their
        # own sector's letter on both faces), sector centres from them, clocks and ticket machines. data.sbb.ch has
        # no sector signs for Löwenstrasse and Museumstrasse.
        'layers': ['sectors.json', 'boards.json', 'furniture.json'],
        # SBB lists clocks and ticket machines by section ("bps_name"): these sections are underground
        'sbb_sections': {'Zurich HB Lowenstrasse': -4, 'Zurich HB Museumstrasse': -3},
    },
    'basel': {
        'name': 'Basel SBB',
        'origin': (7.5895, 47.5475),
        'bbox': (47.5440, 7.5830, 47.5500, 7.5940),
        # The station building on Centralbahnplatz with the tram and bus stops in front of it, the platforms 1-20
        # (OSM draws them up to 650 m long; the extent keeps 390 m east and 420 m west of the hall), the French
        # platforms 30-35 in the west wing, the Passerelle over the tracks to Gundeldingen (Güterstrasse, tram stop
        # Bahnhofeingang Gundeldingen), the Postpasserelle in the east, the provisional footbridge in the west
        # (open since December 2025), and the Elisabethen-Passage under Centralbahnplatz.
        'extent': (-420, -260, 390, 200),
        # Left out: the tram stops Markthalle (north-west) and IWB with the Margarethenbrücke (south-west), which are
        # stops of their own; the houses of Gundeldingen west of the tram stop (a café door there is a named
        # entrance in OSM, not one of the station).
        'extent_cut': [(-420, 95, -140, 200), (-420, -260, -250, -45), (-420, -260, -175, -190)],
        # Basel SBB (tracks 1-20 and the SNCF tracks 30-35, all one stop in ATLAS), Basel, Bahnhof SBB (tram and
        # bus on Centralbahnplatz), Basel, Bahnhofeingang Gundeldingen (tram on Güterstrasse)
        'uics': ['8500010', '8578143', '8500146'],
        # ATLAS files every edge of "Basel, Bahnhof SBB" (8578143) as tram, but bays A, B, C and K on Centralbahnplatz
        # serve buses only (OSM: bus=yes on their stop positions and platforms, no tram=yes): modes from OSM
        'modes_from_osm': True,
        # Level 0 is the surface of the platforms, about 277 m above sea level: swisstopo terrain (swissALTI3D,
        # height service of api3.geo.admin.ch, 21.11.2026) reads 276.0-278.4 along the platforms (median 276.9 of
        # 28 points; under the roofs it is the track bed, interpolated), ATLAS has the platform edges at 275.4-278.4.
        # The streets are drawn on level 0 too, where OSM puts them: Centralbahnplatz and the hall are really 1.0 to
        # 1.7 m higher (terrain 278.0-278.7, ATLAS tram and bus edges 278.2-278.7), Güterstrasse and Meret
        # Oppenheim-Platz on the Gundeldingen side 2.5 to 3 m higher (terrain 279.3-280.1, ATLAS tram edges 279.5).
        #   -1  -3.5   the hall basement and the Elisabethen-Passage under Centralbahnplatz: 23 steps down from the
        #              hall (3.9 m at 17 cm a step), 20 up to the Elisabethenanlage (3.4 m), 21 up to Baloise Park
        #              (3.6 m); from the terrain at the top of those stairs the floor is at 272.9-274.1 m, -2.9 to
        #              -4.1. The model takes what the stairs climb from the streets as drawn.
        #    1  +6.6   the Passerelle (RailCity), the Postpasserelle and the provisional footbridge: OSM counts 38-45
        #              steps from the platforms up to the Passerelle (median 42: 6.5 m at 15.5 cm, 7.1 m at 17 cm), 42
        #              to the Postpasserelle; from Güterstrasse (+2.5 to +3) 19 steps up to the Passerelle (+5.5 to
        #              +6.2). The provisional footbridge stands higher: 48 steps from the platforms (7.4-8.2 m) and
        #              27 from Güterstrasse (+6.8 to +7.2). One level has one height: +6.6 is the middle of these.
        # OSM also has levels 0.25 and 0.5 in the hall (the ramps from the Passerelle down into it), drawn at
        # heights in between, and level 2 on the Postpasserelle (see osm_edits) and on upper floors of shops.
        # Because Güterstrasse is drawn on level 0 (OSM tags the ground floor of Bahnhof Süd level=0), the ramp from
        # it up to the Passerelle (way 376386225, 26 m) comes out at 26 % instead of the 12-15 % its 3.2-4 m really
        # climb: it is marked not for wheelchairs; the lift beside it is the step-free way, as in reality.
        'levels': {
            -1: (-3.5, 'Lower level'),
            0: (0.0, 'Street level'),
            1: (6.6, 'Passerelle'),
        },
        'level_height': 4.0,
        'entrances': [
            ['Centralbahnplatz (main hall)', 5, 34, 0],      # OSM: railway=train_station_entrance, entrance=main
            ['Gundeldingen (Güterstrasse)', -126, -210, 0],  # the foot of the Passerelle at Bahnhof Süd
            ['Meret Oppenheim-Platz (Postpasserelle)', 133, -192, 0],
            ['Centralbahnstrasse (west wing, tracks 30-35)', -128, 44, 0],
            ['Güterstrasse (provisional footbridge)', -238, -90, 0],
        ],
        'osm_edits': [
            # The Postpasserelle (way 23585585) is tagged level=2, but each of its seven stairs down to the
            # platforms is tagged level=0;1 with 42 steps, like the stairs of the Passerelle, and the path at its
            # south end is level=1. SBB's station plan (Innenplan, 02/2026) shows it as an access to tracks 1-12.
            # Same way, same nodes, level=1.
            ['drop', 23585585],
            ['way', [255404727, 1385073077, 1383459828, 1385073064, 1385073071, 1385073054, 1385073057, 1651902725,
                     1180586380],
             {'bridge': 'yes', 'description': 'Postpasserelle', 'highway': 'footway', 'indoor': 'yes', 'layer': '2',
              'level': '1', 'name': 'Postpasserelle'}],
            # The 8 m from the Passerelle to the door of the lift at the Flying Tiger shop (way 1273058936) is tagged
            # level=0;1, which makes it a ramp of 7 m in 8 m; the lift (way 1306147450, level 0;1) does the climbing,
            # and the door node 12097008874 is level=1. Same nodes, level=1.
            ['drop', 1273058936],
            ['way', [11821830258, 13718663696, 12097008874],
             {'highway': 'footway', 'indoor': 'yes', 'layer': '1', 'level': '1', 'wheelchair': 'yes'}],
            # The stairs between Güterstrasse and the Passerelle at Bahnhof Süd are drawn twice, 4 m apart and both
            # 26 m long: way 1227358519 with level=1;0, way 1518317194 with step_count=19 and no level, whose top ends
            # on the level-0 corridor at the lift. The second is dropped; its 19 steps are in the level table above.
            ['drop', 1518317194],
            # The ramp of the Centralbahn-Passage up to Centralbahnstrasse is two ways, 25 m and 5 m, each tagged
            # level=-1;0 (ways 557976342 and 1063805094), so the short one came out as a 70 % slope. One way, one
            # climb.
            ['drop', 557976342],
            ['drop', 1063805094],
            ['way', [5380623519, 8828194235, 8828194234],
             {'highway': 'footway', 'level': '-1;0', 'lit': 'yes', 'ramp': 'yes', 'surface': 'asphalt'}],
            # Platform 1/2 begins where tracks 1 and 2 end (buffer stops at x 100-106), at the head platform along
            # the east wing (relation 17880866, level 0, from the hall to x 102). OSM draws the two outlines touching
            # over 8 m with no path between them, so platform 1/2 was reached only by the Postpasserelle stairs. SBB's
            # plan (02/2026) shows tracks 1-4 reached at street level from the hall. A walk across the border:
            ['way', [[90, -47], [99, -55]], {'highway': 'footway', 'level': '0', 'covered': 'yes'}],
        ],
        # SBB open data (tools/station3d_sbb_layers.py basel): sector signs, sector centres, clocks, ticket machines.
        # SBB has one section ("Basel SBB") for all of them: no sbb_sections.
        'layers': ['sectors.json', 'boards.json', 'furniture.json'],
        # Closures (checked 21.11.2026): none found. OSM has nothing under construction on the ways of the station.
        # The provisional footbridge at the west end opened at the timetable change of December 2025 (OSM start_date
        # 2025-12-06; SRF), and stays until the permanent access from the Margarethenbrücke of the 2030s (canton of
        # Basel-Stadt, project Basel SBB West); SBB's plan of 02/2026 shows it. The old underpass under tracks 5-12 is open only as an exit at rush hour (SRF,
        # 12.08.2020) and is access=private in OSM: not in the model. No closure of a platform, a stair or a lift at
        # Basel SBB appears in SBB's, the canton's or SRF's news for 2026.
        # ATLAS has three edges of Bahnhofeingang Gundeldingen without a letter: two beside edges L and M on
        # Güterstrasse, and one in the middle of the platforms, on platform 19/20 (277.6 m; no tram stop, track or
        # OSM stop position there, 100 m from the tram line): that one is left out, else a route "to the tram at
        # Gundeldingen" ends on a train platform.
        'skip_edges': [['8500146', -98, -127, 'an ATLAS edge of the Güterstrasse tram stop on platform 19/20']],
        'credits': ['© swisstopo'],                 # terrain heights
    },
    'luzern': {
        'name': 'Luzern',
        'origin': (8.3105, 47.0500),
        'bbox': (47.0460, 8.3050, 47.0530, 8.3145),
        # The terminus: the hall behind the Torbogen, the platforms 2-15 to the south (SBB 2-11, Zentralbahn 12-15,
        # all at street level; OSM draws them up to 440 m long), the shopping level under the hall and Bahnhofplatz,
        # the underpass across the platforms in the south (Zentralstrasse to Frohburgstrasse), the buses on
        # Bahnhofplatz and Frohburgstrasse (edges X, N) and the boat landings 1-6 on Bahnhofquai.
        # The Zentralbahn does not stop underground here: its trains use tracks 12-15 at street level (OSM, ATLAS;
        # the underground through station is a project, OSM: proposed).
        'extent': (-140, -440, 190, 180),
        # Left out: the university building, its car park (levels 1-3) and the Frohburgsteg over the tracks east of
        # the platforms (not ways to the trains), except the east mouth of the underpass.
        'extent_cut': [(100, -440, 190, -20), (63, -115, 100, -20), (63, -440, 100, -180), (82, -180, 100, -155)],
        'osm_edits': [
            # Also left out: the walkway from the south end of platform 14/15 up two flights of stairs to the car
            # park bridge, which goes on north to Frohburgstrasse (ways 1460976218, 1460976217, 115823563, layer 1,
            # no step counts). OSM gives the bridge level=1 and no height, and joins its north end (way 592182340)
            # straight onto the street pavement without any climb, so neither end can be placed; the builder
            # disconnects that end as a slip, which left the stairs as a dead end. These three ways sit inside the
            # extent next to platform 14/15, so they are dropped here rather than cut out with a box.
            ['drop', 1460976218],
            ['drop', 1460976217],
            ['drop', 115823563],
        ],
        # Luzern (trains), Luzern, Bahnhof (buses), Luzern Bahnhofquai (boats, landings 1-4). Luzern, Inseliquai/Bahnhof
        # (8502058) is a stop of its own 70 m beyond the extent.
        'uics': ['8505000', '8508450', '8508492'],
        # Level 0 is the surface of the platforms and the streets around, all about 436 m above sea level: ATLAS has
        # the platform edges at 435.5-437.0 (median 436.6) and the bus edges on Bahnhofplatz at 435.1-436.0;
        # swisstopo terrain (swissALTI3D, height service of api3.geo.admin.ch, 21.11.2026) 435.7-436.4 on the
        # platforms, 435.2-436.1 on Bahnhofplatz, 436.0-436.4 at both mouths of the south underpass. Only the quay
        # of the boat landings is lower (ATLAS 434.0-435.0); it is drawn on level 0.
        #   -1  -5.0   the shopping level under the hall and Bahnhofplatz, and the south underpass: OSM counts 33
        #              steps from the hall (5.6 m at 17 cm a step), 21, 27, 27 and 29 from Bahnhofplatz and
        #              Pilatusstrasse (3.6-4.9 m), 29-31 from the platforms to the underpass (4.9-5.3 m) and 26 from
        #              its west mouth (4.4 m); the middle of these
        #    1  +5.6   the gallery of the hall: estimate. OSM counts no steps up to it; its escalators are drawn 13 m
        #              long, like the escalators down to level -1 beside them, whose stairs count 33 steps.
        # The levels 2-7 of OSM are the university, its car park and offices, outside the extent or not public.
        'levels': {
            -1: (-5.0, 'Lower level'),
            0: (0.0, 'Street level'),
            1: (5.6, 'Gallery'),
        },
        'level_height': 4.0,
        'entrances': [
            ['Bahnhofplatz (main hall)', -17, 37, 0],       # OSM: entrance=main
            ['Pilatusstrasse', -145, 10, 0],                # OSM: entrance=main
            ['Zentralstrasse (south underpass)', -74, -255, 0],
            ['Frohburgstrasse (south underpass)', 94, -126, 0],
            ['Bahnhofquai (boats)', 40, 140, 0],
        ],
        # Bus edges on Bahnhofplatz: the city of Luzern has been building more bus edges on Bahnhofplatz and
        # Pilatusstrasse since 18 May 2026 for the new bus network of the timetable change of 13 December 2026
        # (media release of the city, 15.07.2026; vbl.ch/dmp). ATLAS already lists the new edges C-H at the Torbogen;
        # OSM has D, E and F there as disused, access=no, start_date=2026-12-13 ("Gültig ab FPW27"), and the bus
        # lane to G and H with the same start date. They are closed in the model until then. OSM notes that from that
        # day today's edge A becomes B and today's B becomes C, and a new A opens on Pilatusstrasse.
        'closed': [
            {'uic': '8508450', 'refs': ['C', 'D', 'E', 'F', 'G', 'H'], 'until': '2026-12-13',
             'note': 'New bus stop, in use from 13 December 2026'},
            # today's A and B keep their place but change letters on 13 December (OSM notes, as above): a note on
            # each, until a rebuild with the ATLAS data of the new timetable moves A to Pilatusstrasse
            {'uic': '8508450', 'refs': ['A'],
             'remark': 'From 13 December 2026 this bus edge is B; the new edge A is on Pilatusstrasse'},
            {'uic': '8508450', 'refs': ['B'], 'remark': 'From 13 December 2026 this bus edge is C'},
        ],
        'notices': [
            {'text': 'Building works on Bahnhofplatz: several bus lines leave from other stops than usual until '
                     '13 December 2026; lines 11 and 18 end at Pilatusplatz', 'until': '2026-12-13'},
            {'text': 'New bus network from 13 December 2026: on Bahnhofplatz edge A becomes B and edge B becomes C, '
                     'new edges C to H at the Torbogen and A on Pilatusstrasse', 'from': '2026-12-13',
             'until': '2027-03-01'},
        ],
        # Frohburgstrasse and its pavements are at street level (swisstopo terrain 435.6-436.1, ATLAS bus edges X and
        # N 435.4-435.6). OSM joins the walkway up to the car park bridge (way 592182340, level=1) straight onto
        # the pavement, which pulled the pavement up to level 1 and bus edge X with it; the builder makes the last
        # piece of that walkway the slope.
        'ground': [[75, -25, 0], [130, -19, 0]],
        # the underpass across the platforms (OSM: a level -1 corridor area, unnamed)
        'area_names': [[0, -205, -1, 'South underpass']],
        # SBB open data (tools/station3d_sbb_layers.py luzern): sector signs, sector centres, clocks, ticket machines.
        # SBB's sections here are "Luzern" and "Luzern Cargo" (11 clocks, 1 ticket machine), none underground: no
        # sbb_sections.
        'layers': ['sectors.json', 'boards.json', 'furniture.json'],
        # Closures of the railway station (checked 21.11.2026): none found; OSM has nothing under construction on
        # the ways of the station. The works on Bahnhofplatz are above (closed, notices).
        'credits': ['© swisstopo'],                 # terrain heights
    },
    'lausanne': {
        'name': 'Lausanne',
        'origin': (6.6291, 46.5168),
        'bbox': (46.5138, 6.6235, 46.5198, 6.6345),
        # The station on its terrace in the slope: tracks 1 and 3-8 (there is no track 2) and 70, the short track at
        # the east end of the platform of track 1, with the station building, Place de la Gare above it in the north with the bus stops and the m2 station
        # Lausanne-Gare under it, the two underpasses under the tracks (west, and east from the hall) and Rue du
        # Simplon below the tracks in the south, where they come out. Left out: the m2 stop Grancy, the buses of
        # Rasude, Closelet and Montbenon, and the hillside of Petit-Chêne above Place de la Gare.
        'extent': (-335, -110, 330, 240),
        # Lausanne (train) and Lausanne, gare (m2 and the buses on Place de la Gare: ATLAS has both under 8592050)
        'uics': ['8501120', '8592050'],
        # OSM counts the floors from the platforms: 0 = the platforms, the hall and Place de la Gare; -1 = the
        # underpasses and the m2 station; -2 = the south end of the east underpass, at the level of Rue du Simplon.
        # Heights relative to the surface of the platforms, 447.3 m above sea level (swisstopo terrain, swissALTI3D,
        # height service of api3.geo.admin.ch, 21.11.2026: 447.0-447.7 on platforms 1 to 7/8):
        #   -1  -4.8   28 steps on each of the six stairs between the platforms and the east underpass (17 cm a
        #              step). One level has one height: the west underpass rises towards its north mouth (20 steps
        #              up to Place de la Gare there, which lies at 449.2: the floor is about -1.3 at that end; the
        #              ramp beside those stairs, way 344135870, 22 m and wheelchair=yes in OSM, comes out at 22 % in
        #              the model and does not count as step-free), and the m2 platform slopes at 12 % (OSM incline);
        #              its upper end is about -2.6 (26 steps down from the street at 449.1). The m2 stop's ele=455
        #              in OSM is the value of the bus stops above it, not a measurement.
        #   -2  -8.6   26 steps from -1 at the south end of the east underpass (-9.2 by the steps); swisstopo
        #              terrain gives 439.3 at its south mouth and 438.1-439.3 along Rue du Simplon (-8.0 to -9.2)
        #    1, 2, 3   not in the table: extrapolated with level_height (4 m a level). OSM has level=1 and 3 only on
        #              a few shops and a café on upper floors along Rue du Petit-Chêne, with no source for a height;
        #              the model's Level 1 and Level 2 are a few points of the street that climbs west of Place de la
        #              Gare (spots below), where it passes those heights
        # One level has one height for the street too: OSM ends the stairs and ramps from the underpasses and the
        # m2 on Place de la Gare on level 0, and the model draws the square in front of the station at the height of
        # the platforms, while swisstopo terrain has it 1.7 m higher (449.0-449.2 in front of the m2 and at the
        # mouth of the west underpass; 447.4-448.5 at the east end).
        'levels': {
            -2: (-8.6, 'Rue du Simplon'),
            -1: (-4.8, 'Underpasses'),
            0: (0.0, 'Street level'),
        },
        'level_height': 4.0,
        # Petit-Chêne, the steep street up to the town from the east end of the square: not part of the complex
        'extent_cut': [(-40, 92, 330, 240)],
        'entrances': [
            ['Place de la Gare (main entrance)', 10, 38, 0],
            ['Place de la Gare (west underpass)', -40, 88, 0],
            ['Rue du Simplon (east underpass)', 70, -70, -2],
            ['Rue du Simplon (west underpass)', -55, -60, -2],
        ],
        # The west underpass comes out on Rue du Simplon over a landing that OSM has as a bridge without a level
        # (ways 1425301684 and 1425301685, layer=1), with stairs and a lift down to the street: the landing is the
        # floor of the underpass, which it continues.
        'structures': [[-67.8, -52, -1], [-69.4, -55.3, -1]],
        # Place de la Gare climbs 14 m to the west, past the bus stops C, D, E and I. swisstopo terrain (as above) at
        # the corners of its two pavements (OSM ways 862084481 north side, 995959770 south side), given relative to
        # the part of the square in front of the station (449.0 m, which the model draws on level 0, see above), so
        # that the climb comes out right: 451.2 m at x = -112, 454.9 at -187, 459.6 at -253, 463.5 at -311.
        'spots': [
            [-52.3, 91.5, 0.2, 'ground'], [-70.1, 101.8, 0.8, 'ground'], [-111.5, 127.0, 2.2, 'ground'],
            [-124.4, 134.8, 2.8, 'ground'], [-143.5, 146.4, 3.6, 'ground'], [-186.9, 172.7, 5.9, 'ground'],
            [-205.1, 183.7, 7.2, 'ground'], [-221.7, 193.9, 8.2, 'ground'], [-235.0, 201.9, 9.3, 'ground'],
            [-252.8, 213.0, 10.6, 'ground'], [-310.7, 247.5, 14.5, 'ground'],
            [-120.5, 114.0, 2.2, 'ground'], [-182.7, 151.4, 5.1, 'ground'], [-231.4, 180.7, 8.3, 'ground'],
            [-243.5, 188.0, 9.1, 'ground'], [-257.5, 196.5, 10.0, 'ground'], [-320.0, 234.0, 14.5, 'ground'],
        ],
        # Rue du Simplon falls to the west: 439.3 at the south mouth of the east underpass, 437.3-437.4 at the stairs
        # and the lift that bring the west underpass down to it (OSM ways 1425301684-1425301687, lift node
        # 13100595957, no levels). The street there is put on level -2, like the other end (1.3 m too high).
        'ground': [[-69.8, -56.6, -2], [-54.9, -59.7, -2]],
        # The bus stops C, D, E and I on the climbing part of the square: OSM has their waiting areas as platforms
        # without a level (ways 1041897644-1041897647), 17-47 m long along the pavement. The builder draws a platform
        # flat on one level, which here leaves one end of C 1.6 m above or below the pavement it lies on, and puts I on
        # the wrong level. Without them the stops stand on the pavement at its measured height; nothing else uses them.
        # ATLAS has the edge of I without its letter, and two edges of Lausanne, gare without a letter: the m2
        # (OSM: Lausanne-Gare, railway=halt, level -1) and I. stop_names tells them apart. The m2 stop stands on one of
        # the two side platforms of the m2 (OSM ways 315754586/315754587); ATLAS has one edge for both.
        # ATLAS has edge F at (208, 46), where OSM has a platform G (way 1218037926); OSM's platform F is 90 m further
        # east and drawn without a way to it. The stop stays at the ATLAS position.
        'stop_names': [
            [-270, 207, 'Lausanne, gare I', 'bus'],
            [38, 88, 'Lausanne-Gare (m2)', 'train'],
        ],
        # ATLAS has one edge of the m2 for its two side platforms (OSM ways 315754586 and 315754587); the stop is
        # matched to the west one. The passage from the east underpass (closed until 18 Dec, above) reaches the east
        # one (node 3473841559 is on its outline): both belong to the stop, so a route to the m2 can use it.
        'stop_areas': [['8592050', 'Lausanne-Gare (m2)', 47.3, 93.8, 'the east side platform of the m2, where the passage arrives']],
        # Works (Léman 2030, the rebuild of the station and of Place de la Gare):
        # - lausanne.ch, "Fermeture du passage" (Pôle Gare, files of 22-23 Sep 2026): the part of the east underpass
        #   under Place de la Gare between the station and the m2 is closed from 25 Sep 2026, 21:00, until 18 Dec
        #   2026 (works on the new underground level of the square). The m2 is reached on the surface; the east side
        #   of the station step-free by the lift of platform 1. OSM (21.11.2026) has the passage as foot=no, without
        #   a date: the east underpass north of the station building (way 1561897395), its way west to the m2 (way
        #   313989605) and a branch (way 345760467). That would leave them out; osm_edits below keep them in the
        #   model, closed until that date (opens). The short tunnel at the north end, with its stairs and lift up to
        #   Place de la Gare, is open in OSM. Where the temporary stairs the CFF set up for the m2 are, the page does
        #   not say; they are not in the model.
        # - OSM: the new platform ("quai 5") south of 7/8 is being built where track 9 was (landuse=construction
        #   "Chantier Gare de Lausanne", construction=quai_5, opening_date 2030-12-31; track 9 railway=disused);
        #   ATLAS has no stop there today. The new underpasses are not open (CFF: works from the end of
        #   2026, platforms in stages 2030-2036) and are not in OSM.
        'opens': {'date': '2026-12-18',
                  'note': 'The passage between the east underpass and the m2 under Place de la Gare is closed for '
                          'works until 18 December 2026'},
        'notices': [
            {'text': 'The underground passage between the station and the m2 is closed until 18 December 2026: '
                     'follow the signs to the m2 on the surface. Step-free to the east underpass: lift of platform 1',
             'from': '2026-09-25', 'until': '2026-12-18'},
        ],
        'osm_edits': [
            # the waiting areas of the bus stops C, D, E and I (see above)
            ['drop', 1041897644], ['drop', 1041897645], ['drop', 1041897646], ['drop', 1041897647],
            # the closed passage to the m2 (see above), as under construction until the date the city gives
            ['drop', 1561897395], ['drop', 313989605], ['drop', 345760467],
            ['way', [3524096453, 3200281824], {'highway': 'construction', 'construction': 'footway', 'level': '-1',
                                               'layer': '-1', 'tunnel': 'yes', 'wheelchair': 'yes',
                                               'opening_date': '2026-12-18'}],
            ['way', [3200281824, 3473841559], {'highway': 'construction', 'construction': 'footway', 'level': '-1',
                                               'layer': '-1', 'tunnel': 'yes', 'wheelchair': 'yes',
                                               'opening_date': '2026-12-18'}],
            ['way', [3524096463, 3524096455, 3524096453], {'highway': 'construction', 'construction': 'footway',
                                                           'layer': '-1', 'tunnel': 'yes',
                                                           'opening_date': '2026-12-18'}],
        ],
        # SBB open data (tools/station3d_sbb_layers.py lausanne): sector signs of tracks 1, 3-8 and 70 (at the borders
        # between two sectors, "B|C"), sector centres from them, clocks and ticket machines. SBB lists all of them in
        # one section ("Lausanne"), none underground: no sbb_sections.
        'layers': ['sectors.json', 'boards.json', 'furniture.json'],
        'credits': ['© swisstopo'],                 # terrain heights
    },
    'geneve': {
        'name': 'Genève',
        'origin': (6.1423, 46.2102),
        'bbox': (46.2075, 6.1375, 46.2140, 6.1470),
        # Genève-Cornavin: the station building on Place de Cornavin with its hall, the platforms 1-7 (and 10, the
        # short track at the south-west end of platform 4/5) on the embankment above it, the passages under the tracks
        # to the Montbrillant side, the Metro Shopping mall under Place de Cornavin, and the tram and bus stops around
        # it (Gare Cornavin A-L). Left out: the stops Coutance, Chantepoulet, Lyon and Poste, and the parking floors
        # under the square (levels -2 and -3 of its lifts).
        'extent': (-230, -175, 210, 350),
        'extent_cut': [(-230, 240, 90, 350)],      # passages through the blocks of Rue de Lausanne, north of the station
        'uics': ['8501008', '8587057'],
        # OSM counts the floors from the street: 0 = the hall and Place de Cornavin, 1 = the north part of the passages
        # and the Montbrillant side, 2 = the platforms, -1 = Metro Shopping. Level 0 stays the street (the shell of
        # the buildings stands on it); heights relative to level 0 and, in brackets, to the platforms:
        #    2  +7.9 (0)    swisstopo terrain (swissALTI3D, height service of api3.geo.admin.ch, 21.11.2026) gives
        #                   391.6-392.9 on the platforms and 383.2-384.9 on Place de Cornavin in front of the hall
        #                   (+7.0 to +9.7); the step counts add up to +6.6 to +8.7 (20 steps from 0 to 1, 19, 27 and
        #                   31 from 1 to 2; 17 cm a step). OSM's ele of the tram and bus stops (327) is not a height.
        #    1  +3.4 (-4.5) the passages under the tracks and the Montbrillant side: 20 steps up from 0, and the three
        #                   escalators beside them, 5 m long in plan, climb at most 3.5 m at 35 degrees; from 2 down:
        #                   27 steps (+3.3), the escalators of about 8 m in plan (+3.3 to +3.5 at 30 degrees), 19 and
        #                   31 steps (+4.7, +2.6). swisstopo terrain has the streets of the Montbrillant side higher,
        #                   388.5-389.3 at Place de Montbrillant and Place du Reculet (+4.1 to +4.9): the passages rise
        #                   to them. One level has one height: the three ramps between this level and the platforms
        #                   (24-27 m) come out at 17-19 % here, too steep to count as step-free; the lifts are.
        #   -1  -3.6 (-11.5) 20, 21 and 21 steps from 0 (29 on one stair: -4.9)
        #   -2, -3          the parking under the square (only its lifts are in OSM): left out by the builder
        'levels': {
            -1: (-3.6, 'Metro Shopping'),
            0: (0.0, 'Street level'),
            1: (3.4, 'Montbrillant level'),
            2: (7.9, 'Platforms'),
        },
        'level_height': 3.5,
        'entrances': [
            ['Place de Cornavin (main hall)', 31, -13, 0],
            ['Aile Ouest (Rue de Montbrillant)', -66, 11, 0],
            ['Montbrillant (passages under the tracks)', -3, 92, 1],
            ['Rue du Mont-Blanc (Metro Shopping)', 87, -105, 0],
        ],
        # The stairs from the west end of Metro Shopping (corridor "Place de Cornavin", level -1) up to the pavement
        # in front of the Hôtel Cornavin (way 82683746, 14 steps) are incline=down in OSM, drawn from the corridor:
        # they go up (the corridor is underground, the pavement on the street, swisstopo 385.3). Fixed below, and the
        # top of the stairs is on the street.
        'ground': [[-33.4, -75.7, 0]],
        # ATLAS has Genève, gare Cornavin as a tram stop; OSM has which of its letters are trams (H, I, D/E with the
        # buses) and which buses (A-C, F, G, J-L). P has no stop in OSM and stays a tram stop, as ATLAS says.
        # The Léman Express has no platforms of its own here: its trains use tracks 1-7 (ATLAS and OSM have no other).
        'modes_from_osm': True,
        'osm_edits': [
            # The outline of the tram platform H (way 1264828952, covered, under the south-west end of the train
            # platforms) shares its corner node 11750585098 with the outline of train platform 1 (relation 10174235,
            # level 2), 7.9 m above it: the tram platform would be put on the level of the trains. The same outline
            # with a corner of its own:
            ['node', 'H corner', -35.0, -58.1],
            ['drop', 1264828952],
            ['way', ['H corner', 11750585099, 11750585100, 11750585101, 11750585102, 11750585113, 11750585112,
                     5910919373, 5910919222, 5910919218, 11750585103, 5910919219, 11750585104, 5910919220, 11750585105,
                     5910919221, 11750585106, 11750585107, 5910919343, 5910919341, 11750585108, 11750585109,
                     11750585110, 11750585111, 'H corner'],
             {'area': 'yes', 'bench': 'no', 'bin': 'yes', 'covered': 'yes', 'highway': 'platform', 'lit': 'yes',
              'local_ref': 'H', 'name': 'Gare Cornavin', 'public_transport': 'platform', 'railway': 'platform',
              'ref': 'H', 'route_ref': '14;18', 'tactile_paving': 'yes', 'tram': 'yes'}],
            # the stairs at the west end of Metro Shopping (see above), going up from the corridor
            ['drop', 82683746],
            ['way', [769087109, 769087110, 5910919363],
             {'handrail': 'yes', 'highway': 'steps', 'incline': 'up', 'lit': 'yes', 'ramp': 'no', 'step_count': '14',
              'surface': 'concrete', 'tactile_paving': 'yes'}],
        ],
        # Works: none that closes anything for passengers today. The underground station (Léman 2030) has not
        # started: CFF, "Genève-Meyrin-La Praille: travaux préalables" (company.sbb.ch) has the advance works ending at
        # the end of 2026 and the main works from 2027 at the earliest; track 5 was renewed from 27 June to 17 August
        # 2026 (news.sbb.ch, "Renouvellement de la voie 5 à Genève"; track 6 follows in summer 2027, no dates yet).
        # OSM has the underground station only as proposed (not in the model).
        # SBB open data (tools/station3d_sbb_layers.py geneve): sector signs of tracks 1-7 and 10 (at the borders
        # between two sectors, "B|C"), sector centres from them, clocks and ticket machines, all in one SBB section
        # ("Geneve"): no sbb_sections.
        'layers': ['sectors.json', 'boards.json', 'furniture.json'],
        'credits': ['© swisstopo'],                 # terrain heights
    },
}

# Paths people walk on. Roads with their own mapped pavements are left out (sidewalk=separate or the big road classes).
WALK_HIGHWAYS = {'footway', 'path', 'pedestrian', 'steps', 'corridor', 'living_street', 'track',
                 'residential', 'unclassified'}
ROAD_HIGHWAYS = {'residential', 'unclassified', 'living_street', 'track'}
NO_ACCESS = {'no', 'private', 'customers', 'delivery', 'permit', 'agricultural', 'forestry', 'military'}
LIFECYCLE = ('construction', 'proposed', 'planned', 'razed', 'disused', 'abandoned', 'demolished', 'removed', 'was',
             'destroyed', 'dismantled')
LIFECYCLE_KEYS = ('highway', 'railway', 'building', 'building:part', 'indoor', 'public_transport', 'shop', 'amenity')
MODES = {'t': 'train', 'm': 'tram', 'b': 'bus', 's': 'boat', 'c': 'cable'}
RAILWAYS = ('rail', 'narrow_gauge', 'tram', 'light_rail')

SNAP_LEVEL = 0.15        # an outdoor node within this many levels of a whole level is put on that level
SPANNER = 1.2            # links across an open area are added until no walk is more than 20 % longer than the bee line
STAIR_SLOPE = 0.55       # rise per metre of plan length for stairs without step_count
RAMP_MAX_MAPPED = 0.16   # a way OSM maps between two levels counts as a step-free ramp up to this slope
RAMP_MAX_INFERRED = 0.12  # a slope whose heights are inferred counts as step-free up to this slope
STEP_RISE = 0.17         # metres per step
STEEPEST_PATH = 0.35     # a path that climbs more than this per metre is steps, whatever it is mapped as
LIFT_LINK = 9.0          # a lift stop without a mapped path is linked to a path on its level within this many metres
ISLAND_LINK = 30.0       # a platform without a mapped way to it is linked to the nearest path within this many metres
STOP_SEARCH = 45.0       # an ATLAS edge looks for its OSM platform within this many metres


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ------------------------------------------------------------------------------------------------------- downloads --
def overpass_query(bbox):
    s, w, n, e = bbox
    return (f'[out:json][timeout:180][bbox:{s},{w},{n},{e}];\n'
            '(node(if:count_tags()>0); way; rel[type~"^(multipolygon|building)$"];);\nout body geom;')


def fetch_osm(key, cfg, refresh=False, path=None):
    """Overpass JSON for the station's bounding box, from the cache unless told otherwise."""
    if path:
        return json.load(open(path, encoding='utf-8'))
    cache = os.path.join(CACHE_DIR, f'{key}.osm.json')
    if os.path.exists(cache) and not refresh:
        return json.load(open(cache, encoding='utf-8'))
    query = overpass_query(cfg['bbox'])
    last = None
    for attempt in range(9):  # one request at a time, three rounds over the mirrors, waiting longer each time
        host = OVERPASS[attempt % len(OVERPASS)]
        try:
            log(f'downloading OpenStreetMap from {host.split("/")[2]}')
            req = urllib.request.Request(host, data=urllib.parse.urlencode({'data': query}).encode(),
                                         headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=240) as res:
                raw = res.read()
            data = json.loads(raw)
            if not data.get('elements') or 'remark' in data:
                raise ValueError(str(data.get('remark', 'empty answer'))[:200])
            os.makedirs(CACHE_DIR, exist_ok=True)
            with open(cache, 'wb') as f:
                f.write(raw)
            return data
        except Exception as e:  # 429 / 504 / timeouts: try the next mirror after a pause
            last = e
            log(f'  failed ({e})')
            time.sleep(8 * (attempt + 1))
    if os.path.exists(cache):
        log('using the old cache')
        return json.load(open(cache, encoding='utf-8'))
    raise SystemExit(f'Overpass is not answering: {last}')


def load_platforms():
    text = open(PLATFORMS_JS, encoding='utf-8').read()
    return json.loads(text[text.index('{'):text.rindex('}') + 1])


PREFIX = re.compile(r'^(gleis|gl\.|kante|quai|voie|binario|steg|perron)\s+', re.I)


def key_of(ref):
    """Same as platformKey() in index.html and key_of() in build_platforms.py: "7A-D" -> "7", "Kante H" -> "H"."""
    s = PREFIX.sub('', str(ref).strip()).upper()
    m = re.match(r'\d+', s)
    return m.group(0) if m else re.sub(r'[^0-9A-Z]', '', s)


# -------------------------------------------------------------------------------------------------------- geometry --
def dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def line_len(pts):
    return sum(dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1))


def simplify_idx(pts, tol):
    """Douglas-Peucker on points of any dimension; returns the indices to keep."""
    keep = [0, len(pts) - 1]
    stack = [(0, len(pts) - 1)]
    while stack:
        i, j = stack.pop()
        if j - i < 2:
            continue
        a, b = pts[i], pts[j]
        ab = [q - p for p, q in zip(a, b)]
        ab2 = sum(v * v for v in ab)
        worst, wk = -1.0, None
        for k in range(i + 1, j):
            ap = [q - p for p, q in zip(a, pts[k])]
            t = max(0.0, min(1.0, sum(u * v for u, v in zip(ap, ab)) / ab2)) if ab2 else 0.0
            d = math.sqrt(sum((u - t * v) ** 2 for u, v in zip(ap, ab)))
            if d > worst:
                worst, wk = d, k
        if worst > tol:
            keep.append(wk)
            stack += [(i, wk), (wk, j)]
    return sorted(keep)


def parse_levels(tags):
    """level=* as a sorted list of numbers: "-1;0" -> [-1, 0], "3-6" -> [3, 4, 5, 6]."""
    v = tags.get('level')
    if v is None:
        return None
    out = set()
    for part in re.split(r'[;,]', v):
        part = part.strip()
        m = re.match(r'^(-?\d+(?:\.\d+)?)\s*-\s*(-?\d+(?:\.\d+)?)$', part)
        try:
            if m:
                a, b = float(m.group(1)), float(m.group(2))
                while a <= b + 1e-9:
                    out.add(a)
                    a += 1
            else:
                out.add(float(part))
        except ValueError:
            pass
    return sorted(out) or None


def shift_level(v, d):
    """level=* with d added to every number in it: ("0;1", -1) -> "-1;0"."""
    lv = parse_levels({'level': v})
    return ';'.join(f'{l + d:g}' for l in lv) if lv else v


def num(v, default=None):
    try:
        return float(re.match(r'\s*-?\d+(?:[.,]\d+)?', str(v)).group(0).replace(',', '.'))
    except (AttributeError, ValueError):
        return default


def in_future(v):
    """Is this OSM date ("21.12.2026", "2026-12-21", "2031") later than today?"""
    v = str(v).strip()
    m = re.match(r'^(\d{1,2})\.(\d{1,2})\.(\d{4})$', v)
    if m:
        y, mo, d = int(m.group(3)), int(m.group(2)), int(m.group(1))
    else:
        m = re.match(r'^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?$', v)
        if not m:
            return False
        y, mo, d = int(m.group(1)), int(m.group(2) or 1), int(m.group(3) or 1)
    try:
        return datetime.date(y, mo, d) > datetime.date.today()
    except ValueError:
        return False


def iso_date(v):
    """An OSM date ("21.12.2026", "2026-12-21") as "2026-12-21"; '' when it is not a full date."""
    v = str(v).strip()
    m = re.match(r'^(\d{1,2})\.(\d{1,2})\.(\d{4})$', v)
    if m:
        return f'{int(m.group(3)):04d}-{int(m.group(2)):02d}-{int(m.group(1)):02d}'
    return v if re.match(r'^\d{4}-\d{2}-\d{2}$', v) else ''


def is_dead(tags):
    """Not there today: under construction, planned, demolished or disused, or opening at a later date."""
    if any(k in tags for k in ('highway', 'railway', 'public_transport', 'indoor')) and (
            in_future(tags.get('opening_date', '')) or in_future(tags.get('start_date', ''))):
        return True
    for k, v in tags.items():
        head, _, tail = k.partition(':')
        if head in LIFECYCLE and (not tail or tail in LIFECYCLE_KEYS):
            return True
        if k in LIFECYCLE_KEYS and v in LIFECYCLE:
            return True
    return False


def no_entry(tags):
    """Closed to the public on foot."""
    foot = tags.get('foot')
    if foot in ('yes', 'designated', 'permissive'):
        return False
    return foot in NO_ACCESS or foot == 'use_sidepath' or tags.get('access') in NO_ACCESS


def clean_polys(geom, min_area=0.5):
    """Valid polygons without slivers out of whatever a shapely operation returned."""
    if geom is None or geom.is_empty:
        return []
    if not geom.is_valid:
        geom = shapely.make_valid(geom)
    out = []
    for g in getattr(geom, 'geoms', [geom]):
        if isinstance(g, (MultiPolygon,)) or g.geom_type == 'GeometryCollection':
            out += clean_polys(g, min_area)
        elif isinstance(g, Polygon) and g.area >= min_area:
            out.append(g)
    return out


def tidy(poly, tol=0.2):
    """Simplified polygon for the output: outer ring counter-clockwise, holes clockwise, no tiny holes."""
    out = []
    for p in clean_polys(poly.simplify(tol, preserve_topology=True)):
        p = Polygon(p.exterior, [h for h in p.interiors if Polygon(h).area >= 0.3])
        out.append(shapely.geometry.polygon.orient(p, 1.0))
    return out


def island_sides(poly, end=1.0):
    """The outline of a platform island without its two ends: the long sides, where the kerb is."""
    r = list(poly.minimum_rotated_rectangle.exterior.coords)[:4]
    short = sorted((LineString([r[i], r[(i + 1) % 4]]) for i in range(4)), key=lambda l: l.length)[:2]
    return poly.exterior.difference(unary_union([l.buffer(end, cap_style=2) for l in short]))


def ring_xy(ring):
    return [[round(x, 2), round(y, 2)] for x, y in list(ring.coords)[:-1]]


# ------------------------------------------------------------------------------------------------------------ build --
class Builder:
    def __init__(self, key, cfg, osm, platforms, data_dir=None):
        self.key, self.cfg = key, cfg
        self.data_dir = os.path.join(data_dir or DATA_DIR, key)
        self.credits = list(cfg.get('credits', []))   # attribution strings of the layers that were used
        self.today = datetime.date.today().isoformat()
        self.lon0, self.lat0 = cfg['origin']
        self.kx = 111320 * math.cos(math.radians(self.lat0))
        self.ky = 110540
        self.osm, self.platforms = osm, platforms
        self.extent = box(*cfg['extent'])
        for cut in cfg.get('extent_cut', []):
            self.extent = self.extent.difference(box(*cut))
        self.notes = defaultdict(list)   # report sections
        table = dict(cfg['levels'])
        self.ztab = sorted((float(l), float(z)) for l, (z, _) in table.items())
        self.h = cfg.get('level_height', 4.0)

    def data(self, name, credit=None):
        """A layer file of this station (tools/station3d_data/<key>/<name>), or None when it is not there."""
        path = os.path.join(self.data_dir, name)
        if not os.path.exists(path):
            if name in self.cfg.get('layers', []):
                self.note('layers', f'{path} is not there: built without it')
            return None
        for c in credit or []:
            if c not in self.credits:
                self.credits.append(c)
        return json.load(open(path, encoding='utf-8'))

    def shut(self, c):
        """closed: { from?, until?, note? } for the model out of a closure in the station table; None when over."""
        if not c or (c.get('until') and c['until'] <= self.today):
            return None
        return {k: c[k] for k in ('from', 'until', 'note') if c.get(k)}

    # -- coordinates and heights
    def xy(self, lon, lat):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def z_of(self, level):
        t = self.ztab
        if level <= t[0][0]:
            return t[0][1] + (level - t[0][0]) * self.h
        if level >= t[-1][0]:
            return t[-1][1] + (level - t[-1][0]) * self.h
        for (l0, z0), (l1, z1) in zip(t, t[1:]):
            if l0 <= level <= l1:
                return z0 + (z1 - z0) * (level - l0) / (l1 - l0)

    def level_of(self, z):
        t = self.ztab
        if z <= t[0][1]:
            return t[0][0] + (z - t[0][1]) / self.h
        if z >= t[-1][1]:
            return t[-1][0] + (z - t[-1][1]) / self.h
        for (l0, z0), (l1, z1) in zip(t, t[1:]):
            if z0 <= z <= z1:
                return l0 + (l1 - l0) * (z - z0) / (z1 - z0)

    def snap(self, level):
        """Ground within SNAP_LEVEL of a whole level lies on it; in between the slope is a little steeper."""
        r = round(level)
        d = level - r
        if abs(d) <= SNAP_LEVEL:
            return float(r)
        return round(r + math.copysign((abs(d) - SNAP_LEVEL) * 0.5 / (0.5 - SNAP_LEVEL), d), 2)

    def note(self, section, text):
        self.notes[section].append(text)

    # ------------------------------------------------------------------------------------------------ 1. read OSM --
    def read(self):
        self.nodes, self.ways, self.rels = {}, {}, {}
        self.node_xy = {}
        dead = 0
        self.edit_osm()
        shifts = [(box(*b[:4]), b[4]) for b in self.cfg.get('level_shift', [])]
        shifted = 0
        for e in self.osm['elements'] if shifts else []:
            # (written back into the tags, so that everything after this reads one count of floors; the tags are
            # copied first: the same download may be built twice in one run)
            if 'level' not in e.get('tags', {}):
                continue
            pts = [e] if e['type'] == 'node' else [g for g in e.get('geometry') or [] if g] if e['type'] == 'way'                 else [g for m in e.get('members', []) for g in m.get('geometry') or [] if g]
            for zone, d in shifts:
                if pts and all(zone.covers(Point(self.xy(g['lon'], g['lat']))) for g in pts):
                    e['tags'] = dict(e['tags'], level=shift_level(e['tags']['level'], d))
                    shifted += 1
                    break
        if shifted:
            self.note('input', f'level=* of {shifted} things shifted to the count of floors of the station (level_shift)')
        for e in self.osm['elements']:
            e.setdefault('tags', {})
            if e['type'] == 'node':
                e['xy'] = self.xy(e['lon'], e['lat'])
                self.node_xy[e['id']] = e['xy']
                if is_dead(e['tags']):
                    dead += 1
                    continue
                self.nodes[e['id']] = e
            elif e['type'] == 'way':
                if not e.get('geometry') or not e.get('nodes'):
                    continue
                e['pts'] = [self.xy(g['lon'], g['lat']) for g in e['geometry']]
                for n, p in zip(e['nodes'], e['pts']):
                    self.node_xy[n] = p
                e['closed'] = len(e['nodes']) > 3 and e['nodes'][0] == e['nodes'][-1]
                t = e['tags']
                date = iso_date(t.get('opening_date') or t.get('start_date') or '')
                if t.get('highway') == 'construction' and t.get('construction') in WALK_HIGHWAYS and date \
                        and date > self.today:
                    e['opens'] = self.cfg.get('opens', {}).get('date', date)
                    kind = t['construction']
                    e['tags'] = t = {k: v for k, v in t.items()
                                     if k not in ('construction', 'opening_date', 'start_date')}
                    t['highway'] = kind
                    self.note('opening later (in the model, closed until then)',
                              f'way {e["id"]} ({t["highway"]} level={t.get("level")}): OSM start date {date}, '
                              f'closed until {e["opens"]}')
                elif t.get('highway') == 'construction' and t.get('construction') in WALK_HIGHWAYS and date \
                        and e['id'] < 0:
                    # a way the station table adds as closed until a date (osm_edits): open from that date on, so a
                    # rebuild after the reopening keeps it (a real OSM construction way waits for OSM to be updated)
                    kind = t['construction']
                    e['tags'] = t = {k: v for k, v in t.items()
                                     if k not in ('construction', 'opening_date', 'start_date')}
                    t['highway'] = kind
                    self.note('reopened (station table)', f'way {e["id"]} ({kind}): open since {date}')
                e['dead'] = is_dead(e['tags'])
                dead += e['dead']
                self.ways[e['id']] = e
            else:
                if is_dead(e['tags']):
                    dead += 1
                    continue
                self.rels[e['id']] = e
        self.note('input', f'{len(self.nodes)} tagged nodes, {len(self.ways)} ways, {len(self.rels)} relations; '
                           f'{dead} skipped as not open today (construction / proposed / razed / disused)')
        self.osm_date = (self.osm.get('osm3s') or {}).get('timestamp_osm_base', '')[:10]

    def edit_osm(self):
        """The corrections of the station table to the OpenStreetMap download (osm_edits)."""
        edits = self.cfg.get('osm_edits')
        if not edits:
            return
        els = [dict(e) for e in self.osm['elements']]   # (copies: the same download may be built twice in one run)
        at = {}                                         # node id -> where it is
        for e in els:
            if e['type'] == 'node':
                at[e['id']] = {'lon': e['lon'], 'lat': e['lat']}
            elif e['type'] == 'way' and e.get('geometry') and e.get('nodes'):
                for n, g in zip(e['nodes'], e['geometry']):
                    if g:
                        at.setdefault(n, {'lon': g['lon'], 'lat': g['lat']})

        def ll(x, y):
            return {'lon': self.lon0 + x / self.kx, 'lat': self.lat0 + y / self.ky}

        named, fresh, count = {}, [-1], defaultdict(int)

        def new_node(x, y):
            at[fresh[0]] = ll(x, y)
            fresh[0] -= 1
            return fresh[0] + 1

        for op in edits:
            kind = op[0]
            if kind == 'node':
                named[op[1]] = new_node(op[2], op[3])
            elif kind == 'move':
                if op[1] not in at:
                    self.note('config', f'osm_edits move {op[1]}: no such node in the download, not used')
                    continue
                at[op[1]] = ll(op[2], op[3])
                for e in els:
                    if e['type'] == 'node' and e['id'] == op[1]:
                        e.update(at[op[1]])
                    elif e['type'] == 'way' and e.get('geometry') and op[1] in (e.get('nodes') or ()):
                        e['geometry'] = [dict(at[n]) if n == op[1] else g for n, g in zip(e['nodes'], e['geometry'])]
            elif kind == 'drop':
                kept = [e for e in els if not (e['type'] == 'way' and e['id'] == op[1])]
                if len(kept) == len(els):
                    self.note('config', f'osm_edits drop {op[1]}: no such way in the download, not used')
                    continue
                els = kept
            elif kind == 'way':
                ids, here = [], {}
                for r in op[1]:
                    if isinstance(r, (list, tuple)):
                        key = (r[0], r[1])
                        if key not in here:
                            here[key] = new_node(r[0], r[1])
                        ids.append(here[key])
                    else:
                        ids.append(named.get(r, r))
                if any(n not in at for n in ids):
                    self.note('config', f'osm_edits way {op[1]}: a node of it is not in the download, not used')
                    continue
                els.append({'type': 'way', 'id': fresh[0], 'nodes': ids, 'geometry': [dict(at[n]) for n in ids],
                            'tags': dict(op[2])})
                fresh[0] -= 1
            else:
                self.note('config', f'osm_edits {op}: not understood, not used')
                continue
            count[kind] += 1
        self.osm = dict(self.osm, elements=els)
        self.note('input', 'OpenStreetMap corrected from the station table (osm_edits): '
                  + ', '.join(f'{n} {k}' for k, n in sorted(count.items())))

    def rel_polygons(self, rel):
        """Polygons of a multipolygon relation and the ids of the nodes on their rings."""
        rings = {'outer': [], 'inner': []}
        ids = set()
        for role in rings:
            segs = []
            for m in rel['members']:
                if m['type'] != 'way' or not m.get('geometry') or (m.get('role') or 'outer') != role:
                    continue
                pts = [self.xy(g['lon'], g['lat']) for g in m['geometry'] if g]
                if len(pts) >= 2:
                    segs.append(pts)
                w = self.ways.get(m['ref'])
                if w:
                    ids.update(w['nodes'])
            key = lambda p: (round(p[0], 3), round(p[1], 3))
            while segs:  # stitch the member ways into closed rings
                ring = segs.pop()
                while key(ring[0]) != key(ring[-1]):
                    for i, s in enumerate(segs):
                        if key(s[0]) == key(ring[-1]):
                            ring += s[1:]
                        elif key(s[-1]) == key(ring[-1]):
                            ring += s[-2::-1]
                        else:
                            continue
                        segs.pop(i)
                        break
                    else:
                        break
                if len(ring) >= 4 and key(ring[0]) == key(ring[-1]):
                    rings[role].append(ring)
        outers = [p for r in rings['outer'] for p in clean_polys(Polygon(r))]
        holes = [p for r in rings['inner'] for p in clean_polys(Polygon(r), 0.2)]
        polys = []
        for o in outers:
            inside = [h for h in holes if o.contains(h.representative_point())]
            polys += clean_polys(o.difference(unary_union(inside)) if inside else o)
        return polys, ids

    # ---------------------------------------------------------------------------------- 2. areas, paths and lifts --
    def collect(self):
        self.areas = []        # walkable polygons: platform / plaza / floor
        self.rooms = []        # closed-off polygons on a level
        self.walk = {}         # way id -> way (paths, stairs)
        self.lifts = []        # {'ids': node ids, 'xy', 'levels': set, 'poly'}
        self.buildings = []    # (polygon, tags, kind)
        lift_polys = []
        near = prep(self.extent.buffer(40))

        def area_kind(t, closed, is_rel):
            hw = t.get('highway')
            if hw == 'elevator':
                return 'lift'
            if t.get('railway') == 'platform' or t.get('public_transport') == 'platform' or hw == 'platform':
                return 'platform'
            if 'building' in t or 'building:part' in t:
                return 'building'
            if hw in ('pedestrian', 'footway', 'path', 'corridor') and (is_rel or t.get('area') == 'yes'):
                indoor = t.get('indoor') not in (None, 'no') or t.get('tunnel') not in (None, 'no')
                return 'floor' if indoor else 'plaza'
            if t.get('indoor') in ('corridor', 'area') and hw is None:
                return 'floor'
            if 'level' in t and (t.get('indoor') == 'room' or t.get('room') or any(
                    k in t for k in ('shop', 'amenity', 'office', 'craft', 'tourism', 'disused:shop', 'disused:amenity'))):
                if t.get('amenity') in ('parking', 'motorcycle_parking', 'bus_station', 'bicycle_parking', 'taxi'):
                    return 'deck'
                return 'room'
            if t.get('man_made') == 'bridge':
                return 'deck'
            return None

        def add_area(kind, polys, ids, t, src):
            lv = parse_levels(t)
            if kind == 'building':
                if t.get('location') == 'underground':
                    return   # (a car park or a shelter under the ground: nothing stands there)
                for p in polys:
                    self.buildings.append((p, t, src))
                return
            if kind == 'deck':
                for p in polys:
                    self.buildings.append((p, dict(t, _deck='yes'), src))
                return
            if kind == 'lift':
                if no_entry(t):
                    return
                for p in polys:
                    lift_polys.append({'poly': p, 'ids': set(ids), 'levels': set(lv or []), 'src': src})
                return
            if kind == 'room':
                for p in polys:
                    self.rooms.append({'poly': p, 'level': lv[0], 'tags': t, 'src': src})
                return
            if no_entry(t):
                return
            if lv and len(lv) > 1:
                self.note('skipped', f'{src}: walkable area on several levels ({t.get("level")}), a slope; '
                                     f'only the paths drawn on it are used')
                return
            refs = [r.strip() for k in ('ref', 'local_ref', 'loc_ref') for r in re.split(r'[;,/]', t.get(k, ''))
                    if r.strip()]
            covered = t.get('covered') not in (None, 'no') or t.get('shelter') == 'yes'
            for p in polys:
                self.areas.append({'kind': kind, 'level': lv[0] if lv else None, 'poly': p, 'ids': set(ids), 'tags': t,
                                   'refs': sorted(set(refs), key=lambda r: (len(r), r)), 'src': [src],
                                   'name': '' if kind == 'platform' else t.get('name', ''), 'uic': t.get('uic_ref'),
                                   'indoor': t.get('indoor') not in (None, 'no') or bool(lv and lv[0] < 0),
                                   'covered': covered, 'float': self.floats(t)})

        for w in self.ways.values():
            t = w['tags']
            if w['dead'] or not t:
                continue
            src = f'way {w["id"]}'
            kind = area_kind(t, w['closed'], False)
            hw = t.get('highway')
            if kind == 'platform' and not (w['closed'] and (t.get('area') != 'no')):
                # a platform drawn as a line: give it its width
                width = num(t.get('width'), 2.4)
                poly = LineString(w['pts']).buffer(width / 2, cap_style=2, join_style=2)
                add_area('platform', clean_polys(poly), w['nodes'], t, src)
            elif kind and w['closed']:
                add_area(kind, clean_polys(Polygon(w['pts'])), w['nodes'], t, src)
            elif hw in WALK_HIGHWAYS and not no_entry(t) and near.intersects(LineString(w['pts'])):
                if hw in ROAD_HIGHWAYS and (t.get('sidewalk') == 'separate' or t.get('sidewalk:both') == 'separate'
                                            or t.get('tunnel') == 'yes'):
                    continue
                self.walk[w['id']] = w
        for r in self.rels.values():
            t = r['tags']
            kind = area_kind(t, True, True)
            if kind:
                polys, ids = self.rel_polygons(r)
                add_area(kind, polys, ids, t, f'relation {r["id"]}')

        # lifts drawn as polygons, sometimes one polygon per level on top of each other: one lift per pile
        used = [False] * len(lift_polys)
        for i, a in enumerate(lift_polys):
            if used[i]:
                continue
            pile, used[i] = [a], True
            grown = True
            while grown:
                grown = False
                for j, b in enumerate(lift_polys):
                    if not used[j] and any(b['poly'].distance(c['poly']) < 0.3 for c in pile):
                        pile.append(b)
                        used[j] = grown = True
            u = unary_union([c['poly'] for c in pile])
            c = u.centroid
            self.lifts.append({'ids': set().union(*[c_['ids'] for c_ in pile]), 'xy': (c.x, c.y), 'poly': u,
                               'levels': set().union(*[c_['levels'] for c_ in pile]),
                               'src': ', '.join(c_['src'] for c_ in pile), 'wheelchair': True})
        for n in self.nodes.values():
            t = n['tags']
            if t.get('highway') == 'elevator' and not no_entry(t):
                pile = next((l for l in self.lifts if l['poly'] is not None
                             and l['poly'].distance(Point(n['xy'])) < 1.0), None)
                if pile:   # the same lift drawn as a polygon and as a node
                    pile['ids'].add(n['id'])
                    pile['levels'] |= set(parse_levels(t) or [])
                    pile['src'] += f', node {n["id"]}'
                    continue
                self.lifts.append({'ids': {n['id']}, 'xy': n['xy'], 'poly': None, 'levels': set(parse_levels(t) or []),
                                   'src': f'node {n["id"]}', 'wheelchair': t.get('wheelchair') != 'no'})
        self.lift_of = {}
        for i, l in enumerate(self.lifts):
            for n in l['ids']:
                self.lift_of[n] = i

        for x, y in self.cfg.get('squares', []):
            found = [(Polygon(w['pts']), w) for w in self.ways.values()
                     if w['closed'] and not w['dead'] and w['tags'].get('place') == 'square']
            found = [(p, w) for p, w in found if p.is_valid and p.covers(Point(x, y))]
            if not found:
                self.note('config', f'squares [{x}, {y}]: no place=square outline around this point')
                continue
            poly, w = min(found, key=lambda f: f[0].area)
            inside = [a for a in self.areas if a['kind'] == 'plaza' and a['level'] is None
                      and a['poly'].intersection(poly).area > 0.8 * a['poly'].area]
            whole = unary_union([poly] + [a['poly'] for a in inside]).buffer(0.3, join_style=2).buffer(-0.3, join_style=2)
            before = len(self.areas)
            add_area('plaza', [max(clean_polys(whole), key=lambda q: q.area)],
                     set(w['nodes']).union(*[a['ids'] for a in inside]), w['tags'], f'way {w["id"]}')
            if len(self.areas) == before:
                self.note('config', f'squares [{x}, {y}]: way {w["id"]} is closed to the public, left out')
                continue
            self.areas[-1]['square'] = True
            self.areas = [a for a in self.areas if not any(a is b for b in inside)]
            self.note('squares', f'{w["tags"].get("name", "")} (way {w["id"]}, place=square): one square of '
                                 f'{self.areas[-1]["poly"].area:.0f} m2 to walk across, with the pedestrian areas '
                                 f'{", ".join(a["src"][0] for a in inside) or "(none)"} in it')
        self.merge_platforms()
        self.extend_platforms()
        # (the squares of the station table last: the platforms that stand on them are meshed before them)
        self.areas.sort(key=lambda a: bool(a.get('square')))
        for a in self.areas:
            a['osm_level'] = a['level']
        for l in self.lifts:
            l['osm_levels'] = set(l['levels'])
        self.pinned = {}       # way id -> level, for paths that repair_crossings puts on a level
        for x, y, lvl in self.cfg.get('structures', []):
            near = [(LineString(w['pts']).distance(Point(x, y)), wid) for wid, w in self.walk.items()
                    if self.floats(w['tags']) and not parse_levels(w['tags']) and w['tags'].get('highway') != 'steps']
            if near and min(near)[0] <= 15:
                self.pinned[min(near)[1]] = float(lvl)
            else:
                self.note('config', f'structures [{x}, {y}, {lvl}]: no path on a bridge or in a tunnel without '
                                    f'level=* within 15 m')

    @staticmethod
    def floats(t):
        """Tagged as not lying on the ground: bridge, tunnel or a layer."""
        return (t.get('bridge') not in (None, 'no') or t.get('tunnel') not in (None, 'no')
                or t.get('layer') not in (None, '0'))

    def extend_platforms(self):
        """Island platforms listed under extend_platforms get the stretch between their two SBB kerb lines that the
        OSM outline does not cover; for every platform the distance between kerb lines and outline is reported."""
        file = self.data('platform_edges.geojson', ['data.sbb.ch'])
        if not file:
            return
        kerbs = {key_of(f['properties']['ref']): LineString([self.xy(c[0], c[1]) for c in f['geometry']['coordinates']])
                 for f in file['features']}
        want = {key_of(r) for r in self.cfg.get('extend_platforms', [])}
        for a in self.areas:
            keys = sorted({key_of(r) for r in a['refs']} & set(kerbs), key=lambda k: (len(k), k))
            if a['kind'] != 'platform' or not keys:
                continue
            for k in keys:
                off = sorted(a['poly'].exterior.distance(kerbs[k].interpolate(d))
                             for d in np.arange(0, kerbs[k].length, 5.0) if a['poly'].distance(kerbs[k].interpolate(d)) < 3)
                out = kerbs[k].difference(a['poly'].buffer(3)).length
                if off:
                    self.note('SBB kerb lines against the OSM platform outlines',
                              f'track {k}: median {off[len(off) // 2]:.2f} m, largest {off[-1]:.1f} m; '
                              f'{out:.0f} of {kerbs[k].length:.0f} m of the kerb lie beyond the OSM platform')
            if len(keys) != 2 or not (set(keys) & want):
                continue
            near = a['poly'].buffer(0.8)
            parts = [[g for g in getattr(kerbs[k].difference(near), 'geoms', [kerbs[k].difference(near)])
                      if g.geom_type == 'LineString' and g.length > 8] for k in keys]
            added = []
            for g0 in parts[0]:
                for g1 in parts[1]:
                    if g0.distance(g1) > 20:
                        continue   # (not the same end of the island)
                    c0, c1 = list(g0.coords), list(g1.coords)
                    ring = max((Polygon(c0 + c1[::-1]), Polygon(c0 + c1)), key=lambda q: q.area if q.is_valid else -1)
                    if ring.is_valid and ring.area > 20:
                        added.append(ring)
            if added:
                before = a['poly'].area
                joined = unary_union([a['poly']] + added).buffer(1.0, join_style=2).buffer(-1.0, join_style=2)
                a['poly'] = max(clean_polys(joined), key=lambda q: q.area)
                self.note('platforms extended along the SBB kerb', f'{"/".join(a["refs"])}: +{a["poly"].area - before:.0f} m2, '
                          + ', '.join(f'{max(g.length for g in ps):.0f} m of kerb {k}' for k, ps in zip(keys, parts) if ps))

    def merge_platforms(self):
        """A platform mapped in sections (same refs, same level, touching) becomes one area."""
        groups = defaultdict(list)
        rest = []
        for a in self.areas:
            if a['kind'] == 'platform' and a['refs']:
                groups[(tuple(a['refs']), a['level'], a['uic'])].append(a)
            else:
                rest.append(a)
        for (refs, level, uic), items in groups.items():
            if len(items) == 1:
                rest.append(items[0])
                continue
            u = unary_union([a['poly'].buffer(0.35, join_style=2) for a in items]).buffer(-0.35, join_style=2)
            for p in clean_polys(u):
                parts = [a for a in items if a['poly'].representative_point().distance(p) < 0.5]
                if not parts:
                    continue
                m = dict(parts[0])
                m.update(poly=p, ids=set().union(*[a['ids'] for a in parts]), src=[s for a in parts for s in a['src']],
                         covered=any(a['covered'] for a in parts), indoor=any(a['indoor'] for a in parts))
                rest.append(m)
        self.areas = rest

    # -------------------------------------------------------------------------------------------------- 3. levels --
    def rail_levels(self, final):
        """Level of every track: {way id: level}.

        level=* on the track; else the level of the platform it runs along; else the level of the track it continues
        (a bridge or a tunnel carries the grade on, it is not another storey). What is still open after that is level
        0 before the levels are solved (final=False: only platforms with level=* count then); in the finished model
        it is the layer on bridges and in tunnels, else 0.
        """
        rails = {wid: w for wid, w in self.ways.items() if not w['dead'] and w['tags'].get('railway') in RAILWAYS}
        level = {}
        plats = []
        for a in self.areas:
            if a['kind'] != 'platform' or (final and a['level'] is None):
                continue
            modes = {s['mode'] for s in self.stops if s.get('area') is a}
            kinds = (({'rail', 'narrow_gauge', 'light_rail'} if 'train' in modes else set())
                     | ({'tram', 'light_rail'} if 'tram' in modes else set()))
            if kinds:
                plats.append((a, kinds, a['poly'].buffer(6)))
        self.rail_along = defaultdict(list)   # way id -> [(metres along the platform, area)]
        for wid, w in rails.items():
            line = LineString(w['pts'])
            for a, kinds, zone in plats:
                if w['tags']['railway'] in kinds and zone.intersects(line):
                    along = line.intersection(zone).length
                    if along >= min(20.0, 0.6 * line.length) and line.intersection(a['poly']).length < 0.5 * along:
                        self.rail_along[wid].append((along, a))
            lv = parse_levels(w['tags'])
            here = [(along, a['level']) for along, a in self.rail_along[wid] if a['level'] is not None]
            if lv:
                level[wid] = lv[0]
            elif here:
                level[wid] = max(here)[1]
        # carried on along the rails, nearest known piece first
        at = defaultdict(list)
        for wid, w in rails.items():
            at[w['nodes'][0]].append(wid)
            at[w['nodes'][-1]].append(wid)
        heap = [(0.0, wid, lvl) for wid, lvl in sorted(level.items())]
        heapq.heapify(heap)
        done = set()
        while heap:
            d, wid, lvl = heapq.heappop(heap)
            if wid in done:
                continue
            done.add(wid)
            level.setdefault(wid, lvl)
            w = rails[wid]
            for n in (w['nodes'][0], w['nodes'][-1]):
                for other in at[n]:
                    if other not in done and other not in level \
                            and rails[other]['tags']['railway'] == w['tags']['railway']:
                        heapq.heappush(heap, (d + line_len(rails[other]['pts']), other, lvl))
        for wid, w in rails.items():
            if wid not in level:
                t = w['tags']
                on = t.get('tunnel') == 'yes' or t.get('bridge') == 'yes'
                level[wid] = num(t.get('layer'), -1.0 if t.get('tunnel') == 'yes' else 1.0) if final and on else 0.0
        return level

    def crossing_bounds(self):
        """What the tracks say about paths on a bridge or in a tunnel that OSM gives no level=*.

        layer=* only says what is on top where two things cross, so that is all that is read from it: a path that
        crosses over tracks is at least 4.5 m above their level, a path that passes under tracks at least 2.5 m below.
        Returns {way id: (lowest height or None, highest height or None, words)}. Stairs are left out (they are what
        joins the levels), and so is every path that crosses no track.
        """
        rail = self.rail_levels(final=False)
        lines = [(wid, LineString(self.ways[wid]['pts'])) for wid in rail]
        out = {}
        if not lines:
            return out
        tree = STRtree([l for _, l in lines])

        def layer_of(t):
            if t.get('layer') is not None:
                return num(t['layer'], 0.0)
            if t.get('bridge') not in (None, 'no'):
                return 1.0
            return -1.0 if t.get('tunnel') not in (None, 'no', 'building_passage') else 0.0

        for wid, w in self.walk.items():
            t = w['tags']
            if parse_levels(t) or t.get('highway') == 'steps' or not self.floats(t) or len(w['pts']) < 2:
                continue
            mine = layer_of(t)
            line = LineString(w['pts'])
            over, under = [], []
            for k in tree.query(line, predicate='intersects'):
                rid = lines[int(k)][0]
                r = self.ways[rid]
                if set(r['nodes']) & set(w['nodes']):
                    continue   # a level crossing
                theirs = layer_of(r['tags'])
                if mine > theirs:
                    over.append(rail[rid])
                elif mine < theirs:
                    under.append(rail[rid])
            if over or under:
                words = ' and '.join(x for x in (f'over tracks on level {max(over):g}' if over else '',
                                                 f'under tracks on level {min(under):g}' if under else '') if x)
                out[wid] = (self.z_of(max(over)) + 4.5 if over else None,
                            self.z_of(min(under)) - 2.5 if under else None, words)
        return out

    def repair_crossings(self):
        """After the levels are solved: a path that came out at the height of the tracks it crosses on a bridge or
        in a tunnel is put on the nearest level of the table that clears them. True when something was moved (the
        levels are then solved again with these paths fixed)."""
        table = [l for l, _ in self.ztab]
        moved = False
        for wid, (lo, hi, words) in self.crossing_bounds().items():
            if wid in self.pinned:
                continue
            w = self.walk[wid]
            z = sum(self.z_of(l) for l in self.wl[wid]) / len(self.wl[wid])
            if lo is not None and z < lo - 0.5:
                fit = [l for l in table if self.z_of(l) >= lo - 0.01 and (hi is None or self.z_of(l) <= hi + 0.01)]
                lvl = fit[0] if fit else (None if hi is not None else math.floor(self.level_of(lo - 4.5) + 1e-6) + 1.0)
            elif hi is not None and z > hi + 0.5:
                fit = [l for l in table if self.z_of(l) <= hi + 0.01 and (lo is None or self.z_of(l) >= lo - 0.01)]
                lvl = fit[-1] if fit else (None if lo is not None else math.ceil(self.level_of(hi + 2.5) - 1e-6) - 1.0)
            else:
                continue
            if lvl is None:
                continue
            self.pinned[wid] = lvl
            moved = True
            t = w['tags']
            self.note('levels inferred from the tracks a path crosses',
                      f'way {wid} at ({w["pts"][0][0]:.0f}, {w["pts"][0][1]:.0f}), {line_len(w["pts"]):.0f} m, '
                      f'layer={t.get("layer")} bridge={t.get("bridge")} tunnel={t.get("tunnel")}, no level: {words}, '
                      f'but its ends put it at {z:+.1f} m -> level {lvl:g}')
        return moved

    def solve_levels(self):
        """Level of every node of every path.

        self.wl[way id] = [level per node]. Rules, strongest first:
          a. a way with one level=*: all its nodes are on it
          b. a way with two levels (stairs, ramp): one end on each; which end is which from incline=up/down, else from
             what the ends are connected to; nodes in between are interpolated by length
          c. a way without level: its nodes take the level of levelled things they share a node with or lie on
             (platforms, squares, floors); everything else is interpolated in height between those, with stairs
             taking their rise (step_count, or length) and flat paths sharing what is left by length
        """
        claims = defaultdict(lambda: defaultdict(int))   # node id -> {level: votes}
        lift_levels = defaultdict(set)
        # this runs a second time when repair_crossings moved something: start from what OSM says
        for a in self.areas:
            a['level'] = a['osm_level']
        for l in self.lifts:
            l['levels'] = set(l['osm_levels'])
        for section in ('fixed', 'guess', 'platforms on the level of their track', 'lifts without a level in OSM'):
            self.notes.pop(section, None)
        # A train platform that OSM gives no level and that is not on a bridge or in a tunnel is on the level of its
        # track: the level of the tracks it continues (level=* there, or a platform with level=* further along),
        # else level 0, which is the main track level by definition. Everything else is measured from there.
        rail = self.rail_levels(final=False)
        for a in self.areas:
            if a['kind'] == 'platform' and a['level'] is None and not a['float'] \
                    and any(s['mode'] == 'train' for s in self.stops if s.get('area') is a):
                here = [(along, rail[wid]) for wid, items in self.rail_along.items() for along, b in items if b is a]
                a['level'] = max(here)[1] if here else 0.0
                if a['level'] != 0:
                    self.note('platforms on the level of their track',
                              f'platform {",".join(a["refs"])} ({a["src"][0]}): no level in OSM, its track is on '
                              f'level {a["level"]:g}')

        # squares, platforms and floors without a level are flat: all their nodes move together
        parent = {}

        def find(a):
            while parent.get(a, a) != a:
                parent[a] = parent.get(parent[a], parent[a])
                a = parent[a]
            return a

        def union(a, b):
            a, b = find(a), find(b)
            if a != b:
                parent[b] = a

        walk_nodes = defaultdict(list)   # node id -> [(way id, index)]
        for wid, w in self.walk.items():
            for i, n in enumerate(w['nodes']):
                walk_nodes[n].append((wid, i))
        self.walk_nodes = walk_nodes

        # nodes of unlevelled ground paths that lie on a walkable area belong to it
        tree = STRtree([a['poly'] for a in self.areas]) if self.areas else None
        rings = defaultdict(int)         # node id -> number of walkable areas that have it on their outline
        for a in self.areas:
            a['inner'] = set()
            for n in a['ids']:
                rings[n] += 1
        if tree is not None:
            for wid, w in self.walk.items():
                t = w['tags']
                if parse_levels(t) or self.floats(t):
                    continue
                steps = t.get('highway') == 'steps'
                for i, (n, p) in enumerate(zip(w['nodes'], w['pts'])):
                    if n in self.lift_of or (steps and 0 < i < len(w['nodes']) - 1):
                        continue   # (the nodes in the middle of a flight of stairs are on no floor)
                    for k in tree.query(Point(p), predicate='intersects'):
                        a = self.areas[int(k)]
                        if steps and n not in a['ids'] and (rings[n] or any(
                                o != wid and self.floats(self.walk[o]['tags']) for o, _ in walk_nodes[n])):
                            continue   # (the end of stairs on the outline of one area is not on another area
                            #             that is drawn overlapping it, and the end where a tunnel or a bridge
                            #             begins is not on the platform above or below it: stairs lead from one
                            #             to the other)
                        # only ground-level areas: a path drawn across an underground floor is the street above it
                        if n in a['ids'] or (not a['float'] and not a['indoor'] and a['level'] in (None, 0)):
                            a['inner'].add(n)
        # A stairwell drawn as a hole in a platform has both ends of its stairs on the outline of the hole. On a
        # platform without level=* (all of its nodes are taken to be on one height) only the end that leads nowhere
        # else stands on the platform; the other end is where the stairs come out, on the bridge or in the underpass.
        # The same on a platform with level=*, for stairs that carry no level of their own (level=* on the stairs
        # says where their ends are): the end that also belongs to a path or to the outline of another platform or
        # square is where the stairs come out, and is not on the level of the platform.
        off = defaultdict(set)
        off_levelled = defaultdict(set)
        for wid, w in self.walk.items():
            if w['tags'].get('highway') != 'steps':
                continue
            ends = (w['nodes'][0], w['nodes'][-1])
            onward = [n for n in ends if any(other != wid for other, _ in walk_nodes[n])]
            if len(onward) == 1:
                off[onward[0]].add(ends[0] if onward[0] == ends[1] else ends[1])
            if not parse_levels(w['tags']):
                onward = [n for n in ends if rings[n] > 1 or any(other != wid for other, _ in walk_nodes[n])]
                if len(onward) == 1:
                    off_levelled[onward[0]].add(ends[0] if onward[0] == ends[1] else ends[1])
        for a in self.areas:
            members = [n for n in (a['ids'] | a['inner']) if n not in self.lift_of]
            have = set(members)
            if a['osm_level'] is None:
                members = [n for n in members if not (off.get(n, set()) & have)]
            else:
                members = [n for n in members if not (off_levelled.get(n, set()) & have)]
            a['members'] = members
            if a['level'] is not None:
                for n in members:
                    claims[n][a['level']] += 1
            else:
                for n in members[1:]:
                    union(members[0], n)

        for wid, w in self.walk.items():
            lv = [self.pinned[wid]] if wid in self.pinned else parse_levels(w['tags'])
            w['lv'], w['inferred'] = lv, wid in self.pinned
            # stairs with a single level: only one end is on it, the other end is wherever the stairs lead
            w['soft'] = bool(lv and len(lv) == 1 and w['tags'].get('highway') == 'steps')
            w['free'] = not lv or w['soft']
            if lv and len(lv) == 1 and not w['soft']:
                for n in w['nodes']:
                    if n in self.lift_of:
                        lift_levels[self.lift_of[n]].add(lv[0])
                    else:
                        claims[n][lv[0]] += 1
        for i, l in enumerate(self.lifts):
            l['levels'] |= lift_levels[i]
        spots = [(wid, i) for wid, w in self.walk.items() if not w['lv'] and not self.floats(w['tags'])
                 and w['tags'].get('highway') != 'steps' for i in range(len(w['nodes']))]
        measured = self.spot_heights()
        on_bridge = [(wid, i) for wid, w in self.walk.items() if not w['lv'] and self.floats(w['tags'])
                     and w['tags'].get('highway') != 'steps' for i in range(len(w['nodes']))]
        for x, y, z, kind, name in measured:
            where = on_bridge if kind == 'bridge' else spots
            if where:
                wid, i = min(where, key=lambda s: dist(self.walk[s[0]]['pts'][s[1]], (x, y)))
                gap = dist(self.walk[wid]['pts'][i], (x, y))
                if gap <= (20 if kind == 'bridge' else 40) and self.walk[wid]['nodes'][i] not in self.lift_of:
                    claims[self.walk[wid]['nodes'][i]][round(self.level_of(z), 3)] += 1
                    continue
            self.note('layers', f'spot height {name} ({z:+.1f} m at {x:.0f}, {y:.0f}): no {kind} path near it, not used')
        for x, y, lvl in self.cfg.get('ground', []):
            if spots:
                wid, i = min(spots, key=lambda s: dist(self.walk[s[0]]['pts'][s[1]], (x, y)))
                if dist(self.walk[wid]['pts'][i], (x, y)) <= 40 and self.walk[wid]['nodes'][i] not in self.lift_of:
                    claims[self.walk[wid]['nodes'][i]][float(lvl)] += 1

        group_level = {}
        # Stairs of more than 2 m (step_count) lead to another level: a square or platform without a level is not
        # on the level that the other end of such stairs stands on, whatever a node it shares with a levelled
        # outline says (a square drawn up to the foot of the wall of a raised platform).
        tall = [(w['nodes'][0], w['nodes'][-1]) for w in self.walk.values()
                if w['free'] and not w['lv'] and w['tags'].get('highway') == 'steps'
                and (num(w['tags'].get('step_count')) or 0) * STEP_RISE > 2.0]

        def regroup():
            votes = defaultdict(lambda: defaultdict(int))
            for n, c in claims.items():
                if n in parent or find(n) != n:
                    for lvl, k in c.items():
                        votes[find(n)][lvl] += k
            for ends in tall:
                for u, v in (ends, ends[::-1]):
                    c = claims.get(v)
                    if c and len(c) == 1 and find(u) != find(v) and find(u) in votes:
                        votes[find(u)].pop(next(iter(c)), None)
            group_level.clear()
            for g, c in votes.items():
                if c:
                    group_level[g] = max(c.items(), key=lambda kv: (kv[1], -abs(kv[0])))[0]

        def known(n):
            """The level of a node if it is settled."""
            if n in self.lift_of:
                return None
            g = find(n)
            if g in group_level:
                return group_level[g]
            c = claims.get(n)
            if c and len(c) == 1:
                return next(iter(c))
            return None

        # b. which end of a two-level way is up
        self.wl = {}
        todo = [wid for wid, w in self.walk.items() if w['lv'] and len(w['lv']) > 1]
        regroup()
        progress = True
        while todo and progress:
            progress = False
            for wid in list(todo):
                w = self.walk[wid]
                lo, hi = w['lv'][0], w['lv'][-1]
                a, b = known(w['nodes'][0]), known(w['nodes'][-1])
                inc = self.incline_sign(w['tags'])
                vote = 0   # +1: first node is the low end
                for end, val, sign in ((0, a, 1), (1, b, -1)):
                    if val is not None:
                        if abs(val - lo) < 0.01:
                            vote += sign
                        elif abs(val - hi) < 0.01:
                            vote -= sign
                if vote == 0 and not inc:
                    continue
                up = vote > 0 if vote else inc > 0
                if vote and inc and (vote > 0) != (inc > 0):
                    self.note('fixed', f'way {wid} ({w["tags"].get("highway")} level={w["tags"]["level"]}): '
                                       f'incline={w["tags"].get("incline")} contradicts the levels it connects; '
                                       f'connections win')
                self.wl[wid] = self.spread(w, lo if up else hi, hi if up else lo, known)
                for n, lvl in ((w['nodes'][0], self.wl[wid][0]), (w['nodes'][-1], self.wl[wid][-1])):
                    if n in self.lift_of:
                        self.lifts[self.lift_of[n]]['levels'].add(lvl)
                    else:
                        claims[n][lvl] += 1
                todo.remove(wid)
                regroup()
                progress = True
        for wid in todo:
            w = self.walk[wid]
            self.note('guess', f'way {wid} ({w["tags"].get("highway")} level={w["tags"]["level"]}): no incline and '
                               f'nothing levelled at its ends, assumed to rise in drawing direction')
            self.wl[wid] = self.spread(w, w['lv'][0], w['lv'][-1], known)

        # A ground path that shares a node with a way on another level and would have to climb from level 0 to it
        # steeper than any path can, without steps: a street drawn onto the tunnel below it (or the bridge above).
        # The ground paths at that node are not connected to the other level.
        split = set()
        for wid, w in self.walk.items():
            t = w['tags']
            if w['lv'] or t.get('highway') == 'steps' or self.floats(t) or t.get('indoor') not in (None, 'no'):
                continue
            pinned = [(i, known(n)) for i, n in enumerate(w['nodes']) if known(n) is not None]
            for (i, la), (j, lb) in zip(pinned, pinned[1:]):
                rise, run = abs(self.z_of(la) - self.z_of(lb)), line_len(w['pts'][i:j + 1])
                if rise > 2.0 and rise > 0.25 * run and (la == 0) != (lb == 0):
                    k = j if la == 0 else i
                    n, p = w['nodes'][k], w['pts'][k]
                    if n not in split:
                        self.note('fixed', f'node {n} at ({p[0]:.0f}, {p[1]:.0f}): the ground path way {wid} shares it '
                                           f'with level {lb if la == 0 else la:g}, {rise:.1f} m away in height over '
                                           f'{run:.0f} m without steps; taken as an OSM slip, not connected')
                    split.add(n)

        # c. heights of everything without a level: least squares over the path segments
        var = {}     # variable key -> index
        fixed = {}   # variable key -> z

        def key_of_node(n, wid):
            if n in self.lift_of:
                return ('lift', n, wid)   # a lift node is a different place for every way that ends there
            if n in split:
                return ('ground', n)      # the ground paths that meet above or below the other level
            return find(n)

        def register(k, n):
            if k in var or k in fixed:
                return
            lvl = known(n) if not isinstance(k, tuple) else None
            if lvl is not None:
                fixed[k] = self.z_of(lvl)
            else:
                var[k] = len(var)

        eqs = []     # (key u, key v, weight, dz from u to v)
        for wid, w in self.walk.items():
            if not w['free']:
                continue
            t = w['tags']
            steps = t.get('highway') == 'steps'
            inc = self.incline_sign(t)
            pts, ns = w['pts'], w['nodes']
            total = line_len(pts) or 0.1
            rise = None
            if steps and inc:
                count = num(t.get('step_count'))
                rise = inc * (count * STEP_RISE if count else min(total * STAIR_SLOPE, 12.0))
            for i in range(len(ns) - 1):
                ku, kv = key_of_node(ns[i], wid), key_of_node(ns[i + 1], wid)
                register(ku, ns[i])
                register(kv, ns[i + 1])
                if w['soft']:   # without anything else to go by, stairs stay near their level
                    home = ('level', w['lv'][0])
                    fixed[home] = self.z_of(w['lv'][0])
                    eqs.append((ku, home, 0.01, 0.0))
                    if i == len(ns) - 2:
                        eqs.append((kv, home, 0.01, 0.0))
                if ku == kv:
                    continue
                seg = max(dist(pts[i], pts[i + 1]), 0.3)
                if steps and rise is not None:
                    eqs.append((ku, kv, (20.0 if t.get('step_count') else 3.0) / seg, rise * seg / total))
                elif steps:
                    eqs.append((ku, kv, 0.05 / seg, 0.0))
                else:
                    eqs.append((ku, kv, 1.0 / seg, 0.0))
        # a platform or square that no path touches takes the height of the nearest ground path
        ground = [(wid, w) for wid, w in self.walk.items() if not w['lv'] and not self.floats(w['tags'])
                  and w['tags'].get('highway') != 'steps']
        gtree = STRtree([LineString(w['pts']) for _, w in ground]) if ground else None
        for a in self.areas:
            if a['level'] is not None or not a['members']:
                continue
            k = find(a['members'][0])
            if any(n in self.walk_nodes for n in a['members']) or gtree is None:
                continue
            j = gtree.nearest(a['poly'])
            wid, w = ground[int(j)]
            if LineString(w['pts']).distance(a['poly']) > ISLAND_LINK:
                continue
            c = a['poly'].centroid
            i = min(range(len(w['pts'])), key=lambda i: dist(w['pts'][i], (c.x, c.y)))
            kv = key_of_node(w['nodes'][i], wid)
            register(k, a['members'][0])
            register(kv, w['nodes'][i])
            if k != kv:
                eqs.append((k, kv, 50.0, 0.0))

        zs = self.least_squares(var, fixed, eqs)
        # squares and platforms without a level go on the nearest level of the table, then everything is solved again
        table_levels = [l for l, _ in self.ztab]
        refit = False
        # where a stop without a platform stands, the ground is on a whole level (unless the heights of the streets
        # are measured: a stop on a sloping street then keeps the height it has)
        for s in self.stops if not measured else []:
            if s.get('anchor') is not None and s['anchor'] in self.walk_nodes:
                k = find(s['anchor'])
                if k in var and k not in fixed:
                    fixed[k] = self.z_of(min(table_levels, key=lambda l: abs(self.z_of(l) - zs.get(k, 0.0))))
                    refit = True
        for a in self.areas:
            if a['level'] is None and a['members']:
                k = find(a['members'][0])
                z = fixed.get(k, zs.get(k, 0.0))
                a['level'] = min(table_levels, key=lambda l: abs(self.z_of(l) - z))
                if k in var:
                    fixed[k] = self.z_of(a['level'])
                    refit = True
            elif a['level'] is None:
                a['level'] = 0.0
        if refit:
            var = {k: i for i, k in enumerate(k for k in var if k not in fixed)}
            zs = self.least_squares(var, fixed, eqs)
        # A lift that OSM gives no level serves the levels of the platforms, squares and floors it is drawn into
        # (its outline shares nodes with theirs), and those of the paths that end at it (below).
        for l in self.lifts:
            if l['osm_levels']:
                continue
            on = sorted({a['level'] for a in self.areas if a['ids'] & l['ids'] and float(a['level']).is_integer()}
                        - l['levels'])
            if on:
                l['levels'] |= set(on)
                self.note('lifts without a level in OSM',
                          f'{l["src"]} at ({l["xy"][0]:.0f}, {l["xy"][1]:.0f}): stands on the outline of '
                          + ' and '.join(f'{a["kind"]} {",".join(a["refs"]) or a["name"] or a["src"][0]} (level '
                                         f'{a["level"]:g})' for a in self.areas
                                         if a['ids'] & l['ids'] and a['level'] in on) + ': serves those levels')

        # levels of the unlevelled ways; at a lift each way lands on the nearest level the lift serves
        for wid, w in self.walk.items():
            if w['lv'] and len(w['lv']) == 1 and not w['soft']:
                self.wl[wid] = [w['lv'][0]] * len(w['nodes'])
            elif w['free']:
                out = []
                for n in w['nodes']:
                    k = key_of_node(n, wid)
                    z = fixed[k] if k in fixed else zs.get(k, 0.0)
                    lvl = self.level_of(z)
                    if n in self.lift_of:
                        lift = self.lifts[self.lift_of[n]]
                        if lift['levels'] and min(abs(self.z_of(l) - z) for l in lift['levels']) < 2.5:
                            lvl = min(lift['levels'], key=lambda l: abs(self.z_of(l) - z))
                        else:
                            lvl = float(round(lvl))
                            lift['levels'].add(lvl)
                    else:
                        lvl = self.snap(lvl)
                    out.append(lvl)
                self.wl[wid] = out

        # a node where two ways with different single levels meet without a lift: the node keeps one level and the
        # last piece of the other way becomes a slope
        for n, uses in walk_nodes.items():
            if n in self.lift_of or n in split or len(uses) < 2:
                continue
            lv = defaultdict(list)
            for wid, i in uses:
                lv[self.wl[wid][i]].append((wid, i))
            if len(lv) < 2:
                continue
            own = parse_levels(self.nodes.get(n, {}).get('tags', {}))
            if own and len(own) == 1 and own[0] in lv:
                main = own[0]
            else:
                main = max(lv, key=lambda l: (len(lv[l]), -abs(l)))
            for lvl, items in lv.items():
                if lvl == main:
                    continue
                for wid, i in items:
                    w = self.walk[wid]
                    p = self.node_xy[n]
                    far = w['nodes'][0] if i else w['nodes'][-1]
                    if not w['free'] and far in self.lift_of and line_len(w['pts']) <= 12:
                        # the short way from a lift door to a path on another level: the door opens on that level
                        self.wl[wid] = [main] * len(w['nodes'])
                        self.lifts[self.lift_of[far]]['levels'].add(main)
                        self.note('fixed', f'way {wid} at ({p[0]:.0f}, {p[1]:.0f}): tagged level {lvl:g}, but it joins '
                                           f'the lift {self.lifts[self.lift_of[far]]["src"]} to a path on level '
                                           f'{main:g}; taken as level {main:g}')
                        continue
                    self.wl[wid][i] = main
                    self.note('fixed', f'node {n} at ({p[0]:.0f}, {p[1]:.0f}): way {wid} (level {lvl:g}) meets level '
                                       f'{main:g} without stairs or lift; its last piece is treated as a slope')

        # Stairs climb one way. Where an end was put on another level than incline=* or the steps counted say (it
        # meets a levelled path there, above), the nodes in between are left above or below both ends: they are
        # put on the line between the ends instead.
        for wid, w in self.walk.items():
            lv = self.wl[wid]
            if not w['free'] or w['tags'].get('highway') != 'steps' or len(lv) < 3:
                continue
            lo, hi = min(lv[0], lv[-1]), max(lv[0], lv[-1])
            loose = [i for i in range(1, len(lv) - 1) if len(walk_nodes[w['nodes'][i]]) == 1
                     and w['nodes'][i] not in self.lift_of]
            if len(loose) == len(lv) - 2 and any(not (lo - 0.01 <= lv[i] <= hi + 0.01) for i in loose):
                total = line_len(w['pts']) or 1.0
                run = 0.0
                for i in range(1, len(lv) - 1):
                    run += dist(w['pts'][i - 1], w['pts'][i])
                    lv[i] = round(lv[0] + (lv[-1] - lv[0]) * run / total, 2)
                p0 = w['pts'][0]
                self.note('fixed', f'way {wid} (steps) at ({p0[0]:.0f}, {p0[1]:.0f}): incline={w["tags"].get("incline")}'
                                   f' step_count={w["tags"].get("step_count")} contradicts the levels of its ends '
                                   f'({lv[0]:g} and {lv[-1]:g}); the ends win, the nodes between them are put on '
                                   f'the line from one to the other')

    def spot_heights(self):
        """Measured heights of the street from the station's heights.json: [x, y, metres, 'ground' | 'bridge', id]."""
        want = dict(self.cfg.get('spot_heights', []))
        out = [(x, y, z, kind, 'from the station table') for x, y, z, kind in self.cfg.get('spots', [])]
        file = self.data('heights.json', ['© swisstopo', 'Geodaten Stadt Bern']) if want else None
        for h in (file or {}).get('heights', []):
            if h['id'] in want and h.get('rel_m') is not None:
                x, y = self.xy(h['lon'], h['lat'])
                out.append((x, y, h['rel_m'], want[h['id']], h['id']))
        return out

    @staticmethod
    def incline_sign(t):
        v = t.get('incline')
        if not v:
            return 0
        if v == 'up':
            return 1
        if v == 'down':
            return -1
        n = num(v)
        return 0 if not n else (1 if n > 0 else -1)

    def spread(self, w, first, last, known):
        """Levels along a two-level way: interpolated by length, pinned where a node in between is on a known level."""
        pts, ns = w['pts'], w['nodes']
        pins = {0: first, len(ns) - 1: last}
        lo, hi = min(first, last), max(first, last)
        for i in range(1, len(ns) - 1):
            k = known(ns[i])
            if k is not None and lo - 0.01 <= k <= hi + 0.01:
                pins[i] = k
        idx = sorted(pins)
        out = [None] * len(ns)
        for a, b in zip(idx, idx[1:]):
            total = line_len(pts[a:b + 1]) or 1.0
            run = 0.0
            for i in range(a, b + 1):
                if i > a:
                    run += dist(pts[i - 1], pts[i])
                out[i] = round(pins[a] + (pins[b] - pins[a]) * run / total, 2)
        return out

    def least_squares(self, var, fixed, eqs):
        """Heights that fit the segment equations best (conjugate gradients on the normal equations)."""
        n = len(var)
        if not n:
            return {}
        diag = np.full(n, 1e-7)
        rhs = np.zeros(n)
        iu, iv, ww = [], [], []
        for ku, kv, w, d in eqs:
            fu, fv = ku in fixed, kv in fixed
            if fu and fv:
                continue
            if not fu and not fv:
                u, v = var[ku], var[kv]
                diag[u] += w
                diag[v] += w
                rhs[u] -= w * d
                rhs[v] += w * d
                iu.append(u)
                iv.append(v)
                ww.append(w)
            elif fu:
                v = var[kv]
                diag[v] += w
                rhs[v] += w * (fixed[ku] + d)
            else:
                u = var[ku]
                diag[u] += w
                rhs[u] += w * (fixed[kv] - d)
        iu, iv, ww = np.array(iu, dtype=int), np.array(iv, dtype=int), np.array(ww)

        def mul(x):
            y = diag * x
            if len(iu):
                y -= np.bincount(iu, ww * x[iv], n) + np.bincount(iv, ww * x[iu], n)
            return y

        x = np.zeros(n)
        r = rhs - mul(x)
        zv = r / diag
        p = zv.copy()
        rz = float(r @ zv)
        target = 1e-10 * max(float(rhs @ rhs), 1e-12)
        for _ in range(40000):
            if float(r @ r) <= target:
                break
            ap = mul(p)
            alpha = rz / float(p @ ap)
            x += alpha * p
            r -= alpha * ap
            zv = r / diag
            rz2 = float(r @ zv)
            p = zv + (rz2 / rz) * p
            rz = rz2
        return {k: float(x[i]) for k, i in var.items()}

    # --------------------------------------------------------------------------------------------------- 4. graph --
    def node(self, key, x, y, level, **meta):
        i = self.gkey.get(key) if key is not None else None
        if i is None:
            i = len(self.gn)
            self.gn.append([x, y, level])
            self.gmeta.append(meta)
            if key is not None:
                self.gkey[key] = i
        else:
            self.gmeta[i].update(meta)
        if meta.get('float'):
            self.gmeta[i]['off'] = True   # where a tunnel or a bridge begins, whichever of its ways comes last
        return i

    def edge(self, a, b, kind, length=None, **attrs):
        if a == b:
            return None
        e = {'a': a, 'b': b, 'kind': kind,
             'len': dist(self.gn[a], self.gn[b]) if length is None else length}
        e.update({k: v for k, v in attrs.items() if v not in (None, False, '')})
        self.edges.append(e)
        return e

    def build_graph(self):
        self.gn, self.gmeta, self.gkey, self.edges = [], [], {}, []
        self.connectors = []
        btree = STRtree([b[0] for b in self.buildings]) if self.buildings else None

        def under_roof(p):
            """'indoor' inside a building, 'covered' under a roof, else None."""
            if btree is None:
                return None
            best = None
            for k in btree.query(Point(p), predicate='intersects'):
                t = self.buildings[int(k)][1]
                if t.get('_deck'):
                    continue
                if t.get('building') == 'roof' or t.get('building:part') == 'roof':
                    best = best or 'covered'
                else:
                    best = 'indoor'
            return best

        for wid, w in self.walk.items():
            t, lv = w['tags'], self.wl[wid]
            hw = t.get('highway')
            pts, ns = w['pts'], w['nodes']
            inside = [self.extent.covers(Point(p)) for p in pts]
            if not any(inside):
                continue
            conveying = t.get('conveying') if t.get('conveying') not in (None, 'no') else None
            base = 'stairs' if hw == 'steps' else None
            if base and conveying:
                base = 'escalator'
            explicit = t.get('indoor') not in (None, 'no') or t.get('tunnel') == 'yes'
            covered = (t.get('covered') not in (None, 'no') or t.get('tunnel') == 'building_passage')
            mapped = None if w.get('inferred') else w['lv']   # level=* in OSM
            where = None
            if not explicit and not covered:
                mid = LineString(pts).interpolate(0.5, normalized=True)
                where = under_roof((mid.x, mid.y)) if not (mapped and max(mapped) < 0) else 'indoor'
                if where == 'indoor' and not mapped:
                    where = 'covered'   # a ground path through a building footprint: arcade or passage
            outdoor = not explicit and where != 'indoor'
            covered = outdoor and (covered or where == 'covered')
            opens = None
            if w.get('opens', '') > self.today:
                opens = self.opening = getattr(self, 'opening', None) or {
                    k: v for k, v in (('until', w['opens']), ('note', self.cfg.get('opens', {}).get('note'))) if v}
            attrs = {'outdoor': outdoor, 'covered': covered, 'name': t.get('name'), 'closed': opens,
                     'wheelchair': False if t.get('wheelchair') == 'no' else None}
            ids = []
            for i, n in enumerate(ns):
                ids.append(self.node((n, lv[i]), pts[i][0], pts[i][1], lv[i], osm=n,
                                     float=self.floats(t) and not mapped) if inside[i] else None)
            sloped = False
            for i in range(len(ns) - 1):
                a, b = ids[i], ids[i + 1]
                if a is None or b is None:
                    continue
                # A ramp is something built: indoors, or mapped between two floors, or joining two whole levels.
                # A pavement that follows the slope of the street stays a walk, with the slope on it (incline).
                built = not outdoor or (w['lv'] and len(w['lv']) > 1) \
                    or (float(lv[i]).is_integer() and float(lv[i + 1]).is_integer())
                kind = base or ('ramp' if built and abs(lv[i] - lv[i + 1]) >= 0.005 else 'walk')
                seg = dist(pts[i], pts[i + 1])
                extra = dict(attrs)
                if kind == 'escalator' and conveying in ('forward', 'backward'):
                    if conveying == 'backward':
                        a, b = b, a
                    extra['oneway'] = True
                self.edge(a, b, kind, seg, way=wid, **extra)
                sloped = sloped or kind == 'ramp'
            # something to draw: stairs, escalators and built ramps
            if (base or sloped or (w['lv'] and len(w['lv']) > 1)) and all(inside):
                keep = simplify_idx([(p[0], p[1], self.z_of(l)) for p, l in zip(pts, lv)], 0.15)
                line = [[round(pts[i][0], 2), round(pts[i][1], 2), lv[i]] for i in keep]
                c = {'kind': base or 'ramp', 'line': line, 'closed': opens,
                     'width': num(t.get('width')) or {'stairs': 2.0, 'escalator': 1.0}.get(base, 3.0), 'way': wid}
                if base == 'escalator' and conveying in ('forward', 'backward'):
                    rising = lv[-1] > lv[0]
                    c['oneway'] = 'up' if rising == (conveying == 'forward') else 'down'
                self.connectors.append(c)
                if base and abs(lv[0] - lv[-1]) < 0.005:
                    p = pts[0]
                    self.note('same-level stairs', f'way {wid} at ({p[0]:.0f}, {p[1]:.0f}) level {lv[0]:g}'
                              + ('' if w['lv'] else ' (no level in OSM, no height difference found)'))
                rise = abs(self.z_of(lv[0]) - self.z_of(lv[-1]))
                if rise > 9 and base:
                    p = pts[0]
                    self.note('big jumps', f'way {wid} ({base}) at ({p[0]:.0f}, {p[1]:.0f}) from level {lv[0]:g} to '
                                           f'{lv[-1]:g}: {rise:.0f} m in one flight, drawn {line_len(pts):.0f} m long')

        self.add_lifts()

    def add_links(self):
        """The walks of the station table that OSM has no path for (links): from path to path, flagged inferred."""
        for x1, y1, x2, y2, lvl in self.cfg.get('links', []):
            ends = []
            for p in ((x1, y1), (x2, y2)):
                best = None
                for k, e in enumerate(self.edges):
                    a, b = self.gn[e['a']], self.gn[e['b']]
                    if e['kind'] != 'walk' or a[2] != lvl or b[2] != lvl:
                        continue
                    seg = LineString([a[:2], b[:2]])
                    d = seg.distance(Point(p))
                    if d <= 8 and (best is None or d < best[0]):
                        q = seg.interpolate(seg.project(Point(p)))
                        best = (d, k, (q.x, q.y))
                if best:
                    ends.append(self.split(best[1], best[2]))
            if len(ends) == 2 and ends[0] != ends[1]:
                self.edge(ends[0], ends[1], 'walk', outdoor=True, inferred=True)
                self.note('inferred links', f'link of the station table from ({self.gn[ends[0]][0]:.0f}, '
                          f'{self.gn[ends[0]][1]:.0f}) to ({self.gn[ends[1]][0]:.0f}, {self.gn[ends[1]][1]:.0f}) on '
                          f'level {lvl:g}, {dist(self.gn[ends[0]], self.gn[ends[1]]):.1f} m')
            else:
                self.note('config', f'links [{x1}, {y1}, {x2}, {y2}, {lvl}]: no path on level {lvl:g} within 8 m of '
                                    f'one of its ends, left out')

    def add_lifts(self):
        """One node per level a lift serves; the ways that end at the lift hang on them. finish_lifts joins them."""
        for li, lift in enumerate(self.lifts):
            x, y = lift['xy']
            if not self.extent.covers(Point(x, y)):
                continue
            # what arrives at the lift: graph nodes made from its OSM nodes, and path nodes inside a lift polygon
            arrive = defaultdict(list)
            for k, i in list(self.gkey.items()):
                if len(k) == 2 and k[0] in lift['ids']:
                    arrive[k[1]].append(i)
            if lift['poly'] is not None:
                zone = prep(lift['poly'].buffer(0.25))
                for i, (gx, gy, lvl) in enumerate(self.gn):
                    if self.gmeta[i].get('osm') not in lift['ids'] and zone.covers(Point(gx, gy)):
                        arrive[lvl].append(i)
            levels = sorted(set(l for l in lift['levels'] if float(l).is_integer()) | set(arrive))
            lift['hubs'] = {}
            for lvl in levels:
                if lift['poly'] is None and arrive.get(lvl):
                    hub = arrive[lvl][0]      # the lift node itself, on this level
                    self.gmeta[hub]['lift'] = li
                    for i in arrive[lvl][1:]:
                        self.edge(hub, i, 'walk', 0.0)
                else:
                    hub = self.node(('lift', li, lvl), x, y, lvl, lift=li, bare=not arrive.get(lvl))
                    for i in arrive.get(lvl, []):
                        self.edge(hub, i, 'walk', dist((x, y), self.gn[i]))
                lift['hubs'][lvl] = hub

    def finish_lifts(self):
        """Join the levels of each lift that a path reaches (after the areas are meshed: a lift may open on a platform)."""
        deg = defaultdict(int)
        for e in self.edges:
            deg[e['a']] += 1
            deg[e['b']] += 1
        for lift in self.lifts:
            hubs = lift.get('hubs')
            if not hubs:
                continue
            x, y = lift['xy']
            for lvl, h in sorted(hubs.items()):
                if deg[h] > 0 or lvl not in lift['osm_levels'] or not float(lvl).is_integer():
                    continue
                near = [(dist(n, (x, y)), i) for i, n in enumerate(self.gn)
                        if n[2] == lvl and deg[i] > 0 and self.gmeta[i].get('lift') is None]
                if near and min(near)[0] <= LIFT_LINK:
                    d, i = min(near)
                    self.edge(h, i, 'walk', inferred=True)
                    deg[h] += 1
                    deg[i] += 1
                    self.note('inferred links', f'lift {lift["src"]} at ({x:.0f}, {y:.0f}): OSM gives it level '
                                                f'{lvl:g} but draws no path to it there; linked to the nearest path '
                                                f'on that level, {d:.1f} m away')
            live = [(lvl, h) for lvl, h in sorted(hubs.items()) if deg[h] > 0]
            dead = [f'{lvl:g}' for lvl, h in sorted(hubs.items()) if deg[h] == 0]
            if len(live) < 2:
                self.note('lifts reached on fewer than two levels (left out)',
                          f'{lift["src"]} at ({x:.0f}, {y:.0f}): OSM levels {[f"{l:g}" for l in sorted(hubs)]}, '
                          f'a path arrives on {[f"{l:g}" for l, _ in live]}')
                continue
            if dead:
                self.note('lift stops without a path (left out)', f'{lift["src"]} at ({x:.0f}, {y:.0f}): '
                          f'level {", ".join(dead)}; kept: {", ".join(f"{l:g}" for l, _ in live)}')
            for (_, a), (_, b) in zip(live, live[1:]):
                self.edge(a, b, 'elevator', 0.0, wheelchair=None if lift['wheelchair'] else False)
            self.connectors.append({'kind': 'elevator', 'xy': [round(x, 2), round(y, 2)],
                                    'levels': [int(l) for l, _ in live], 'hub': live[0][1]})

    # --------------------------------------------------------------------------------------------------- 5. stops --
    def match_stops(self):
        """Every ATLAS edge of the complex and the OSM platform it belongs to, if there is one (before the levels)."""
        def train_platform(a):
            t = a['tags']
            return t.get('train') == 'yes' and not any(t.get(k) == 'yes' for k in ('bus', 'tram', 'trolleybus'))
        self.stops = []
        plats = [a for a in self.areas if a['kind'] == 'platform']
        shut = [c for c in self.cfg.get('closed', []) if self.shut(c) or c.get('remark')]
        ground = [(wid, i) for wid, w in self.walk.items() if not parse_levels(w['tags']) and not self.floats(w['tags'])
                  and w['tags'].get('highway') != 'steps' for i in range(len(w['nodes']))]
        stations = {n['tags'].get('uic_ref') for n in self.nodes.values()
                    if n['tags'].get('railway') in ('station', 'halt')}
        for uic in self.cfg['uics']:
            st = self.platforms['stops'].get(uic)
            if not st:
                self.note('stops', f'{uic}: not in platforms.js')
                continue
            name, mode, edges = st
            for su, sx, sy, why in self.cfg.get('skip_edges', []):
                # an ATLAS edge the station table shows to be wrong: the one of this stop id nearest the point
                if su != uic or not edges:
                    continue
                d, i = min((math.dist(self.xy(e[0] / 1e5, e[1] / 1e5), (sx, sy)), i) for i, e in enumerate(edges))
                if d <= 10:
                    self.note('config', f'skip_edges: {name} [{uic}] edge {edges[i][2] or "(no letter)"} at '
                                        f'({sx}, {sy}) left out: {why}')
                    edges = edges[:i] + edges[i + 1:]
            road = {}   # edge index -> 'b' | 'm': edges of this stop that OSM has as bus or tram stops
            if mode != 't' and (uic in stations or self.cfg.get('modes_from_osm')):
                # ATLAS has one mode per stop id, OSM one per stop position and platform: an edge whose letter OSM has
                # on a bus or tram stop near it is a bus or a tram stop as OSM says (Lausanne, gare: the m2 station and
                # the buses on the square above it; with modes_from_osm, Genève, gare Cornavin: trams and buses)
                road_tags = [(Point(n['xy']), n['tags']) for n in self.nodes.values()
                             if n['tags'].get('public_transport') in ('stop_position', 'platform')] + \
                            [(a['poly'], a['tags']) for a in plats if not train_platform(a)]
                for i, e in enumerate(edges):
                    ref = e[2] if len(e) > 2 and e[2] else ''
                    p = Point(self.xy(e[0] / 1e5, e[1] / 1e5))
                    on = [t for g, t in road_tags if ref and g.distance(p) <= STOP_SEARCH * 2
                          and key_of(ref) in {key_of(t.get(k, '')) for k in ('ref', 'local_ref')}
                          and any(t.get(k) == 'yes' for k in ('bus', 'trolleybus', 'tram'))]
                    if on:
                        road[i] = 'm' if any(t.get('tram') == 'yes' for t in on) else 'b'
                if any(m != mode for m in road.values()) or (road and uic in stations):
                    self.note('stops', f'{name} [{uic}]: edges {", ".join(edges[i][2] for i in road)} are bus or '
                                       f'tram stops in OSM: mode from OSM')
            if mode != 't' and uic in stations:
                self.note('stops', f'{name} [{uic}]: ATLAS calls it "{MODES.get(mode, mode)}", OSM has a railway '
                                   f'station with this number: taken as a train stop')
                mode = 't'
            for i, e in enumerate(edges):
                p = self.xy(e[0] / 1e5, e[1] / 1e5)
                ref = e[2] if len(e) > 2 and e[2] else ''
                emode = road.get(i, mode)
                atlas_level = e[4] if len(e) > 4 else None
                if atlas_level not in (None, 0) and emode != 't' and not any(
                        a['level'] is not None and abs(a['level'] - atlas_level) <= 0.5
                        and a['poly'].distance(Point(p)) <= 40
                        and (a['uic'] == uic or (a['tags'].get('name') and name.endswith(a['tags']['name']))
                             or any(a['tags'].get(k) == 'yes' for k in ('bus', 'tram', 'trolleybus')))
                        for a in plats):
                    # platforms.js joins levels by position: a tram or bus stop on the street above an underground
                    # station can get the level of a train platform below it (Zürich, Bahnhofplatz/HB: -4). Without
                    # an OSM platform of this stop (or a bus / tram one) on that level near it, it is on the street.
                    self.note('stops', f'{name} {ref} [{uic}]: platforms.js says level {atlas_level:g}, OSM has no '
                                       f'platform on that level within 40 m: taken as on the street')
                    atlas_level = None
                s = {'uic': uic, 'ref': ref, 'mode': MODES.get(emode, 'bus'), 'name': name, 'p': p,
                     'atlas_level': atlas_level, 'node': None, 'how': None, 'area': None, 'anchor': None,
                     'bearing': e[3] if len(e) > 3 else None}
                for c in shut:
                    if c['uic'] == uic and ref and key_of(ref) in {key_of(r) for r in c['refs']}:
                        s['closed'] = c
                self.stops.append(s)
                if not self.extent.covers(Point(p)):
                    s['how'] = 'outside the extent'
                    continue
                best = None
                for a in plats:
                    d = a['poly'].distance(Point(p))
                    if d > STOP_SEARCH:
                        continue
                    keys = {key_of(r) for r in a['refs']}
                    if emode != 't' and train_platform(a):
                        continue   # a tram or bus stop is not on a train platform, whatever its number
                    same_ref = bool(ref) and key_of(ref) in keys
                    if a['uic'] and a['uic'] != uic and not same_ref:
                        continue
                    if a['refs'] and ref and not same_ref:
                        continue   # another platform of the same stop
                    if emode != 't' and not same_ref and a['refs'] and not ref:
                        continue   # a stop without a number is not on a numbered platform (Zürich: the street above 41-44)
                    if atlas_level is not None and a['level'] is not None and abs(a['level'] - atlas_level) > 0.5 \
                            and not same_ref:
                        continue
                    if not same_ref and d > 12:
                        continue
                    rank = (0 if same_ref else 1, d)
                    if best is None or rank < best[0]:
                        best = (rank, a)
                if not best and ref:
                    # ATLAS puts the edge somewhere else than OSM has the platform with that number. A platform
                    # number is unique in a station, a coordinate is easily a few dozen metres off: the number wins
                    far = [(a['poly'].distance(Point(p)), a) for a in plats
                           if key_of(ref) in {key_of(r) for r in a['refs']}
                           and not (emode != 't' and train_platform(a))
                           and (a['uic'] == uic or (not a['uic'] and a['tags'].get('name') == name))
                           and a['poly'].intersects(self.extent)]
                    if far:
                        d, a = min(far, key=lambda f: f[0])
                        best = ((0, d), a)
                        self.note('stops', f'{name} {ref} [{uic}]: ATLAS position ({p[0]:.0f}, {p[1]:.0f}) is {d:.0f} m '
                                           f'from the OSM platform {",".join(a["refs"])} ({a["src"][0]}); '
                                           f'put on that platform, at its point nearest to the ATLAS position')
                if best:
                    s['area'] = best[1]
                elif atlas_level is None and ground:
                    # no platform in OSM: the stop is on the pavement; that spot will be put on a whole level
                    wid, i = min(ground, key=lambda g: dist(self.walk[g[0]]['pts'][g[1]], p))
                    if dist(self.walk[wid]['pts'][i], p) <= 30:
                        s['anchor'] = self.walk[wid]['nodes'][i]

    def place_stops(self):
        """A graph node on the platform of every matched stop, as close to the ATLAS position as the platform allows."""
        for s in self.stops:
            a = s['area']
            if a is None or s['how']:
                continue
            inner = a['poly'].buffer(-0.8)
            if inner.is_empty:
                inner = a['poly'].representative_point()
            q = nearest_points(inner, Point(s['p']))[0]
            s['node'] = self.node(None, q.x, q.y, a['level'], stop=True)
            s['how'] = 'platform ' + ', '.join(a['src'])
            a.setdefault('stops', []).append(s['node'])

    def name_areas(self):
        """Place names for squares and floors: their own, else the named paths on them, else a square mapped there."""
        named = []
        for w in self.ways.values():
            t = w['tags']
            if w['dead'] or not t.get('name'):
                continue
            if t.get('highway') in ('footway', 'pedestrian', 'corridor', 'path', 'steps') and not w['closed']:
                named.append((LineString(w['pts']), parse_levels(t), t['name'], 'path'))
            elif t.get('place') in ('square', 'locality') and w['closed']:
                named.append((Polygon(w['pts']), parse_levels(t), t['name'], 'place'))
        for n in self.nodes.values():
            t = n['tags']
            if t.get('name') and t.get('place') in ('square', 'locality'):
                named.append((Point(n['xy']), parse_levels(t), t['name'], 'place'))
        for a in self.areas:
            if a['kind'] == 'platform' or a['name']:
                continue
            score = defaultdict(float)
            for geom, lv, name, what in named:
                if lv and a['level'] not in lv:
                    continue
                if not lv and a['level'] != 0:
                    continue   # (a square names what lies on the ground, not the floor under it)
                if not geom.intersects(a['poly']):
                    continue
                if what == 'path':
                    inside = geom.intersection(a['poly']).length
                    if inside >= 0.6 * geom.length and inside >= 8:
                        score[name] += inside
                elif geom.geom_type == 'Point' or geom.intersection(a['poly']).area > 0.5 * min(geom.area, a['poly'].area):
                    score[name] += 1000
            if score:
                a['name'] = max(score, key=score.get)
        for x, y, lvl, name in self.cfg.get('area_names', []):
            for a in self.areas:
                if a['kind'] != 'platform' and a['level'] == lvl and a['poly'].covers(Point(x, y)):
                    a['name'] = name

    # ------------------------------------------------------------------------------------- 4b. across open areas --
    def spine(self, poly):
        """Centre line of a long platform: the longest path through the medial axis of its outline."""
        ext = Polygon(poly.exterior)
        if ext.length < 50 or ext.area / (ext.length / 2) > 18:
            return []
        boundary = ext.exterior
        pts = [boundary.interpolate(d) for d in np.arange(0, boundary.length, 1.5)]
        try:
            vor = shapely.voronoi_polygons(MultiPoint(pts), only_edges=True)
        except Exception:
            return []
        inside = prep(ext)
        adj = defaultdict(dict)
        for seg in getattr(vor, 'geoms', [vor]):
            c = list(seg.coords)
            if len(c) != 2 or not inside.contains(seg):
                continue
            if boundary.distance(seg) < 0.8:
                continue   # the twigs running into the corners
            a, b = (round(c[0][0], 2), round(c[0][1], 2)), (round(c[1][0], 2), round(c[1][1], 2))
            adj[a][b] = adj[b][a] = seg.length
        if not adj:
            return []

        def far(src):
            seen = {src: (0.0, None)}
            heap = [(0.0, src)]
            last = src
            while heap:
                d, u = heapq.heappop(heap)
                if d > seen[u][0]:
                    continue
                last = u
                for v, w in adj[u].items():
                    if v not in seen or d + w < seen[v][0]:
                        seen[v] = (d + w, u)
                        heapq.heappush(heap, (d + w, v))
            return last, seen

        # use the biggest connected piece
        best = None
        left = set(adj)
        while left:
            s = left.pop()
            _, seen = far(s)
            left -= set(seen)
            if best is None or len(seen) > best[1]:
                best = (s, len(seen))
        u, _ = far(best[0])
        v, seen = far(u)
        path = [v]
        while seen[path[-1]][1] is not None:
            path.append(seen[path[-1]][1])
        if line_len(path) < 25:
            return []
        path = [path[i] for i in simplify_idx(path, 0.4)]
        out = [path[0]]
        for a, b in zip(path, path[1:]):   # a node at least every 10 m
            n = max(1, math.ceil(dist(a, b) / 10.0))
            for k in range(1, n + 1):
                out.append((a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n))
        return out

    def mesh_areas(self):
        """Links across platforms, squares and floors, so that routes cross them instead of following their edge."""
        rooms_by_level = defaultdict(list)
        for r in self.rooms:
            rooms_by_level[r['level']].append(r['poly'])
        by_level = defaultdict(list)
        for i, (x, y, lvl) in enumerate(self.gn):
            by_level[lvl].append(i)
        pair = {}
        for e in self.edges:
            if e['kind'] == 'walk':
                pair[(min(e['a'], e['b']), max(e['a'], e['b']))] = e['len']
        self.area_nodes = []
        for ai, a in enumerate(self.areas):
            poly, lvl = a['poly'], a['level']
            if not poly.intersects(self.extent):
                continue
            free = poly
            if a['kind'] == 'floor' and rooms_by_level.get(lvl):
                cut = [r for r in rooms_by_level[lvl] if r.intersects(poly)]
                if cut:
                    parts = clean_polys(poly.difference(unary_union(cut).buffer(0.1)))
                    if parts:
                        free = max(parts, key=lambda p: p.area) if len(parts) == 1 else MultiPolygon(parts)
            a['free'] = free
            reach = prep(free.buffer(0.25))
            near = prep(free.buffer(0.2))
            local = []
            minx, miny, maxx, maxy = free.bounds
            # a square of the station table also takes the nodes along the platforms that stand on it (made
            # above): one walks straight across it to them, over the tram tracks
            for i in ([i for i in range(len(self.gn)) if self.gn[i][2] == lvl] if a.get('square')
                      else by_level.get(lvl, [])):
                x, y, _ = self.gn[i]
                if not (minx - 1 <= x <= maxx + 1 and miny - 1 <= y <= maxy + 1):
                    continue
                m = self.gmeta[i]
                on_ring = m.get('osm') in a['ids']
                if m.get('float') and not on_ring and not a['float']:
                    continue   # a bridge or tunnel that happens to cross here
                if m.get('stop') and i not in a.get('stops', []):
                    continue
                if on_ring or near.covers(Point(x, y)):
                    local.append(i)
                    m['bare'] = False
                elif m.get('bare') and free.distance(Point(x, y)) <= 3.0:
                    # a lift in a hole of the platform (its shaft): step out of the door onto the platform
                    target = free.buffer(-0.4)
                    q = nearest_points(target if not target.is_empty else free, Point(x, y))[0]
                    door = self.node(None, q.x, q.y, lvl, helper=True)
                    self.edge(i, door, 'walk', outdoor=not a['indoor'], covered=a['covered'] and not a['indoor'])
                    local.append(door)
                    m['bare'] = False
            portals = len(local)
            helpers = []
            spine = self.spine(poly) if a['kind'] == 'platform' else []
            inner = prep(free.buffer(-0.3))
            spine_ids = []
            for p in spine:
                if inner.covers(Point(p)):
                    spine_ids.append(self.node(None, p[0], p[1], lvl, helper=True, keep=True))
                else:
                    spine_ids.append(None)
            helpers += [i for i in spine_ids if i is not None]
            # corners to walk around: reflex corners of the outline and of the holes, moved a little inwards
            for part in getattr(free, 'geoms', [free]):
                simple = part.simplify(0.3, preserve_topology=True)
                if simple.is_empty or not isinstance(simple, Polygon):
                    continue
                simple = shapely.geometry.polygon.orient(simple, 1.0)
                for ring in [simple.exterior] + list(simple.interiors):
                    c = list(ring.coords)[:-1]
                    for k in range(len(c)):
                        p0, p1, p2 = c[k - 1], c[k], c[(k + 1) % len(c)]
                        cross = (p1[0] - p0[0]) * (p2[1] - p1[1]) - (p1[1] - p0[1]) * (p2[0] - p1[0])
                        if cross >= -1e-9:
                            continue   # convex corner of the walkable space
                        d0, d2 = dist(p0, p1) or 1, dist(p2, p1) or 1
                        bx = (p0[0] - p1[0]) / d0 + (p2[0] - p1[0]) / d2
                        by = (p0[1] - p1[1]) / d0 + (p2[1] - p1[1]) / d2
                        bl = math.hypot(bx, by)
                        if bl < 1e-6:
                            continue
                        for off in (0.7, 0.35):
                            q = (p1[0] - bx / bl * off, p1[1] - by / bl * off)
                            if inner.covers(Point(q)):
                                helpers.append(self.node(None, q[0], q[1], lvl, helper=True))
                                break
            if a['kind'] != 'platform' and not helpers and portals < 2 and not a.get('stops'):
                self.area_nodes.append([])
                continue
            if not local and not helpers:   # tiny platform: stand in the middle
                c = free.representative_point()
                helpers.append(self.node(None, c.x, c.y, lvl, helper=True))
            local += helpers
            self.area_nodes.append(local)
            a['nodes'] = local
            attrs = {'outdoor': not a['indoor'], 'covered': a['covered'] and not a['indoor'],
                     'name': a['name'] if a['kind'] != 'platform' else None, 'area': ai}
            adj = {i: {} for i in local}
            for i in local:
                for j in local:
                    if i < j and (i, j) in pair:
                        adj[i][j] = adj[j][i] = pair[(i, j)]

            def link(i, j, d, **more):
                adj[i][j] = adj[j][i] = d
                pair[(i, j) if i < j else (j, i)] = d
                e = self.edge(i, j, 'walk', d, **attrs)
                if e:
                    e.update(more)   # (edge() leaves out what is False)

            # The tram and bus islands that stand on a square of the station table are raised (boarding edges of
            # 16 to 27 cm): one steps onto them over their long sides, and rolls onto them at their ends. A link
            # across a long side is kept for walkers and marked wheelchair: false; the links that stay clear of the
            # long sides are made first, so that the step-free way round does not depend on the others.
            kerbs = None
            if a.get('square'):
                sides = [island_sides(b['poly']) for b in self.areas if b is not a and b['kind'] == 'platform'
                         and b['level'] == lvl and poly.buffer(1.0).covers(b['poly'])]
                sides = [x for x in sides if not x.is_empty]
                kerbs = prep(unary_union(sides)) if sides else None

            def over_kerb(i, j):
                d = dist(self.gn[i], self.gn[j])
                return d > 0.3 and kerbs.intersects(substring(LineString([self.gn[i][:2], self.gn[j][:2]]), 0.1, d - 0.1))

            for i, j in zip(spine_ids, spine_ids[1:]):
                if i is not None and j is not None and j not in adj[i]:
                    link(i, j, dist(self.gn[i], self.gn[j]))
            cands = []
            for u in range(len(local)):
                i = local[u]
                for v in range(u + 1, len(local)):
                    j = local[v]
                    d = dist(self.gn[i], self.gn[j])
                    if d > 250 or j in adj[i]:
                        continue
                    cands.append((d, i, j))
            cands.sort()
            if kerbs is not None:
                stepped = {(i, j) for d, i, j in cands if over_kerb(i, j)}
                for d, i, j in cands:
                    if j in adj[i] or (i, j) in stepped:
                        continue
                    if d > 0.05:
                        if self.within(adj, i, j, SPANNER * d + 0.3):
                            continue
                        if not reach.covers(LineString([self.gn[i][:2], self.gn[j][:2]])):
                            continue
                    link(i, j, d)
                cands = [c for c in cands if (c[1], c[2]) in stepped]
            made = len(self.edges)
            for d, i, j in cands:
                if j in adj[i]:
                    continue
                if d > 0.05:
                    if self.within(adj, i, j, SPANNER * d + 0.3):
                        continue
                    if not reach.covers(LineString([self.gn[i][:2], self.gn[j][:2]])):
                        continue
                link(i, j, d, **({'wheelchair': False} if kerbs is not None else {}))
            if kerbs is not None:
                self.note('squares', f'{a["name"] or a["src"][0]}: {len(stepped)} of the straight lines across it '
                                     f'cross the long side of a tram or bus island (a kerb); {len(self.edges) - made} '
                                     f'of them were needed as links for walkers (wheelchair: false), the others '
                                     f'are no shorter than the way round the ends of the islands')

    def within(self, adj, src, dst, limit):
        """Is there already a walk from src to dst no longer than limit?"""
        tx, ty = self.gn[dst][0], self.gn[dst][1]
        best = {src: 0.0}
        heap = [(math.hypot(self.gn[src][0] - tx, self.gn[src][1] - ty), 0.0, src)]
        while heap:
            f, d, u = heapq.heappop(heap)
            if u == dst:
                return True
            if d > best.get(u, 1e18):
                continue
            for v, w in adj[u].items():
                nd = d + w
                if nd < best.get(v, 1e18):
                    h = math.hypot(self.gn[v][0] - tx, self.gn[v][1] - ty)
                    if nd + h <= limit:
                        best[v] = nd
                        heapq.heappush(heap, (nd + h, nd, v))
        return False

    # ------------------------------------------------------------------------------------- 6. one connected graph --
    def components(self):
        parent = list(range(len(self.gn)))

        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]
                a = parent[a]
            return a

        for e in self.edges:
            a, b = find(e['a']), find(e['b'])
            if a != b:
                parent[b] = a
        return [find(i) for i in range(len(self.gn))]

    def connect(self):
        """Link platforms nobody mapped a way to, tie the remaining stops to the nearest path, keep the main part."""
        stop_nodes = [s['node'] for s in self.stops if s['node'] is not None]
        for round_ in range(6):
            comp = self.components()
            count = defaultdict(int)
            for i in stop_nodes:
                count[comp[i]] += 1
            size = defaultdict(int)
            for c in comp:
                size[c] += 1
            main = max(size, key=lambda c: (count[c], size[c]))
            # walk edges of the main part, by level, to snap onto
            lines = defaultdict(list)
            for k, e in enumerate(self.edges):
                if e['kind'] == 'walk' and comp[e['a']] == main and e['len'] > 0.01:
                    lines[self.gn[e['a']][2]].append(k)
            trees = {l: STRtree([LineString([self.gn[self.edges[k]['a']][:2], self.gn[self.edges[k]['b']][:2]])
                                 for k in ks]) for l, ks in lines.items()}
            linked = 0
            done = set()
            for a in self.areas:
                nodes = [i for i in a.get('nodes', []) if comp[i] != main]
                if not nodes or a['level'] not in trees or not (a.get('stops') or a['kind'] == 'platform'):
                    continue
                c = comp[nodes[0]]
                if c in done:
                    continue
                tree, ks = trees[a['level']], lines[a['level']]
                j = int(tree.nearest(a['poly']))
                k = ks[j]
                seg = tree.geometries[j]
                gap = seg.distance(a['poly'])
                if gap > ISLAND_LINK:
                    continue
                # from the node of the platform that is nearest to a path (a link from the tip of the platform
                # makes routes run past the stop and back)
                best = None
                for j2 in tree.query(a['poly'].buffer(ISLAND_LINK), predicate='intersects'):
                    for i2 in nodes:
                        d = tree.geometries[int(j2)].distance(Point(self.gn[i2][:2]))
                        if best is None or d < best[0]:
                            best = (d, int(j2), i2)
                _, j, i = best
                k, seg = ks[j], tree.geometries[j]
                on_seg = seg.interpolate(seg.project(Point(self.gn[i][:2])))
                m = self.split(k, (on_seg.x, on_seg.y))
                e = self.edges[k]
                self.edge(i, m, 'walk', outdoor=e.get('outdoor'), covered=e.get('covered'), inferred=True)
                self.note('inferred links', f'{a["kind"]} {",".join(a["refs"]) or a["name"] or ""} ({a["src"][0]}) at '
                          f'({self.gn[i][0]:.0f}, {self.gn[i][1]:.0f}) level {a["level"]:g}: no way mapped to it, '
                          f'linked to the nearest path {dist(self.gn[i], self.gn[m]):.1f} m away')
                done.add(c)
                linked += 1
            if not linked:
                break
        comp = self.components()
        count = defaultdict(int)
        for i in stop_nodes:
            count[comp[i]] += 1
        size = defaultdict(int)
        for c in comp:
            size[c] += 1
        main = max(size, key=lambda c: (count[c], size[c]))
        self.main = main
        self.comp = comp

        # stops without an OSM platform, or whose platform could not be linked: the nearest node of the main part,
        # on the level ATLAS gives, else on the level of the other edges of the stop, and preferably outdoors
        open_air = set()
        for e in self.edges:
            if e.get('outdoor'):
                open_air.update((e['a'], e['b']))
        siblings = defaultdict(list)
        taken = {s['node'] for s in self.stops if s['node'] is not None}
        for s in self.stops:
            if s['node'] is not None and comp[s['node']] == main:
                siblings[s['uic']].append(self.gn[s['node']][2])
        for s in self.stops:
            if s['how'] == 'outside the extent':
                continue
            if s['node'] is not None and comp[s['node']] == main:
                continue
            why = 'no OSM platform' if s['node'] is None else 'its OSM platform is not connected to any path'
            want = s['atlas_level']
            if want is None and siblings[s['uic']]:
                want = max(set(siblings[s['uic']]), key=siblings[s['uic']].count)
            # (the level of the other stops of the same id says nothing about a place on a street that slopes)
            slope_ok = s['atlas_level'] is None
            best = None
            for i, (x, y, lvl) in enumerate(self.gn):
                if comp[i] != main or self.gmeta[i].get('helper') or i in taken                         or not (float(lvl).is_integer() or i in open_air):
                    continue   # (on a whole level, or on a street that slopes)
                d = dist((x, y), s['p'])
                if want is not None and not (slope_ok and not float(lvl).is_integer()):
                    d += 40 * abs(lvl - want)
                if s['atlas_level'] is None and i not in open_air:
                    d += 25
                if best is None or d < best[0]:
                    best = (d, i)
            # a place along a path beats its nearest corner when that is clearly closer
            spot = None
            for k, e in enumerate(self.edges):
                a, b = self.gn[e['a']], self.gn[e['b']]
                if e['kind'] != 'walk' or comp[e['a']] != main or e['len'] < 6                         or not (float(a[2]).is_integer() or e.get('outdoor'))                         or e.get('area') is not None or e.get('inferred'):
                    continue
                seg = LineString([a[:2], b[:2]])
                q = seg.interpolate(seg.project(Point(s['p'])))
                if min(dist((q.x, q.y), a), dist((q.x, q.y), b)) < 3:
                    continue
                d = dist((q.x, q.y), s['p'])
                if want is not None and not (slope_ok and e.get('outdoor') and not (
                        float(a[2]).is_integer() and float(b[2]).is_integer())):
                    d += 40 * abs(a[2] - want)
                if s['atlas_level'] is None and not e.get('outdoor'):
                    d += 25
                if d < best[0] - 3 and (spot is None or d < spot[0]):
                    spot = (d, k, (q.x, q.y))
            if spot:
                best = (spot[0], self.split(spot[1], spot[2]))
                comp.append(main)
                self.gmeta[best[1]]['keep'] = True
            s['node'] = best[1]
            taken.add(best[1])
            s['how'] = f'nearest place on a path ({why}), {dist(self.gn[best[1]], s["p"]):.0f} m from the ATLAS position'
            self.note('stops tied to the nearest path', f'{s["name"]} {s["ref"] or "(no ref)"} [{s["uic"]}]: {s["how"]}')

    def split(self, k, p):
        """Put a node on edge k at point p (or return an end that is close enough)."""
        e = self.edges[k]
        a, b = e['a'], e['b']
        if dist(self.gn[a], p) < 0.3:
            return a
        if dist(self.gn[b], p) < 0.3:
            return b
        la, lb = self.gn[a][2], self.gn[b][2]
        t = dist(self.gn[a], p) / max(dist(self.gn[a], self.gn[b]), 0.01)
        m = self.node(None, p[0], p[1], la if la == lb else round(la + (lb - la) * t, 2))
        rest = dict(e)
        rest.update(a=m, len=dist(self.gn[b], p))
        e.update(b=m, len=dist(self.gn[a], p))
        self.edges.append(rest)
        return m

    def nearest_node(self, p, level, limit=60.0, only=None, tol=0.01):
        best = None
        for i, (x, y, lvl) in enumerate(self.gn):
            if self.comp[i] != self.main or abs(lvl - level) > tol or self.gmeta[i].get('helper'):
                continue
            if only and not only(i):
                continue
            d = dist((x, y), p)
            if d <= limit and (best is None or d < best[0]):
                best = (d, i)
        return best

    def add_entrances(self):
        self.entrances = []
        items = [(n, (x, y), float(lvl), 'config') for n, x, y, lvl in self.cfg.get('entrances', [])]
        for n in self.nodes.values():   # doors of the station that carry a name in OSM
            t = n['tags']
            if t.get('name') and (t.get('railway') in ('train_station_entrance', 'subway_entrance') or t.get('entrance')):
                lv = parse_levels(t)
                if self.extent.covers(Point(n['xy'])) and not any(dist(i[1], n['xy']) < 20 for i in items):
                    items.append((t['name'], n['xy'], lv[0] if lv else 0.0, f'node {n["id"]}'))
        for name, p, lvl, src in items:
            hit = self.nearest_node(p, lvl, 25.0)
            if not hit:
                # the end of a path that climbs or falls away from the level: the street it comes out on
                hit = self.nearest_node(p, lvl, 25.0, tol=0.95)
                if hit:
                    self.note('entrances', f'{name} ({src}): no path node on level {lvl:g} within 25 m; tied to the '
                                           f'end of the sloping path at level {self.gn[hit[1]][2]:g}')
            if not hit:
                self.note('entrances', f'{name} ({src}): no path node on level {lvl:g} within 25 m, left out')
                continue
            i = hit[1]
            self.gmeta[i]['keep'] = True
            self.entrances.append({'name': name, 'level': self.gn[i][2], 'xy': self.gn[i][:2], 'node': i,
                                   'gap': hit[0]})

    def prune(self):
        """Drop everything outside the main part, then thin out nodes that only bend a path by less than 0.2 m."""
        comp, main = self.comp, self.main
        dropped = defaultdict(lambda: [0, 0.0, None])
        for e in self.edges:
            if comp[e['a']] != main:
                d = dropped[comp[e['a']]]
                d[0] += 1
                d[1] += e['len']
                d[2] = e
        for c, (n, length, e) in sorted(dropped.items(), key=lambda kv: -kv[1][1]):
            x, y, lvl = self.gn[e['a']]
            if length >= 15:
                levelled = e.get('way') and self.walk[e['way']]['lv']
                self.note('dropped parts (not connected to the stops)',
                          f'{length:.0f} m around ({x:.0f}, {y:.0f}) level {lvl:g}'
                          + (f', e.g. way {e["way"]}' if e.get('way') else '') + (' [levelled]' if levelled else ''))
        self.edges = [e for e in self.edges if comp[e['a']] == main]

        deg = defaultdict(list)
        for k, e in enumerate(self.edges):
            deg[e['a']].append(k)
            deg[e['b']].append(k)
        keep = set()
        for s in self.stops:
            if s['node'] is not None:
                keep.add(s['node'])
        for i, m in enumerate(self.gmeta):
            if m.get('keep') or m.get('lift') is not None or m.get('stop'):
                keep.add(i)

        def sig(e):
            return (e['kind'], e.get('outdoor'), e.get('covered'), e.get('name'), e.get('wheelchair'), e.get('closed'),
                    e.get('oneway'), e.get('way'), e.get('area'), e.get('inferred'))

        def joint(i):
            if i in keep or len(deg[i]) != 2:
                return True
            e1, e2 = self.edges[deg[i][0]], self.edges[deg[i][1]]
            if sig(e1) != sig(e2):
                return True
            if e1.get('oneway') and not ((e1['b'] == i) != (e2['b'] == i)):
                return True
            return False

        new_edges, seen = [], set()
        for k, e in enumerate(self.edges):
            if k in seen:
                continue
            if not (joint(e['a']) or joint(e['b'])):
                continue
            for start in (e['a'], e['b']):
                if not joint(start) or k in seen:
                    continue
                # walk the chain from a joint to the next joint
                chain, ks, cur, ek = [start], [], start, k
                while True:
                    seen.add(ek)
                    ks.append(ek)
                    ee = self.edges[ek]
                    cur = ee['b'] if ee['a'] == cur else ee['a']
                    chain.append(cur)
                    if joint(cur):
                        break
                    ek = deg[cur][0] if deg[cur][1] == ek else deg[cur][1]
                    if ek in seen:
                        break
                pts = [(self.gn[i][0], self.gn[i][1], self.z_of(self.gn[i][2])) for i in chain]
                idx = simplify_idx(pts, 0.2) if len(chain) > 2 else [0, len(chain) - 1]
                first = self.edges[ks[0]]
                forward = first['a'] == chain[0]
                for u, v in zip(idx, idx[1:]):
                    ne = dict(first)
                    ne['len'] = sum(self.edges[q]['len'] for q in ks[u:v])
                    ne['a'], ne['b'] = (chain[u], chain[v]) if forward else (chain[v], chain[u])
                    new_edges.append(ne)
        # closed loops without any joint keep their edges
        for k, e in enumerate(self.edges):
            if k not in seen:
                new_edges.append(e)
        self.edges = new_edges

        used = sorted({e['a'] for e in self.edges} | {e['b'] for e in self.edges})
        remap = {old: new for new, old in enumerate(used)}
        self.gn = [self.gn[i] for i in used]
        self.gmeta = [self.gmeta[i] for i in used]
        for e in self.edges:
            e['a'], e['b'] = remap[e['a']], remap[e['b']]
        # two edges between the same nodes: keep the shorter of the same kind
        best = {}
        for e in self.edges:
            k = (min(e['a'], e['b']), max(e['a'], e['b']), e['kind'], bool(e.get('oneway')) and e['a'] < e['b'])
            if k not in best or e['len'] < best[k]['len']:
                best[k] = e
        self.edges = list(best.values())
        for s in self.stops:
            s['node'] = remap.get(s['node']) if s['node'] is not None else None
        for en in self.entrances:
            en['node'] = remap[en['node']]
        self.remap = remap
        live_ways = {e.get('way') for e in self.edges}
        self.connectors = [c for c in self.connectors
                           if (c['kind'] == 'elevator' and c['hub'] in remap) or c.get('way') in live_ways]

    # ------------------------------------------------------------------------------- 7. things around the graph --
    def add_pois(self):
        self.pois = []

        def kind_of(t):
            if t.get('amenity') == 'toilets':
                return 'toilets'
            if t.get('amenity') in ('luggage_locker', 'lockers', 'left_luggage', 'locker'):
                return 'lockers'
            if t.get('shop') == 'ticket' or t.get('vending') == 'public_transport_tickets':
                return 'tickets'
            if t.get('tourism') == 'information' and t.get('information') in ('office', 'tactile_map', 'map') \
                    and (t.get('information') == 'office' or 'level' in t):
                return 'info'
            if t.get('amenity') == 'meeting_point':
                return 'meeting-point'
            return None

        seen = set()
        items = []
        for e in list(self.nodes.values()) + [w for w in self.ways.values() if not w['dead']]:
            t = e['tags']
            k = kind_of(t)
            if not k or no_entry(t):
                continue
            if 'xy' in e:
                p = e['xy']
            else:
                c = Polygon(e['pts']).representative_point() if e['closed'] else LineString(e['pts']).centroid
                p = (c.x, c.y)
            lv = parse_levels(t)
            name = t.get('name') or {'tickets': 'Ticket machine' if t.get('vending') else 'Tickets',
                                     'toilets': 'Toilets', 'lockers': 'Lockers', 'info': 'Information',
                                     'meeting-point': 'Meeting point'}[k]
            items.append((k, name, p, lv[0] if lv else None, t.get('layer') not in (None, '0')))
        for k, name, x, y, lvl in self.cfg.get('pois', []):
            items.append((k, name, (x, y), float(lvl), False))
        # (without level=* and without layer=* a thing stands on the ground: not in the underpass that runs below
        # it, not on the bridge above it)
        ground = [i for i in range(len(self.gn)) if not self.gmeta[i].get('float')] or list(range(len(self.gn)))
        for k, name, p, lvl, layered in items:
            if not self.extent.covers(Point(p)):
                continue
            if lvl is None:   # the level of the ground there
                best = min(range(len(self.gn)) if layered else ground, key=lambda i: dist(self.gn[i], p))
                lvl = float(round(self.gn[best][2]))
            key = (k, round(p[0] / 3), round(p[1] / 3), lvl)
            if key in seen:
                continue   # a row of ticket machines is one point
            seen.add(key)
            self.pois.append({'kind': k, 'name': name, 'level': int(lvl) if float(lvl).is_integer() else lvl,
                              'xy': [round(p[0], 2), round(p[1], 2)]})

    def add_tracks(self):
        self.tracks = []
        clip = self.extent
        plats = [a for a in self.areas if a['kind'] == 'platform' and a['refs']]
        for a in plats:
            a['keys'] = {key_of(r) for r in a['refs']}
        levels = self.rail_levels(final=True)
        for w in self.ways.values():
            t = w['tags']
            if w['dead'] or t.get('railway') not in RAILWAYS:
                continue
            level = levels[w['id']]
            line = LineString(w['pts']).intersection(clip)
            for part in getattr(line, 'geoms', [line]):
                if part.geom_type != 'LineString' or part.length < 2:
                    continue
                pts = list(part.simplify(0.25).coords)
                tr = {'level': int(level) if float(level).is_integer() else level,
                      'line': [[round(x, 2), round(y, 2)] for x, y in pts]}
                ref = t.get('railway:track_ref')
                if ref and any(key_of(ref) in a['keys'] and a['poly'].distance(part) < 6 for a in plats):
                    tr['ref'] = ref   # the track along the platform with that number
                if t.get('railway') != 'rail':
                    tr['kind'] = t['railway']
                self.tracks.append(tr)

    def ground_z(self, p):
        """Height of the ground near a point: the nearest outdoor path node that is not on a bridge."""
        best = None
        for i, (x, y, lvl) in enumerate(self.gn):
            m = self.gmeta[i]
            if m.get('float') or m.get('off') or m.get('helper') or 'osm' not in m:
                continue
            d = dist((x, y), p)
            if best is None or d < best[0]:
                best = (d, lvl)
        return self.z_of(best[1]) if best and best[0] < 120 else 0.0

    def add_shell(self):
        self.shell = []
        outlines = [(p, t, s) for p, t, s in self.buildings if 'building' in t and not t.get('_deck')]
        parts = [(p, t, s) for p, t, s in self.buildings if 'building:part' in t and 'building' not in t]
        part_tree = STRtree([p.representative_point() for p, _, _ in parts]) if parts else None
        levelled = [a for a in self.areas if a.get('nodes')]
        todo = []
        for p, t, s in outlines:
            if part_tree is not None and t.get('building') != 'roof' and \
                    len(part_tree.query(p, predicate='contains')) > 0:
                continue   # drawn by its parts
            todo.append((p, t, s))
        for p, t, s in todo + parts + [(p, t, s) for p, t, s in self.buildings if t.get('_deck')]:
            if not p.intersects(self.extent) or p.area < 6:
                continue
            c = p.representative_point()
            lv = parse_levels(t)
            is_roof = t.get('building') == 'roof' or t.get('building:part') == 'roof'
            height = num(t.get('height'))
            floors = num(t.get('building:levels'))
            given = next((d for d in self.cfg.get('decks', []) if p.covers(Point(d[0], d[1]))), None) \
                if t.get('_deck') else None
            if given:   # a bridge nobody walks on, height from the station table
                top, t = given[2], dict(t, name=given[3])
                kind, base = 'deck', top - 2.0
                p = p.intersection(self.extent.buffer(15))
            elif t.get('_deck'):
                if lv:
                    top = self.z_of(lv[0])
                else:   # a bridge: as high as the paths on it
                    on = [self.gn[i][2] for i in range(len(self.gn)) if self.gmeta[i].get('float')
                          and p.covers(Point(self.gn[i][:2]))]
                    if not on:
                        continue
                    top = self.z_of(sorted(on)[len(on) // 2])
                kind, base = 'deck', top - 1.0
            elif is_roof:
                under = [a['level'] for a in levelled if a['poly'].intersects(p) and a['kind'] != 'plaza']
                ground = self.z_of(max(under)) if under else (self.z_of(lv[0]) if lv else self.ground_z((c.x, c.y)))
                if lv and not under:
                    ground = self.z_of(lv[0])
                top = ground + (height if height else 5.0)
                kind, base = 'roof', top - 0.4
            else:
                ground = self.z_of(lv[0]) if lv else self.ground_z((c.x, c.y))
                base = ground + (num(t.get('min_height'), 0.0) or 0.0)
                if num(t.get('building:min_level')):
                    base = ground + num(t.get('building:min_level')) * 3.2
                if height:
                    top = ground + height
                elif floors:
                    top = ground + floors * 3.2 + (num(t.get('roof:levels'), 0.0) or 0.0) * 2.0 + 0.5
                else:
                    top = ground + (4.0 if p.area < 40 else 12.0)
                kind = 'building'
            if top <= base:
                continue
            for q in [r for g in clean_polys(p) for r in tidy(g, 0.5)] if given else tidy(p, 0.5):
                item = {'kind': kind, 'ring': ring_xy(q.exterior), 'base': round(base, 1), 'top': round(top, 1)}
                if q.interiors:
                    item['holes'] = [ring_xy(h) for h in q.interiors]
                if t.get('name'):
                    item['name'] = t['name']
                self.shell.append(item)

    # ------------------------------------------------------------------------------------------- 8. check and emit --
    def model(self):
        # (an area counts only when a path of the final graph reaches it: floors whose paths were dropped as not
        # connected to the stops, like the lecture halls above Zürich HB, do not make a level)
        used_levels = sorted({int(l) for x, y, l in self.gn if float(l).is_integer()}
                             | {int(a['level']) for a in self.areas if a.get('nodes')
                                and any(self.gkey.get((n, a['level'])) is not None for n in a['ids'])})
        names = self.cfg['levels']
        levels = [{'id': l, 'z': round(self.z_of(l), 2), 'name': names[l][1] if l in names else f'Level {l}'}
                  for l in used_levels]
        lo, hi = used_levels[0], used_levels[-1]

        areas = []
        live = self.extent.buffer(1)
        for a in self.areas:
            if not a['poly'].intersects(self.extent) or not (lo <= a['level'] <= hi):
                continue
            if not a.get('nodes') and a['kind'] != 'platform':
                # a square or floor no route can reach is still worth drawing when it is part of the complex
                if not any(self.gkey.get((n, a['level'])) is not None for n in a['ids']):
                    continue
            for q in tidy(a['poly'].intersection(live) if not live.contains(a['poly']) else a['poly']):
                item = {'level': int(a['level']), 'kind': a['kind'], 'ring': ring_xy(q.exterior)}
                if q.interiors:
                    item['holes'] = [ring_xy(h) for h in q.interiors]
                if a['kind'] == 'platform':
                    item['refs'] = a['refs']
                if a['name']:
                    item['name'] = a['name']
                shut = next((self.shut(s['closed']) for s in self.stops if s.get('area') is a and s.get('closed')
                             and s['closed'].get('whole')), None)
                if shut:
                    item['closed'] = shut
                areas.append(item)
        for r in self.rooms:
            if not r['poly'].intersects(self.extent) or not (lo <= r['level'] <= hi) or not float(r['level']).is_integer():
                continue
            t = r['tags']
            for q in tidy(r['poly']):
                item = {'level': int(r['level']), 'kind': 'room', 'ring': ring_xy(q.exterior), 'height': 3}
                if q.interiors:
                    item['holes'] = [ring_xy(h) for h in q.interiors]
                name = t.get('name') or (t.get('shop') or t.get('amenity') or '').replace('_', ' ')
                if name and name != 'yes':
                    item['name'] = name
                areas.append(item)

        def lvl(v):
            return int(v) if float(v).is_integer() else round(v, 2)

        nodes = [[round(x, 2), round(y, 2), lvl(l)] for x, y, l in self.gn]
        edges = []
        steep, short, steps = [], set(), []
        for e in self.edges:
            o = {'a': e['a'], 'b': e['b'], 'kind': e['kind'], 'len': round(e['len'], 2)}
            for k in ('oneway', 'outdoor', 'covered'):
                if e.get(k):
                    o[k] = True
            if e.get('closed'):
                o['closed'] = e['closed']
            if e.get('inferred'):
                o['inferred'] = True
            rise = abs(self.z_of(self.gn[e['a']][2]) - self.z_of(self.gn[e['b']][2]))
            if e['kind'] in ('walk', 'ramp') and rise > 0.5 and rise > STEEPEST_PATH * max(e['len'], 0.3):
                # Nobody walks up a slope like this: OSM lacks the steps here, or two level=* tags that meet here
                # mean the same floor. Either way it is not a step-free way: kept, as steps.
                a, b = self.gn[e['a']], self.gn[e['b']]
                self.note('paths steeper than stairs (taken as steps)',
                          f'{e["kind"]} at ({a[0]:.0f}, {a[1]:.0f}), levels {a[2]:g} to {b[2]:g}: {rise:.1f} m over '
                          f'{e["len"]:.1f} m' + (f', way {e["way"]}' if e.get('way') else ''))
                o['kind'] = e['kind'] = 'stairs'
                steps.append({'kind': 'stairs', 'line': [[round(a[0], 2), round(a[1], 2), lvl(a[2])],
                                                         [round(b[0], 2), round(b[1], 2), lvl(b[2])]],
                              'width': 1.5, '_way': e.get('way')})
            if e['kind'] == 'ramp' or (e['kind'] == 'walk' and rise > 0.005):
                # the real slope; steeper than a ramp can be (16 % when OSM maps it as a way between two levels,
                # 12 % when the heights are inferred) means it is not step-free, whatever it is
                slope = rise / max(e['len'], 0.3)
                o['incline'] = round(slope, 3)
                mapped = e.get('way') and len(self.walk[e['way']]['lv'] or []) > 1
                if slope > (RAMP_MAX_MAPPED if mapped else RAMP_MAX_INFERRED) and rise > 0.3:
                    o['wheelchair'] = False
                    steep.append((o, e))
            elif e['kind'] in ('stairs', 'escalator') and rise > 2 and rise > 1.2 * e['len'] and e.get('way'):
                short.add(e['way'])
            if e.get('wheelchair') is False:
                o['wheelchair'] = False
            if e.get('name'):
                o['name'] = e['name']
            edges.append(o)
        for o, e in steep:
            if o['len'] > 2:
                a = self.gn[e['a']]
                self.note('steep slopes (not step-free)', f'{o["len"]:.0f} m at {o["incline"] * 100:.0f} % at '
                          f'({a[0]:.0f}, {a[1]:.0f}), levels {a[2]:g} to {self.gn[e["b"]][2]:g}'
                          + (f', way {e["way"]}' if e.get('way') else ''))
        for wid in sorted(short):
            w = self.walk[wid]
            self.note('stairs drawn shorter than they are high (steeper than 50 degrees)',
                      f'way {wid} at ({w["pts"][0][0]:.0f}, {w["pts"][0][1]:.0f}): {line_len(w["pts"]):.1f} m long, '
                      f'{abs(self.z_of(self.wl[wid][0]) - self.z_of(self.wl[wid][-1])):.1f} m high'
                      + (' (escalator)' if w['tags'].get('conveying') else ''))
        connectors = []
        for c in self.connectors:
            if c['kind'] == 'elevator':
                connectors.append({'kind': 'elevator', 'xy': c['xy'], 'levels': c['levels'], '_hub': c['hub']})
            else:
                o = {'kind': c['kind'], 'line': [[x, y, lvl(l)] for x, y, l in c['line']], 'width': c['width']}
                if c.get('oneway'):
                    o['oneway'] = c['oneway']
                if c.get('closed'):
                    o['closed'] = c['closed']
                rise = abs(self.z_of(c['line'][0][2]) - self.z_of(c['line'][-1][2]))
                run = line_len(c['line'])
                if c['kind'] == 'escalator' and len(c['line']) == 2 and rise > 1 and run < rise / math.tan(math.radians(35)):
                    (x0, y0, l0), (x1, y1, l1) = c['line']
                    grow = (rise / math.tan(math.radians(30)) - run) / 2 / max(run, 0.1)
                    ends = [[x0 - (x1 - x0) * grow, y0 - (y1 - y0) * grow, l0], [x1 + (x1 - x0) * grow, y1 + (y1 - y0) * grow, l1]]
                    if any(r['level'] == q[2] and r['poly'].covers(Point(q[0], q[1])) for q in ends for r in self.rooms):
                        self.note('escalators drawn steeper than 35 degrees', f'way {c.get("way")} at ({x0:.0f}, {y0:.0f}): '
                                  f'{run:.1f} m for {rise:.1f} m; left, a longer line would run into a room')
                    else:
                        o['line'] = [[round(q[0], 2), round(q[1], 2), lvl(q[2])] for q in ends]
                        self.note('escalators drawn steeper than 35 degrees', f'way {c.get("way")} at ({x0:.0f}, {y0:.0f}): '
                                  f'{run:.1f} m for {rise:.1f} m in OSM; drawn {line_len(ends):.1f} m long (30 degrees)')
                o['_way'] = c.get('way')
                connectors.append(o)
        connectors += steps
        stops = []
        for s in self.stops:
            if s['node'] is None:
                continue
            x, y, l = self.gn[s['node']]
            stops.append({'uic': s['uic'], 'ref': s['ref'], 'mode': s['mode'], 'name': s['name'], 'level': lvl(l),
                          'xy': [round(x, 2), round(y, 2)], 'node': s['node']})
            if s.get('closed') and self.shut(s['closed']):
                stops[-1]['closed'] = self.shut(s['closed'])
            if s.get('closed') and s['closed'].get('remark'):
                stops[-1]['note'] = s['closed']['remark']
        entrances = [{'name': e['name'], 'level': lvl(self.gn[e['node']][2]),
                      'xy': [round(v, 2) for v in self.gn[e['node']][:2]], 'node': e['node']} for e in self.entrances]
        xs = [n[0] for n in nodes] + [p[0] for a in areas for p in a['ring']]
        ys = [n[1] for n in nodes] + [p[1] for a in areas for p in a['ring']]
        return {
            'key': self.key, 'name': self.cfg['name'], 'built': datetime.date.today().isoformat(),
            'attribution': ['© OpenStreetMap contributors', 'opentransportdata.swiss'] + self.credits,
            'origin': [self.lon0, self.lat0],
            'bbox': [round(min(xs), 2), round(min(ys), 2), round(max(xs), 2), round(max(ys), 2)],
            'uics': sorted({s['uic'] for s in stops}),
            'levels': levels, 'areas': areas, 'connectors': connectors,
            # (a deck under the lowest level of the model, an underground car park, is of no use to the viewer)
            'shell': [p for p in self.shell if p['kind'] != 'deck' or p['top'] >= levels[0]['z'] - 0.5],
            # tracks in tunnels below the lowest level of the model (layer=-3, -4) are of no use to the viewer
            'tracks': [t for t in self.tracks if lo <= t['level'] <= hi],
            'stops': stops, 'sectors': [], 'entrances': entrances, 'pois': self.pois,
            'graph': {'nodes': nodes, 'edges': edges},
        }

    # ------------------------------------------------------------------------ 7b. layers and what hangs on them --
    def enrich(self, model):
        """Everything that is added to the finished model: one stop per platform edge with all its nodes, closures,
        floors where OSM only has paths, and the open-data layers of the station (tools/station3d_data/<key>/)."""
        N, E = model['graph']['nodes'], model['graph']['edges']
        lo, hi = model['levels'][0]['id'], model['levels'][-1]['id']

        def live(a):
            return [self.remap[i] for i in a.get('nodes', []) if i in self.remap]

        def lvl(v):
            return int(v) if float(v).is_integer() else round(v, 2)

        # -- stops: ATLAS often has several points for one track; one stop per number, with every node along it
        stops, seen, merged = [], {}, 0
        for st in self.stops:
            if st['node'] is None:
                continue
            x, y, l = self.gn[st['node']]
            a = st.get('area')
            along = live(a) if a is not None and str(st['how']).startswith('platform') else []
            gap = dist((x, y), st['p'])
            item = {'uic': st['uic'], 'ref': st['ref'], 'mode': st['mode'], 'name': st['name'], 'level': lvl(l),
                    'xy': [round(x, 2), round(y, 2)], 'node': st['node'],
                    'nodes': sorted(set(along) | {st['node']})}
            for su, sname, sx, sy, _why in self.cfg.get('stop_areas', []):
                # one ATLAS edge for two platforms (the side platforms of a metro): the other one's nodes too
                if su == st['uic'] and sname in (st['ref'], st['name']):
                    for ar in self.areas:
                        if ar['kind'] == 'platform' and ar['poly'].buffer(0.5).contains(Point(sx, sy)):
                            item['nodes'] = sorted(set(item['nodes']) | set(live(ar)))
            if not st['ref']:
                # (the app can only name a stop without a number by this point: the router takes a position
                # within 3 m of it for the stop, on the level the stop has here)
                item['at'] = [round(st['p'][0], 2), round(st['p'][1], 2)]
            if st.get('closed') and self.shut(st['closed']):
                item['closed'] = self.shut(st['closed'])
            if st.get('closed') and st['closed'].get('remark'):
                item['note'] = st['closed']['remark']
            key = (st['uic'], key_of(st['ref'])) if st['ref'] else None
            if key in seen:
                first, best = seen[key]
                first['nodes'] = sorted(set(first['nodes']) | set(item['nodes']))
                if gap < best - 0.01:     # the point that fits the platform best is where the stop is shown
                    first.update(level=item['level'], xy=item['xy'], node=item['node'])
                    seen[key] = (first, gap)
                merged += 1
                continue
            if key:
                seen[key] = (item, gap)
            item['_p'], item['_bearing'] = st['p'], st.get('bearing')
            stops.append(item)
        # two stops are never shown in one spot: the later one moves to the nearest free node along its platform
        used = set()
        for item in stops:
            if item['node'] in used:
                free = [i for i in item['nodes'] if i not in used]
                if free:
                    i = min(free, key=lambda i: dist(N[i], item['_p']))
                    item.update(node=i, xy=[N[i][0], N[i][1]], level=N[i][2])
                    self.note('stops', f'{item["name"]} {item["ref"]}: its point was taken by another stop, moved '
                                       f'along the platform to ({N[i][0]:.0f}, {N[i][1]:.0f})')
            used.add(item['node'])
        # stops without a letter that share a name: say which is which
        winds = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']
        groups = defaultdict(list)
        for item in stops:
            if not item['ref']:
                groups[item['uic']].append(item)
        for items in groups.values():
            if len(items) < 2:
                continue
            cx = sum(i['xy'][0] for i in items) / len(items)
            cy = sum(i['xy'][1] for i in items) / len(items)
            names = []
            for i in items:
                if i['_bearing'] is not None:
                    names.append(f'{i["name"]} (towards {winds[int((i["_bearing"] % 360 + 22.5) // 45) % 8]})')
                else:
                    dx, dy = i['xy'][0] - cx, i['xy'][1] - cy
                    side = ('east' if dx > 0 else 'west') if abs(dx) > abs(dy) else ('north' if dy > 0 else 'south')
                    names.append(f'{i["name"]} ({side} side)')
            if len(set(names)) == len(names):
                for i, n in zip(items, names):
                    i['name'] = n
        for x, y, name, mode in self.cfg.get('stop_names', []):
            near = [i for i in stops if not i['ref'] and dist(i['xy'], (x, y)) <= 10]
            if len(near) == 1:
                near[0].update(name=name, mode=mode)
            else:
                self.note('config', f'stop_names [{x}, {y}, {name}]: {len(near)} stops without a number within 10 m, '
                                    f'not used')
        for item in stops:
            item.pop('_p'), item.pop('_bearing')
        if merged:
            self.note('stops', f'{merged} ATLAS points merged into the stop of the same number '
                               f'({len(self.stops) - merged} stops in the model)')
        model['stops'] = stops

        # -- closures: a closed platform takes its stairs, escalators, ramps and lifts with it
        for a in self.areas:
            c = next((self.shut(st['closed']) for st in self.stops if st.get('area') is a and st.get('closed')
                      and st['closed'].get('whole')), None)
            if not c:
                continue
            on = set(live(a))
            zone = prep(a['poly'].buffer(4))
            for i, m in enumerate(self.gmeta):
                if m.get('lift') is not None and N[i][2] == a['level'] and zone.covers(Point(N[i][:2])):
                    on.add(i)
            ways, lifts = set(), set()
            for e, o in zip(self.edges, E):
                if o['kind'] != 'walk' and (o['a'] in on or o['b'] in on):
                    o.setdefault('closed', c)
                    ways.add(e.get('way'))
                    if o['kind'] == 'elevator':
                        lifts.add((round(N[o['a']][0], 1), round(N[o['a']][1], 1)))
            ways.discard(None)
            n = 0
            for cn in model['connectors']:
                if cn.get('_way') in ways or (cn['kind'] == 'elevator'
                                              and (round(cn['xy'][0], 1), round(cn['xy'][1], 1)) in lifts):
                    cn.setdefault('closed', c)
                    n += 1
            self.note('closures', f'platform {",".join(a["refs"])}: closed {c}; with it {n} connectors '
                                  f'({len(ways)} stairs / escalators / ramps, {len(lifts)} lifts)')
        # -- exits named after where they come out (OSM names the stairs after the street behind them)
        for x, y, name in self.cfg.get('exit_names', []):
            hit = [o for o in E if o['kind'] != 'walk' and min(dist(N[o['a']], (x, y)), dist(N[o['b']], (x, y))) <= 8]
            for o in hit:
                o['name'] = name
            self.note('exits', f'{name}: {len(hit)} stairs / escalator / lift edges within 8 m of ({x}, {y}) named '
                               f'({", ".join(sorted({o["kind"] for o in hit})) or "none found"})')
        notices = [{k: n[k] for k in ('text', 'from', 'until') if n.get(k)} for n in self.cfg.get('notices', [])
                   if not n.get('until') or n['until'] > self.today]
        if notices:
            model['notices'] = notices

        # -- floors where OSM only has paths (derived: true): decks with a level, then a strip along every path
        #    off level 0 that has no drawn area under it
        have = defaultdict(list)
        for a in model['areas']:
            if a['kind'] != 'room':
                have[a['level']] += clean_polys(Polygon(a['ring'], a.get('holes')))
        derived = []
        for poly, t, src in self.buildings:
            lv = parse_levels(t)
            if t.get('_deck') and lv and float(lv[0]).is_integer() and lo <= lv[0] <= hi and lv[0] != 0 \
                    and poly.intersects(self.extent) and t.get('man_made') != 'bridge':
                derived.append((int(lv[0]), poly, 'plaza', ''))
                have[int(lv[0])].append(poly)
        for L in [l['id'] for l in model['levels']]:
            under = unary_union(have[L]) if have[L] else None
            cover = prep(under.buffer(0.6)) if under is not None else None
            lines = []
            for o in E:
                a, b = N[o['a']], N[o['b']]
                if o['kind'] != 'walk' or a[2] != L or b[2] != L or o['len'] < 0.5 or (L == 0 and o.get('outdoor')):
                    continue   # (on level 0 only indoors: the streets have their pavements)
                line = LineString([a[:2], b[:2]])
                if cover is not None and cover.covers(line):
                    continue
                lines.append((line, bool(o.get('outdoor')), o.get('name', '')))
            if not lines:
                continue
            u = unary_union([l.buffer(2.0, cap_style=2, join_style=2) for l, _, _ in lines])
            u = u.buffer(1.5, join_style=2).buffer(-1.5, join_style=2)
            if under is not None:
                u = u.difference(under)
            for q in clean_polys(u, 10):
                inside = [(l.length, out, name) for l, out, name in lines if q.buffer(0.5).covers(l)]
                total = sum(i[0] for i in inside) or 1.0
                names = defaultdict(float)
                for length, _, name in inside:
                    names[name] += length
                name = max(names, key=names.get) if names else ''
                derived.append((L, q, 'plaza' if sum(i[0] for i in inside if i[1]) > 0.5 * total else 'floor',
                                name if names.get(name, 0) > 0.5 * total else ''))
        count = defaultdict(int)
        for L, poly, kind, name in derived:
            for x, y, lv_, given in self.cfg.get('area_names', []):
                if lv_ == L and poly.distance(Point(x, y)) <= 6:
                    name = given
            for q in tidy(poly.intersection(self.extent.buffer(1)), 0.4):
                item = {'level': L, 'kind': kind, 'ring': ring_xy(q.exterior), 'derived': True}
                if q.interiors:
                    item['holes'] = [ring_xy(h) for h in q.interiors]
                if name:
                    item['name'] = name
                model['areas'].append(item)
                count[L] += 1
        if count:
            self.note('floors derived from paths', ', '.join(f'level {l}: {n}' for l, n in sorted(count.items())))

        # -- sectors, sector spans and station furniture (SBB open data)
        plats = [a for a in self.areas if a['kind'] == 'platform' and a.get('keys')]
        sbb = ['data.sbb.ch']
        sectors = self.data('sectors.json', sbb)
        if sectors:
            out, moved, lost = [], 0, []
            for sc in sectors:
                pt = Point(sc['xy'])
                near = [(a['poly'].distance(pt), a) for a in plats if key_of(sc['ref']) in a['keys']]
                item = {'ref': sc['ref'], 'name': sc['name'], 'xy': [round(v, 2) for v in sc['xy']]}
                if not near:
                    lost.append(f'{sc["ref"]}{sc["name"]}')
                    continue
                d, a = min(near, key=lambda n: n[0])
                if d > 0.5:      # off its platform in the model: onto the nearest point of it
                    inner = a['poly'].buffer(-0.8)
                    q = nearest_points(inner if not inner.is_empty else a['poly'], pt)[0]
                    item['xy'] = [round(q.x, 2), round(q.y, 2)]
                    moved += 1
                    if d > 15:
                        lost.append(f'{sc["ref"]}{sc["name"]} ({d:.0f} m off the platform polygon, snapped to its end)')
                nodes = live(a)
                if nodes:
                    i = min(nodes, key=lambda i: dist(N[i], item['xy']))
                    if dist(N[i], item['xy']) <= 20:
                        item['node'] = i
                out.append(item)
            model['sectors'] = out
            order = defaultdict(list)
            for item in out:
                order[item['ref']].append(item)
            wrong = [ref for ref, items in order.items()
                     if [i['name'] for i in sorted(items, key=lambda i: -i['xy'][0])]
                     != sorted(i['name'] for i in items)]
            self.note('layers', f'sectors: {len(out)} of {len(sectors)}, {moved} moved onto their platform; letters run '
                                f'from A in the east westwards on {len(order) - len(wrong)} of {len(order)} tracks'
                      + (f' (not on {", ".join(wrong)})' if wrong else '')
                      + (f'; problems: {"; ".join(lost)}' if lost else ''))
        spans = self.data('spans.json', sbb)
        if spans:
            model['sectorSpans'] = [{'ref': ref, 'name': sp['name'], 'a': [round(v, 2) for v in sp['a']],
                                     'b': [round(v, 2) for v in sp['b']]}
                                    for ref, track in spans.items() for sp in track['sectors']]
            # on a curved platform the straight line from a to b leaves the edge: the kerb between them, when known
            kerbs = self.data('platform_edges.geojson', sbb)
            lines = {key_of(f['properties']['ref']): LineString([self.xy(c[0], c[1]) for c in f['geometry']['coordinates']])
                     for f in (kerbs or {}).get('features', [])}
            bent = 0
            for sp in model['sectorSpans']:
                kerb = lines.get(key_of(sp['ref']))
                if kerb is None or max(kerb.distance(Point(sp['a'])), kerb.distance(Point(sp['b']))) > 3:
                    continue
                d0, d1 = sorted((kerb.project(Point(sp['a'])), kerb.project(Point(sp['b']))))
                part = shapely.ops.substring(kerb, d0, d1).simplify(0.3)
                if part.geom_type == 'LineString' and len(part.coords) > 2:
                    pts = [[round(x, 2), round(y, 2)] for x, y in part.coords]
                    sp['line'] = pts if dist(pts[0], sp['a']) <= dist(pts[-1], sp['a']) else pts[::-1]
                    bent += 1
            self.note('layers', f'sector spans: {len(model["sectorSpans"])}, {bent} of them with the kerb line between '
                                f'their ends (curved platform)')
        props = []
        # the level of the train platforms (0 at most stations; Genève: 2), per track and the most common one
        track_level = {key_of(s['ref']): s['level'] for s in model['stops'] if s['mode'] == 'train' and s.get('ref')}
        levels_seen = list(track_level.values())
        # the level most train platforms are on (a tie: the one nearest 0, then the lower; not set order)
        main = max(set(levels_seen), key=lambda l: (levels_seen.count(l), -abs(l), -l)) if levels_seen else 0
        boards = self.data('boards.json', sbb)
        for b in boards or []:
            front, back = (b.get('front') or '').strip('- '), (b.get('back') or '').strip('- ')
            name = '|'.join(dict.fromkeys(x for x in (front, back) if x))
            item = {'kind': 'sector-sign', 'xy': [round(v, 1) for v in b['xy']],
                    'level': track_level.get(key_of(b.get('ref') or ''), main),
                    'mount': 'hang' if b.get('hanging') else 'stand'}
            if b.get('ref'):
                item['ref'] = b['ref']
            if name:
                item['name'] = name
            track = (spans or {}).get(b.get('ref') or '', {}).get('sectors', [])
            if track:      # facing along the platform: bearing of the platform edge there (0 = north, clockwise)
                sp = min(track, key=lambda sp: LineString([sp['a'], sp['b']]).distance(Point(b['xy'])))
                item['heading'] = round(math.degrees(math.atan2(sp['b'][0] - sp['a'][0], sp['b'][1] - sp['a'][1])) % 360)
            props.append(item)
        furniture = self.data('furniture.json', sbb)
        walk = [(Polygon(a['ring'], a.get('holes')), a['level'], a['kind']) for a in model['areas'] if a['kind'] != 'room']
        dropped = 0
        levels_here = {l['id'] for l in model['levels']}
        unmodelled = doubted = 0
        for f in furniture or []:
            pt = Point(f['xy'])
            on = [l for poly, l, k in walk if k == 'platform' and l == main and poly.covers(pt)]
            near = sorted((poly.distance(pt), abs(l), l) for poly, l, k in walk)
            given = f.get('level')
            section = f.get('level_from') == 'sbb_section'
            # hung from a roof or a catenary mast: out in the open, whatever SBB's section says
            hung = section and (f.get('mounting') or '').startswith(('BA-Dach', 'FS-'))
            if given is not None and not section:
                if given not in levels_here:   # set by hand for a floor this model does not have: not put on 0
                    unmodelled += 1
                    continue
                level = given   # set by hand in the file: trusted
            elif given is not None and not hung and given in levels_here \
                    and min((poly.distance(pt) for poly, l, k in walk if l == given), default=1e9) <= 15:
                level = given   # SBB's section, and the model has somewhere to stand on that floor there
            elif hung and any(d <= 15 for d, _, _ in near):
                level = max(l for d, _, l in near if d <= 15)   # the highest floor walkable there
            elif on:
                level = main
            elif near and near[0][0] <= 15:
                level = near[0][2]
            else:
                dropped += 1
                continue
            if section and given is not None and level != given:
                doubted += 1
            props.append({'kind': f['kind'].replace('_', '-'), 'xy': [round(v, 1) for v in f['xy']], 'level': level})
        for poi in model['pois']:
            if poi['kind'] == 'meeting-point':
                props.append({'kind': 'meeting-point', 'xy': [round(v, 1) for v in poi['xy']], 'level': poi['level'],
                              'name': poi['name']})
        if props:
            model['props'] = props
            kinds = defaultdict(int)
            for item in props:
                kinds[item['kind']] += 1
            self.note('layers', 'props: ' + ', '.join(f'{n} {k}' for k, n in sorted(kinds.items()))
                      + (f'; {dropped} pieces of furniture not near any walkable area, left out' if dropped else '')
                      + (f'; {doubted} not on the floor of their SBB section (placed by the model)' if doubted else '')
                      + (f'; {unmodelled} on a floor the model does not have, left out' if unmodelled else ''))

        # -- real roofs and walls of the key structures (swissBUILDINGS3D) instead of the OSM prisms under them
        mesh = self.data('shell_mesh.json', ['© swisstopo'])
        if mesh:
            floor = self.cfg.get('mesh_floor', -1.0)
            out, cover = [], []
            for st in mesh['structures']:
                v, tri = st['verts'], st['tris']
                keep = [k for k in range(0, len(tri), 3)
                        if max(v[3 * tri[k] + 2], v[3 * tri[k + 1] + 2], v[3 * tri[k + 2] + 2]) > floor]
                index, pos, idx = {}, [], []
                for k in keep:
                    for j in tri[k:k + 3]:
                        if j not in index:
                            index[j] = len(index)
                            pos += [round(v[3 * j], 2), round(v[3 * j + 1], 2), round(max(v[3 * j + 2], floor), 2)]
                        idx.append(index[j])
                    cover.append(Polygon([(v[3 * j], v[3 * j + 1]) for j in tri[k:k + 3]]))
                out.append({'name': st['name'], 'kind': st['kind'], 'positions': pos, 'indices': idx})
            model['shellMesh'] = out
            under = unary_union([c for c in cover if c.is_valid and c.area > 0.01]).buffer(0.5)
            before = len(model['shell'])
            model['shell'] = [sh for sh in model['shell'] if sh['kind'] == 'deck'
                              or Polygon(sh['ring']).buffer(0).intersection(under).area
                              < 0.5 * max(Polygon(sh['ring']).buffer(0).area, 0.1)]
            self.note('layers', f'shellMesh: {len(out)} structures, {sum(len(o["indices"]) for o in out) // 3} '
                                f'triangles (clipped at {floor:g} m); {before - len(model["shell"])} OSM prisms under '
                                f'them left out, {len(model["shell"])} kept')

        # -- heights of the buildings around from swissBUILDINGS3D, where the same building is in both
        prisms = self.data('shell.geojson', ['© swisstopo'])
        if prisms:
            n = 0
            for f in prisms['features']:
                geo = f['geometry']
                rings = [geo['coordinates']] if geo['type'] == 'Polygon' else geo['coordinates']
                theirs = unary_union([q for r in rings for q in clean_polys(Polygon([self.xy(c[0], c[1]) for c in r[0]]))])
                top, base = f['properties'].get('top'), f['properties'].get('base')
                if theirs.is_empty or top is None or base is None or top <= base:
                    continue
                for sh in model['shell']:
                    if sh['kind'] != 'building':
                        continue
                    ours = Polygon(sh['ring']).buffer(0)
                    if ours.intersection(theirs).area >= 0.6 * max(ours.area, 0.1) or \
                            ours.intersection(theirs).area >= 0.6 * theirs.area:
                        sh['base'], sh['top'] = round(max(base, -1.0), 1), round(top, 1)
                        n += 1
            self.note('layers', f'heights of {n} shell buildings taken from swissBUILDINGS3D (shell.geojson)')

        # -- checks: every stair / escalator / ramp / lift edge is drawn and the other way round; built ramps
        drawn = {c.get('_way') for c in model['connectors']} - {None}
        lifts = {(round(c['xy'][0], 1), round(c['xy'][1], 1)) for c in model['connectors'] if c['kind'] == 'elevator'}
        ways = defaultdict(list)
        for e, o in zip(self.edges, E):
            if o['kind'] == 'elevator':
                if (round(N[o['a']][0], 1), round(N[o['a']][1], 1)) not in lifts:
                    self.note('edges without a drawn connector', f'lift at {N[o["a"]][:2]}')
            elif o['kind'] != 'walk':
                ways[e.get('way')].append(o)
        for wid, es in ways.items():
            if wid not in drawn:
                a = N[es[0]['a']]
                self.note('edges without a drawn connector',
                          f'{es[0]["kind"]} way {wid} at ({a[0]:.0f}, {a[1]:.0f}), levels '
                          f'{min(min(N[o["a"]][2], N[o["b"]][2]) for o in es):g} to '
                          f'{max(max(N[o["a"]][2], N[o["b"]][2]) for o in es):g}, {sum(o["len"] for o in es):.0f} m'
                          + (' (leaves the model)' if wid in self.walk and not all(
                              self.extent.covers(Point(q)) for q in self.walk[wid]['pts']) else ''))
        for c in model['connectors']:
            if c['kind'] != 'elevator' and c.get('_way') not in ways:
                self.note('drawn connectors without an edge', f'{c["kind"]} way {c.get("_way")}')
            if c['kind'] == 'ramp':
                length = line_len(c['line'])
                rise = abs(self.z_of(c['line'][0][2]) - self.z_of(c['line'][-1][2]))
                self.note('built ramps (length along the path, rise, slope)',
                          f'way {c.get("_way")} at ({c["line"][0][0]:.0f}, {c["line"][0][1]:.0f}), levels '
                          f'{c["line"][0][2]:g} to {c["line"][-1][2]:g}: {length:.0f} m, {rise:.1f} m, '
                          f'{100 * rise / max(length, 0.3):.1f} %')
        for c in model['connectors']:
            c.pop('_way', None), c.pop('_hub', None)
        model['attribution'] = ['© OpenStreetMap contributors', 'opentransportdata.swiss'] + self.credits

    def validate(self, model):
        g = model['graph']
        n = len(g['nodes'])
        adj = [[] for _ in range(n)]      # (to, kind) following oneway
        und = [[] for _ in range(n)]
        for e in g['edges']:
            adj[e['a']].append((e['b'], e))
            und[e['a']].append(e['b'])
            und[e['b']].append(e['a'])
            if not e.get('oneway'):
                adj[e['b']].append((e['a'], e))

        def reach(src, ok=lambda e: True, graph=None):
            seen = {src}
            stack = [src]
            while stack:
                u = stack.pop()
                for v, e in (graph or adj)[u]:
                    if v not in seen and ok(e):
                        seen.add(v)
                        stack.append(v)
            return seen

        rev = [[] for _ in range(n)]
        for e in g['edges']:
            rev[e['b']].append((e['a'], e))
            if not e.get('oneway'):
                rev[e['a']].append((e['b'], e))
        ends = [s['node'] for s in model['stops']] + [e['node'] for e in model['entrances']]
        src = model['entrances'][0]['node'] if model['entrances'] else (ends[0] if ends else 0)
        fwd, back = reach(src), reach(src, graph=rev)
        bad = [i for i in ends if i not in fwd or i not in back]
        out = []
        out.append(f'connected: {len(ends) - len(bad)} of {len(ends)} stops and entrances reach each other '
                   f'(both ways, respecting one-way escalators)' + (f'; NOT connected: nodes {bad}' if bad else ''))
        step_free = reach(src, lambda e: e['kind'] not in ('stairs', 'escalator') and e.get('wheelchair') is not False)
        no_stairs = reach(src, lambda e: e['kind'] != 'stairs')
        missing = [s for s in model['stops'] if s['node'] not in step_free]
        out.append(f'step-free from "{model["entrances"][0]["name"] if model["entrances"] else "first stop"}" '
                   f'(no stairs, no escalators, no wheelchair=no): {len(model["stops"]) - len(missing)} of '
                   f'{len(model["stops"])} stops')
        for s in missing:
            out.append(f'    not step-free: {s["name"]} {s["ref"] or "(no ref)"} [{s["uic"]}] level {s["level"]}'
                       + ('' if s['node'] in no_stairs else ' (stairs only, not even an escalator)'))
        per = defaultdict(lambda: defaultdict(int))
        for x, y, l in g['nodes']:
            per[math.floor(l + 0.5) if float(l).is_integer() else 'between']['nodes'] += 1
        for a in model['areas']:
            per[a['level']][a['kind']] += 1
        for s in model['stops']:
            per[s['level'] if float(s['level']).is_integer() else 'between']['stops'] += 1
        for c in model['connectors']:
            if c['kind'] == 'elevator':
                for l in c['levels']:
                    per[l]['lifts'] += 1
        out.append('per level:')
        for l in [lv['id'] for lv in model['levels']] + ['between']:
            if l in per:
                name = next((lv['name'] for lv in model['levels'] if lv['id'] == l), 'on stairs, ramps and slopes')
                out.append(f'    {str(l):>7}  {name}: ' + ', '.join(f'{v} {k}' for k, v in sorted(per[l].items())))
        kinds = defaultdict(int)
        for e in g['edges']:
            kinds[e['kind']] += 1
            la, lb = g['nodes'][e['a']][2], g['nodes'][e['b']][2]
            if e['kind'] == 'walk' and la != lb and (not e.get('outdoor') or (float(la).is_integer()
                                                                               and float(lb).is_integer())):
                out.append(f'    BUG: walk edge between levels {e}')
        out.append('edges: ' + ', '.join(f'{v} {k}' for k, v in sorted(kinds.items())))
        # what leads off each numbered platform (walking on the platform only)
        out.append('ways off the train platforms:')
        for a in sorted((a for a in self.areas if a['kind'] == 'platform' and a.get('nodes')
                         and any(r.isdigit() for r in a['refs'])), key=lambda a: int(a['refs'][0])):
            zone = prep(a['poly'].buffer(4))
            start = [self.remap[i] for i in a['nodes'] if i in self.remap]
            seen, stack, off = set(start), list(start), defaultdict(int)
            while stack:
                u = stack.pop()
                for v, e in adj[u]:
                    if e['kind'] == 'walk':
                        if v not in seen and zone.covers(Point(g['nodes'][v][:2])):
                            seen.add(v)
                            stack.append(v)
                    elif e['a'] == u or not e.get('oneway'):
                        lu, lv_ = g['nodes'][u][2], g['nodes'][v][2]
                        if e['kind'] == 'elevator':
                            off['lift'] += 1
                        else:
                            off[f'{e["kind"]} {"up" if lv_ > lu else "down"}'] += 1
            out.append(f'    {"/".join(a["refs"]):>6} (level {a["level"]:g}): '
                       + (', '.join(f'{v} {k}' for k, v in sorted(off.items()))
                          or 'only a walk link (the stairs and ramps are further than 4 m from the platform)'))
        ck = defaultdict(int)
        for c in model['connectors']:
            ck[c['kind']] += 1
        out.append('connectors: ' + ', '.join(f'{v} {k}' for k, v in sorted(ck.items())))
        # dead ends of indoor paths that are not a door, a stop or a lift
        special = set(ends)
        dead = 0
        for i in range(n):
            if len(set(und[i])) == 1 and i not in special and self.gmeta[i].get('lift') is None:
                m = self.gmeta[i]
                node = self.nodes.get(m.get('osm'), {}).get('tags', {})
                if g['nodes'][i][2] != 0 and not ('entrance' in node or 'door' in node or 'amenity' in node):
                    dead += 1
                    if dead <= 25:
                        self.note('dead ends off level 0', f'({g["nodes"][i][0]:.0f}, {g["nodes"][i][1]:.0f}) level '
                                                           f'{g["nodes"][i][2]}' + (f' node {m["osm"]}' if m.get('osm') else ''))
        for a in self.areas:
            if a['kind'] == 'platform' and a['poly'].intersects(self.extent) and a.get('nodes'):
                if not any(i in self.remap for i in a['nodes']):
                    self.note('platforms without access', f'{",".join(a["refs"]) or a["name"]} ({a["src"][0]}) level '
                                                          f'{a["level"]:g}')
        return out

    def run(self):
        t0 = time.time()
        self.read()
        self.collect()
        self.match_stops()
        self.solve_levels()
        if self.repair_crossings():
            self.solve_levels()
        self.name_areas()
        self.build_graph()
        self.add_links()
        self.place_stops()
        self.mesh_areas()
        self.finish_lifts()
        self.connect()
        self.add_entrances()
        self.prune()
        self.add_pois()
        self.add_tracks()
        self.add_shell()
        model = self.model()
        self.enrich(model)
        report = self.validate(model)
        self.seconds = time.time() - t0
        return model, report

def write_js(path, head, obj):
    with open(path, 'w', encoding='utf-8', newline='\n') as f:
        f.write(head)
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';\n')


def main():
    ap = argparse.ArgumentParser(description='Build the 3D station models in stations3d/.')
    ap.add_argument('keys', nargs='*', help='stations to build (default: all): ' + ', '.join(STATIONS))
    ap.add_argument('--refresh', action='store_true', help='download OpenStreetMap again')
    ap.add_argument('--osm', help='use this Overpass JSON file (only with one station)')
    ap.add_argument('--verbose', action='store_true', help='print every finding instead of the first 12 per kind')
    ap.add_argument('--data', default=DATA_DIR, help='folder with the open-data layers per station (default: '
                                                     'tools/station3d_data); a station without layers is built from '
                                                     'OpenStreetMap and ATLAS alone')
    args = ap.parse_args()
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass
    keys = args.keys or list(STATIONS)
    for k in keys:
        if k not in STATIONS:
            raise SystemExit(f'unknown station {k!r}; known: {", ".join(STATIONS)}')
    platforms = load_platforms()
    os.makedirs(OUT_DIR, exist_ok=True)
    for key in keys:
        cfg = STATIONS[key]
        osm = fetch_osm(key, cfg, args.refresh, args.osm)
        b = Builder(key, cfg, osm, platforms, args.data)
        model, report = b.run()
        out = os.path.join(OUT_DIR, f'{key}.js')
        write_js(out, f'// Generated by tools/build_station3d.py. Sources: OpenStreetMap ({b.osm_date}), '
                      f'opentransportdata.swiss ATLAS ({platforms.get("date", "")}). Format: stations3d/SCHEMA.md\n'
                      f'(window.STATION3D = window.STATION3D || {{}})[{json.dumps(key)}] = ', model)
        size = os.path.getsize(out)
        log(f'\n== {key}: {cfg["name"]} ==')
        log(f'{len(model["levels"])} levels, {len(model["areas"])} areas, {len(model["tracks"])} tracks, '
            f'{len(model["connectors"])} connectors, {len(model["shell"])} shell pieces, {len(model["stops"])} stops, '
            f'{len(model["entrances"])} entrances, {len(model["pois"])} pois, {len(model["graph"]["nodes"])} nodes, '
            f'{len(model["graph"]["edges"])} edges')
        for line in report:
            log(line)
        for section, items in b.notes.items():
            log(f'-- {section} ({len(items)})')
            for item in items if args.verbose else items[:12]:
                log('    ' + item)
            if not args.verbose and len(items) > 12:
                log(f'    ... {len(items) - 12} more (--verbose)')
        log(f'{out}: {size / 1024:.0f} KB' + ('  ** over the 1.5 MB budget **' if size > 1.5e6 else '')
            + f', {b.seconds:.1f} s')

    # index.js: every stop id of every station that has a model file
    index = {}
    for key, cfg in STATIONS.items():
        path = os.path.join(OUT_DIR, f'{key}.js')
        if not os.path.exists(path):
            continue
        text = open(path, encoding='utf-8').read()
        m = re.search(r'"uics":(\[[^\]]*\])', text)
        for uic in json.loads(m.group(1)) if m else cfg['uics']:
            index[uic] = key
    write_js(os.path.join(OUT_DIR, 'index.js'),
             '// Generated by tools/build_station3d.py: stop id -> station model (stations3d/<key>.js).\n'
             'window.STATION3D_INDEX = ', index)
    log(f'{os.path.join(OUT_DIR, "index.js")}: {len(index)} stop ids')


if __name__ == '__main__':
    main()
