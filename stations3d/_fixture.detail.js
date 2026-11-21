// A made-up street in the format of DETAIL.md, for tests and development. Not a real place.
// 40 m of a tree-lined promenade between a tram road (south) and a cobbled lane (north), rising 2 % to the east.
// Written in street coordinates (s along the street, t across it, north side positive) and turned to bearing 70°,
// so nothing is aligned with the axes. Every object kind and every optional field of the format appears once.
(function () {
  const BEARING = 70, h = BEARING * Math.PI / 180, ax = Math.sin(h), ay = Math.cos(h);
  const r2 = (v) => Math.round(v * 100) / 100;
  const P = (s, t) => [r2(s * ax - t * ay), r2(s * ay + t * ax)];
  const Z = (s, lift) => r2(0.02 * s + (lift || 0));        // the street rises to the east
  const ALONG = BEARING, NORTH = (BEARING + 270) % 360, SOUTH = (BEARING + 90) % 360, WEST = (BEARING + 180) % 360;
  const UP = 0.12;                                           // pavements lie one kerb above the roads
  const band = (kind, s0, s1, t0, t1, lift, extra) => Object.assign({
    kind, ring: [P(s0, t0), P(s1, t0), P(s1, t1), P(s0, t1)], zs: [Z(s0, lift), Z(s1, lift), Z(s1, lift), Z(s0, lift)],
  }, extra);
  const line = (pts) => pts.map((q) => P(q[0], q[1]));
  const box = (s0, s1, t0, t1) => [P(s0, t0), P(s1, t0), P(s1, t1), P(s0, t1)];
  const round = (s, t, r, n) => { const o = []; for (let i = 0; i < n; i++) o.push(P(s + Math.cos(i / n * 2 * Math.PI) * r, t + Math.sin(i / n * 2 * Math.PI) * r)); return o; };

  const rowA = [3, 10, 17, 24, 31, 38], rowB = [3, 10, 17, 24, 31, 38], TA = -1.4, TB = 4.4;

  const surfaces = [
    band('asphalt', -4, 44, -7.5, -2.5, 0, { source: 'estimate' }),
    band('tram-track', -4, 44, -6.6, -4.0, 0),
    band('crossing', 17, 21, -7.5, -2.5, 0),
    band('paving', -4, 44, -10, -7.5, UP),
    band('paving', -4, 44, -2.5, 5.5, UP),
    band('gravel', -4, 44, 0, 3, UP),
    ...rowA.map((s) => band('soil', s - 0.75, s + 0.75, TA - 0.75, TA + 0.75, UP)),
    ...rowB.map((s) => band('soil', s - 0.75, s + 0.75, TB - 0.75, TB + 0.75, UP)),
    // the lane, with the open town stream running in a channel through it
    Object.assign(band('cobble', -4, 44, 5.5, 9, 0), { holes: [box(2, 38, 6.95, 7.35)] }),
    band('water', 2, 38, 6.95, 7.35, -0.09),
    band('paving', -4, 44, 9, 11.5, UP),
    // a front garden: lawn with a round bed in it
    Object.assign(band('grass', 22, 36, 11.5, 14, UP), { holes: [round(33, 12.75, 0.8, 10)] }),
    { kind: 'soil', ring: round(33, 12.75, 0.8, 10), z: Z(33, UP) },
    band('paving', 28, 30, 11.5, 12.9, UP),
  ];

  const edges = [
    { kind: 'kerb', line: line([[-4, -7.5], [20, -7.5], [44, -7.5]]), height: 0.12, width: 0.15, source: 'estimate' },
    { kind: 'kerb', line: line([[-4, -2.5], [44, -2.5]]) },
    { kind: 'kerb', line: line([[-4, 5.5], [2, 5.5]]) },
    { kind: 'wall', line: line([[2, 5.5], [15, 5.5]]), height: 0.57, width: 0.4 },        // a low wall to sit on
    { kind: 'kerb', line: line([[15, 5.5], [44, 5.5]]) },
    { kind: 'kerb', line: line([[-4, 9], [44, 9]]), z: Z(20, 0), height: 0.12 },
    // a raised border around one tree bed
    { kind: 'ledge', line: box(24 - 0.95, 24 + 0.95, TB - 0.95, TB + 0.95), closed: true, height: 0.16, width: 0.2 },
    // the front garden: fence to the pavement with a gap for the path, a hedge on one side
    { kind: 'fence', line: line([[22, 14], [22, 11.6], [27.7, 11.6]]), height: 1.0 },
    { kind: 'fence', line: line([[30.3, 11.6], [36, 11.6], [36, 14]]), height: 1.0, variant: 'wood' },
    { kind: 'hedge', line: line([[22.7, 12.1], [22.7, 13.8]]), height: 1.3, width: 0.8 },
    { kind: 'steps', line: line([[28.1, 12.9], [29.9, 12.9]]), z: Z(29, UP), height: 0.5, width: 1.1, side: 'left' },
    { kind: 'railing', line: line([[28.0, 12.8], [28.0, 14.0]]), height: 0.95 },
    { kind: 'railing', line: line([[30.0, 12.8], [30.0, 14.0]]), height: 0.95 },
  ];

  const chestnut = (s, t, i, extra) => Object.assign({
    xy: P(s, t), z: Z(s, UP), height: 13 + (i % 3) * 0.9, crown: 4.1 + (i % 2) * 0.5, trunk: 0.28 + (i % 3) * 0.03,
    crownBase: 3.4 + (i % 2) * 0.3, kind: 'broadleaf', species: 'Aesculus hippocastanum', leaves: true, source: 'estimate',
  }, extra);
  const trees = [
    ...rowA.map((s, i) => chestnut(s, TA, i)),
    ...rowB.map((s, i) => chestnut(s, TB, i + 1, i === 1 ? { species: 'Tilia cordata' } : i === 4 ? { leaves: false } : null)),
    { xy: P(24.2, 12.9), height: 9, crown: 1.2, kind: 'columnar', species: 'Carpinus betulus' },
    { xy: P(34.6, 13.0), z: Z(34.6, UP), height: 7, crown: 1.9, crownBase: 0.9, kind: 'conifer', species: 'Picea abies' },
    { xy: P(41.5, 10.2) },                                   // nothing known but the place
  ];
  trees[5] = { xy: P(38, TA), z: Z(38, UP), height: 6, crown: 1.8, trunk: 0.09, kind: 'broadleaf', species: 'Acer campestre' }; // a young one

  const props = [
    { kind: 'bench', xy: P(6.5, TB), heading: SOUTH, length: 1.8, width: 0.5 },
    { kind: 'bench', xy: P(13.5, TB), z: Z(13.5, UP), heading: SOUTH, length: 2.2, height: 0.86, variant: 'backrest' },
    { kind: 'bench', xy: P(27.5, TB), heading: SOUTH },
    { kind: 'bench', xy: P(34.5, TB), heading: SOUTH },
    { kind: 'bench', xy: P(13.5, -0.5), heading: NORTH, variant: 'backless', length: 1.6 },
    { kind: 'bench', xy: P(6.5, -0.5), heading: NORTH, variant: 'stone', length: 2.0 },

    { kind: 'lamp', xy: P(7, -2.1), z: Z(7, UP), heading: NORTH, height: 4.5 },
    { kind: 'lamp', xy: P(21, -2.1), heading: NORTH, height: 5, variant: 'double' },
    { kind: 'lamp', xy: P(35, -2.1), heading: NORTH },
    { kind: 'lamp', xy: P(12, 7.25), heading: ALONG, height: 6.5, length: 9, variant: 'wire', name: 'hung across the lane' },
    { kind: 'lamp', xy: P(28, 7.25), heading: ALONG, height: 6.5, length: 9, variant: 'wire' },
    { kind: 'lamp', xy: P(20, 9.5), heading: SOUTH, variant: 'lantern' },
    { kind: 'lamp', xy: P(9, 11.48), heading: SOUTH, height: 3.4, variant: 'wall' },

    { kind: 'bollard', xy: P(16.6, -2.2), height: 0.9 },
    { kind: 'bollard', xy: P(21.4, -2.2) },
    { kind: 'bollard', xy: P(16.6, -7.8) },
    { kind: 'bollard', xy: P(21.4, -7.8) },
    { kind: 'bollard', xy: P(0.6, 6.1), variant: 'stone' },
    { kind: 'bollard', xy: P(0.6, 8.3), variant: 'stone', height: 0.75 },

    { kind: 'bin', xy: P(8.1, TB) },
    { kind: 'bin', xy: P(24.9, -1.9), heading: SOUTH, height: 0.95, width: 0.44 },
    { kind: 'bike-stand', xy: P(38.5, 10.3), heading: SOUTH, length: 3.0, variant: 'row' },
    { kind: 'bike-stand', xy: P(3.0, 10.2), heading: SOUTH },
    { kind: 'bike-stand', xy: P(4.0, 10.2), heading: SOUTH, height: 0.8 },
    { kind: 'fountain', xy: P(20.5, 4.2), z: Z(20.5, UP), heading: SOUTH, height: 3.4, width: 2.6, variant: 'figure', name: 'Fixturebrunnen' },
    { kind: 'fountain', xy: P(40.5, 6.6), heading: SOUTH, length: 2.6, width: 1.0, variant: 'trough' },
    { kind: 'planter', xy: P(0.6, 3.9), heading: ALONG, length: 1.8, width: 0.7, height: 0.55 },
    { kind: 'planter', xy: P(5.2, 11.0), variant: 'round', length: 0.9, height: 0.6 },
    { kind: 'planter', xy: P(12.4, 11.0), variant: 'round', length: 0.9 },
    { kind: 'hydrant', xy: P(15.6, 9.45), heading: SOUTH },
    { kind: 'sign-post', xy: P(16.3, -2.1), heading: WEST, variant: 'crossing' },
    { kind: 'sign-post', xy: P(21.7, -7.9), heading: ALONG, variant: 'crossing', height: 2.7 },
    { kind: 'sign-post', xy: P(1.0, 9.4), heading: SOUTH, variant: 'street-name', name: 'Fixturegasse' },
    { kind: 'sign-post', xy: P(25.4, -2.15), heading: SOUTH, variant: 'tram-stop' },
    { kind: 'sign-post', xy: P(41.0, 5.9), heading: WEST },
    { kind: 'sign-post', xy: P(-1.5, -7.9), heading: WEST, variant: 'triangle' },
    { kind: 'pole', xy: P(10, -8.0), heading: NORTH, height: 7.5, length: 3.0, variant: 'catenary' },
    { kind: 'pole', xy: P(33, -8.0), heading: NORTH, height: 7.5, length: 3.0, variant: 'catenary' },
    { kind: 'pole', xy: P(19.2, 11.0), heading: ALONG, height: 6, variant: 'flag' },
    { kind: 'shelter', xy: P(27.5, -1.55), heading: SOUTH, length: 4, width: 1.5, height: 2.5, name: 'Fixtureplatz' },
    { kind: 'clock', xy: P(23.2, -2.0), heading: ALONG, height: 3.8 },
    { kind: 'statue', xy: P(39.6, 1.5), z: Z(39.6, UP), heading: WEST, height: 4.6, length: 1.6, width: 1.6, name: 'The Unknown Surveyor' },
    { kind: 'statue', xy: P(-2.2, 1.5), heading: ALONG, height: 3.2, length: 1.0, variant: 'obelisk' },
  ];

  // a small building given as a mesh: a shed roof falling to the street
  const mesh = (s0, s1, t0, t1, zb, zf, zr) => {
    const c = [P(s0, t0), P(s1, t0), P(s1, t1), P(s0, t1)], pos = [];
    for (const q of c) pos.push(q[0], q[1], zb);
    pos.push(c[0][0], c[0][1], zf, c[1][0], c[1][1], zf, c[2][0], c[2][1], zr, c[3][0], c[3][1], zr);
    return { positions: pos, indices: [0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7, 4, 5, 6, 4, 6, 7] };
  };

  const buildings = [
    { name: 'Haus zum Gable', ring: box(-3, 11, -20, -10), base: Z(4, UP), eaves: Z(4, UP) + 13.5, ridge: Z(4, UP) + 17.6, roof: 'gabled', ridgeDir: BEARING,
      floors: 4, groundFloor: 'arcade', color: '#d9d2c3', roofColor: '#8a6a55', shutters: '#8fa58c',
      faces: [{ a: P(-3, -10), b: P(11, -10), bays: 4, floors: 4, groundFloor: 'arcade', color: '#ddd5c4' }] },
    { name: 'Haus zum Mansard', ring: box(11, 26, -20, -10), base: Z(18, UP), eaves: Z(18, UP) + 16.5, ridge: Z(18, UP) + 21, roof: 'mansard', ridgeDir: BEARING,
      floors: 5, groundFloor: 'arcade', color: '#e3dccd', roofColor: '#7d7a78' },
    { name: 'Haus zum Hip', ring: box(26, 43, -20, -10), base: Z(34, UP), eaves: Z(34, UP) + 14, ridge: Z(34, UP) + 18.5, roof: 'hipped', ridgeDir: BEARING,
      floors: 4, groundFloor: 'arcade', arcade: 'pillars', color: '#dcd3c6',
      faces: [{ a: P(26, -10), b: P(43, -10), bays: 5 }] },
    { name: 'Kaufhaus', ring: box(-2, 18, 11.5, 21), base: Z(8, UP), eaves: Z(8, UP) + 19.5, roof: 'flat',
      floors: 6, groundFloor: 'shop', color: '#e8e4dc', faces: [{ a: P(18, 11.5), b: P(-2, 11.5), bays: 7 }] },
    { name: 'Pfarrhaus', ring: box(22, 36, 14, 23), base: Z(29, UP) + 0.5, eaves: Z(29, UP) + 10, ridge: Z(29, UP) + 14.5, roof: 'gabled', ridgeDir: (BEARING + 90) % 360,
      floors: 3, groundFloor: 'plain', color: '#e9dcc6', roofColor: '#a0624a' },
    { name: 'Remise', ring: box(37.5, 44, 11.6, 19), mesh: mesh(37.5, 44, 11.6, 19, Z(40, UP), Z(40, UP) + 6.2, Z(40, UP) + 8.4),
      floors: 2, color: '#d8cfc0', roofColor: '#8f7566', faces: [{ a: P(44, 11.6), b: P(37.5, 11.6), bays: 2, floors: 2, groundFloor: 'plain' }] },
  ];

  const path = [2, 7, 12, 17, 22, 27, 32, 37].map((s) => { const q = P(s, 1.5); return [q[0], q[1], Z(s, UP)]; });

  window.STATION3D_DETAIL = window.STATION3D_DETAIL || {};
  window.STATION3D_DETAIL._fixture = {
    key: '_fixture', name: 'Fixturegasse', built: '2026-11-21',
    attribution: ['made up for tests'],
    area: box(-4, 44, -20, 23),
    path, surfaces, edges, trees, props, buildings,
  };
})();
