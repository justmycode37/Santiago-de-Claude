// A small made-up station in the format of SCHEMA.md, for tests and development. Not a real place.
// Two island platforms (level 0), an underpass (level -1) from the station square, an overpass (level 1) at the east end.
(function () {
  const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

  const nodes = [
    [0, -34, 0],     //  0 station square, entrance
    [-20, -40, 0],   //  1 bus stop A
    [0, -30, 0],     //  2 top of the stairs to the underpass
    [0, -24, -1],    //  3 underpass, south end
    [0, -14, -1],    //  4 underpass below platform 3/4
    [0, 0, -1],      //  5 underpass, middle
    [0, 14, -1],     //  6 underpass below platform 1/2
    [10, -14, 0],    //  7 platform 3/4, top of the stairs
    [-3, -14, -1],   //  8 lift, underpass
    [-3, -14, 0],    //  9 lift, platform 3/4
    [10, 14, 0],     // 10 platform 1/2, top of the stairs
    [-15, 14, -0.5], // 11 ramp, halfway
    [-30, 14, 0],    // 12 platform 1/2, top of the ramp
    [-40, 14, 0],    // 13 platform 1/2, west
    [30, 14, 0],     // 14 platform 1/2, east
    [-40, -14, 0],   // 15 platform 3/4, west
    [30, -14, 0],    // 16 platform 3/4, east
    [44, 14, 1],     // 17 overpass above platform 1/2
    [44, -14, 1],    // 18 overpass above platform 3/4
    [50, 14, 0],     // 19 lift, platform 1/2
    [50, 14, 1],     // 20 lift, overpass
  ];
  const links = [
    [0, 1, 'walk'], [0, 2, 'walk'], [2, 3, 'stairs'], [3, 4, 'walk'], [4, 5, 'walk'], [5, 6, 'walk'],
    [4, 7, 'stairs'], [4, 8, 'walk'], [8, 9, 'elevator'],
    [6, 10, 'stairs'], [6, 11, 'ramp'], [11, 12, 'ramp'],
    [13, 12, 'walk'], [12, 10, 'walk'], [10, 14, 'walk'], [14, 19, 'walk'],
    [15, 9, 'walk'], [9, 7, 'walk'], [7, 16, 'walk'],
    [14, 17, 'escalator', true], [16, 18, 'stairs'], [17, 18, 'walk'], [19, 20, 'elevator'], [20, 17, 'walk'],
  ];
  const edges = links.map(([a, b, kind, oneway]) => {
    const len = kind === 'elevator' ? 0 : Math.round(Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]) * 100) / 100;
    const e = { a, b, kind, len };
    if (oneway) e.oneway = true;
    if (a < 3 && b < 3) e.outdoor = true;
    return e;
  });

  (window.STATION3D = window.STATION3D || {})._fixture = {
    key: '_fixture', name: 'Test station', built: '2026-11-21',
    attribution: ['made up'],
    origin: [7.4391, 46.9488],
    bbox: [-60, -50, 60, 24],
    uics: ['0000001', '0000002'],
    levels: [
      { id: -1, z: -5, name: 'Underpass' },
      { id: 0, z: 0, name: 'Platforms' },
      { id: 1, z: 6, name: 'Overpass' },
    ],
    areas: [
      { level: 0, kind: 'platform', ring: rect(-60, 10, 60, 18), refs: ['1', '2'] },
      { level: 0, kind: 'platform', ring: rect(-60, -18, 60, -10), refs: ['3', '4'] },
      { level: 0, kind: 'plaza', ring: rect(-40, -50, 40, -30), name: 'Station square' },
      { level: -1, kind: 'floor', ring: rect(-6, -30, 6, 30), name: 'Underpass' },
      { level: -1, kind: 'room', ring: rect(6, -4, 12, 4), name: 'Kiosk', height: 3 },
      { level: 1, kind: 'floor', ring: rect(40, -22, 54, 22), name: 'Overpass' },
    ],
    tracks: [
      { level: 0, line: [[-80, 22], [80, 22]], ref: '1' },
      { level: 0, line: [[-80, 6], [80, 6]], ref: '2' },
      { level: 0, line: [[-80, -6], [80, -6]], ref: '3' },
      { level: 0, line: [[-80, -22], [80, -22]], ref: '4' },
    ],
    connectors: [
      { kind: 'stairs', line: [[0, -30, 0], [0, -24, -1]], width: 4 },
      { kind: 'stairs', line: [[0, -14, -1], [10, -14, 0]], width: 2.4 },
      { kind: 'stairs', line: [[0, 14, -1], [10, 14, 0]], width: 2.4 },
      { kind: 'ramp', line: [[0, 14, -1], [-15, 14, -0.5], [-30, 14, 0]], width: 2.4 },
      { kind: 'escalator', line: [[30, 14, 0], [44, 14, 1]], width: 1.2, oneway: 'up' },
      { kind: 'stairs', line: [[30, -14, 0], [44, -14, 1]], width: 2.4 },
      { kind: 'elevator', xy: [-3, -14], levels: [-1, 0] },
      { kind: 'elevator', xy: [50, 14], levels: [0, 1] },
    ],
    shell: [
      { kind: 'building', ring: rect(-40, -30, 40, -22), base: 0, top: 12, name: 'Station building' },
      { kind: 'roof', ring: rect(-50, 9, 50, 19), base: 5, top: 5.4 },
      { kind: 'roof', ring: rect(-50, -19, 50, -9), base: 5, top: 5.4 },
    ],
    stops: [
      { uic: '0000001', ref: '1', mode: 'train', name: 'Test station', level: 0, xy: [10, 17], node: 10 },
      { uic: '0000001', ref: '2', mode: 'train', name: 'Test station', level: 0, xy: [10, 11], node: 10 },
      { uic: '0000001', ref: '3', mode: 'train', name: 'Test station', level: 0, xy: [10, -11], node: 7 },
      { uic: '0000001', ref: '4', mode: 'train', name: 'Test station', level: 0, xy: [10, -17], node: 7 },
      { uic: '0000002', ref: 'A', mode: 'bus', name: 'Test station, square', level: 0, xy: [-20, -40], node: 1 },
    ],
    sectors: [
      { ref: '1', name: 'A', xy: [-40, 17] }, { ref: '1', name: 'B', xy: [0, 17] }, { ref: '1', name: 'C', xy: [40, 17] },
    ],
    entrances: [{ name: 'Station square', level: 0, xy: [0, -34], node: 0 }],
    pois: [{ kind: 'tickets', name: 'Tickets', level: -1, xy: [3, -26] }],
    graph: { nodes, edges },
  };
})();
