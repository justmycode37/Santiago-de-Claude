/*
 * station3d-detail.js: draws a detail scene (stations3d/DETAIL.md) for the first-person view of station3d.js.
 * A short stretch of street with everything you would recognise on the spot: trees, benches, lamps, kerbs and
 * ledges, the houses at their real size. Classic script, no dependencies beyond the THREE module object that is
 * passed in, no network requests, no image files: geometry and canvas textures are made here.
 *
 * API
 *   const h = Station3DDetail.build(THREE, detail, opts)
 *     opts.theme     "light" (day) | "dark" (night: lamps and windows lit)            default "light"
 *     opts.quality   "high" | "low"   crown, branch, facade and texture detail         default "high"
 *     opts.season    "winter" | "summer"   all trees bare / all in leaf, whatever the data says. Default: the
 *                    data (tree.leaves)
 *     opts.pollard   true | false   draw all broadleaf trees pollarded / none. Default: the data (tree.form)
 *     opts.toScene   (x, y, z) => [X, Y, Z]   model metres (x east, y north, z up, relative to level 0) to scene
 *                    coordinates. Default: [x, z, -y] (the viewer is Y-up).
 *     opts.zShift    metres the whole scene is moved up (+) or down (-) before toScene; true: by detail.zOffset.
 *                    Default 0.
 *     opts.flatten   true: the slope of the street is taken out. The plane that fits the scene's ground best
 *                    (h.plane) is subtracted from every height before toScene: a shear, so what stands upright
 *                    stays upright and kerbs keep their steps, and the street lies level at height 0 (+ zShift),
 *                    like the floor of the station model. Use zShift: 0 with it (the plane already carries the
 *                    height of the street). Default false.
 *     opts.shadows   false: no cast shadows on the ground by day (soft round ones instead). Default true.
 *     opts.palette   { ground: "#…", wall: "#…", crown: "#…", … }   overrides single colours of PALETTE[theme]
 *     opts.sun       { azimuth: 228, elevation: 64 }   where the light comes from (compass bearing, degrees).
 *                    Default: the direction of the viewer's sun.
 *     opts.sky       true: add a sky dome to the group (the viewer has its own sky)
 *     opts.feather   metres the ground fades out over beyond detail.area: from opaque at the outline to nothing
 *                    (default 5; 0: a hard edge)
 *     opts.featherColor   "#…" the colour of that rim: give it the colour of the ground the scene lies in (the
 *                    viewer's THEME.ground / plaza), so the scene dissolves into it. Default: palette.ground.
 *     opts.featherInside  metres inside the outline over which the scene's own ground (road, pavement, shadows)
 *                    already takes on featherColor, fully at the outline. Default 0. For a soft hand-over use
 *                    e.g. { feather: 6, featherInside: 4, featherColor: THEME.ground }.
 *     opts.clearance metres of free height kept under crowns that reach over detail.path (default 2.7)
 *   returns a handle:
 *     h.group        THREE.Group to add to the scene. All positions are already in scene coordinates.
 *     h.stats        { triangles, drawCalls, vertices, textures, buildMs, timing, counts, parts, warnings }
 *     h.dispose()    removes the group from its parent and frees geometries, materials and textures
 *     h.groundAt(x, y)   same as Station3DDetail.groundAt(h, x, y)
 *     h.addVehicle({ kind: "tram", line: "9", path: [[x, y], …], length: 42 }) → vehicle
 *         A tram in the look of the scene (its own three draw calls, about 5,000 triangles) on the track centre line
 *         `path` (model coordinates, in driving direction). It stands on the ground of the scene, each of its
 *         sections on two points of the path, so it bends through curves. It is kept through update().
 *         vehicle.place(s)       the front at s metres along the path (it goes on straight beyond both ends)
 *         vehicle.run({ from, to, seconds, ease: "arrive" | "depart" | "linear" }) → Promise, resolved on arrival
 *         vehicle.doors(open)    the doors on the right side slide open or closed in 0.8 s
 *         vehicle.show(visible), vehicle.remove(), vehicle.length, vehicle.at, vehicle.stats
 *     h.tick(performance.now()) → true while something moved in this call (draw the frame); call it every frame
 *     h.tracks()         the centre lines of the scene's tram-track surfaces (pieces, either direction)
 *     h.zShift       the shift that was applied (a number)
 *     h.plane        { a, b, c }: the plane fitted to the street, z = c + a·x + b·y (model metres, before zShift).
 *                    Always there; h.flattened says whether it was taken out.
 *     h.parts        { ground: [Mesh…], cast: [Mesh…], decals, solid, buildings, crowns, glass, shadows, pools,
 *                    glows, feather, sky }: the meshes by role, so the viewer can fade or hide one
 *     h.lamps        [{ xy, z, height }]  where the lamps are (model coordinates, z in the frame of groundAt)
 *
 *   Station3DDetail.update(h, { theme, quality, season, pollard, zShift, flatten, shadows, palette, sun, feather… })
 *     Changes the look without a new handle: the contents of h.group are built again in place (0.1 to 0.4 s;
 *     colours and shading are baked into the vertices, so there is no cheaper way). h.stats is renewed.
 *   Station3DDetail.groundAt(h, x, y)  →  the height of what you stand on at this point, in the frame the scene is
 *     drawn in (model metres relative to level 0, plus zShift, minus the plane when flattened): the topmost
 *     detailed surface, kerb and low ledge tops, steps as a ramp, arcade floors. Where the data has no surface
 *     (under houses, beyond the surveyed ground) it answers with the level of the nearest street, never with
 *     something below it. null outside detail.area.
 *   Station3DDetail.sky(THREE, { theme, palette, radius })  →  a sky dome mesh (Y-up scene), for pages without one
 *   Station3DDetail.palette(theme)  →  a copy of the default colours
 *
 * How it draws
 *   Lighting is baked: every vertex gets its final colour here (sun side lighter, shaded side darker, lamps at
 *   night), and all materials are unlit MeshBasicMaterial. So the look does not depend on the lights of the scene,
 *   it is the cheapest thing a phone can draw, and the scene's fog and clipping planes still apply. Everything
 *   static is merged: one mesh for all props, edges and trunks, one for the buildings, one for the crowns, one per
 *   ground texture and layer, one each for ground markings, glass, soft shadows, light pools and lamp glows.
 *   By day the sun's shadows are one picture: every triangle that stands above the ground is laid down along the
 *   sun's direction into a canvas, and that canvas lies over the ground (one more mesh per ground layer).
 *
 * Data beyond DETAIL.md that is understood (all optional; anything else is ignored)
 *   detail.zOffset                   used by zShift: true
 *   detail.markings                  paint on the ground, drawn on top of the surfaces:
 *       { kind: "bike-symbol" | "arrow", xy: [x, y], heading: 15, size: 1.8, color: "#f2c200" }
 *           heading: the way the traffic it speaks to moves; size: its length along that way in metres
 *           (bike-symbol 1.8 and 0.6 of that wide, arrow 2.2)
 *       { kind: "lane-line" | "stop-line", line: [[x, y], …], width: 0.12, dash: [1.5, 1.5], color: "#…" }
 *           width in metres (stop-line 0.4); dash: [painted, gap] in metres, left out for a solid line
 *       { kind: "crossing", ring: [[x, y], …], heading: 15, color: "#…" }
 *           bars 0.5 m wide every metre; heading: the way people walk (default: the long axis of the ring)
 *       color: default the palette's marking yellow. z is never needed: markings lie on the ground below them.
 *       (surfaces[].kind "marking" with a field marking: "<kind>" and the same fields is read the same way.)
 *   surface.use, surface.color       asphalt: "road" is a darker cool grey, "pavement" / "island" a light warm
 *                                    one; on other kinds a colour shifts the tone a little
 *   surface.heading                  direction of the pattern (paving joints, cobble arcs) or, for a crossing, of walking
 *   surface.line, tracks, gauge      tram track: centre line [[x, y], …], number of tracks, gauge (default 1.0 m)
 *   edge.side                        "left" | "right": the side (seen along the line) steps climb to
 *   tree.form: "pollard…" | tree.pollarded: true     knuckles with one year's shoots instead of a crown
 *   tree.planted                     year: sets the trunk thickness when tree.trunk is missing
 *   prop.axis (when heading is missing), prop.capacity (bike stands), prop.mount (a sign strapped to the mast
 *   beside it), statue.plinthHeight / plinthColor / color, kind "ticket-machine"
 *   building.arcade: "arches" | "pillars", arcadeDepth, shutters: true | "#…", roofFloors (dormers on a mesh roof)
 *   face.heading                     the way the wall looks, for buildings without a ring
 *   face.windows: { bays: 7, floors: 5 }             the window grid as counted (floors includes the ground floor)
 *   face.bayWindows | face.oriels: 2                  that many stone bay windows, spread along the front, from the
 *       first upper floor to the one below the top; or a list
 *       [{ bay: 2 | at: 0.5, floors: [1, 3], width: 2.6, depth: 0.8 }]   bay: index from a (0 = first), at: place
 *       along a→b as a fraction; floors: first and last floor it covers (1 = the floor above the ground floor)
 *   face.balconies: 2                                 that many per floor on the main floors; or a count per upper
 *       floor [0, 2, 2, 1] (first entry = first upper floor); or a list [{ bay: 3 | at: 0.4, floor: 2, width: 2.4 }]
 *   face.awnings: true | false | { color: "#…" }      shop fronts: an awning over every window (in that colour) / none
 *   face.style: "townhouse"  (or building.style)      an old town house front: a lintel over every window and, on
 *       fronts of five bays or more, the middle bays standing 16 cm forward. Nothing of this without the field.
 *   Tram tracks get their contact wire 5.4 m up wherever a mast stands within 28 m (kind "mast", or a pole whose
 *       variant says tram, catenary or span). No masts in the data: no wire.
 *   prop kind "canopy": { ring: [[x, y], …], z, height: 9.5, rise: 3, columns: [[x, y], …] }   a glass roof on
 *       steel ribs and branching columns. ring: its outline; height: the underside of its edge above the ground;
 *       rise: how much higher its middle is; columns: where they stand (missing: every 12 m, 1.5 m inside the
 *       edge). No xy. The glass is see-through and shades the ground only faintly.
 *   lamp.wire: [[x, y, z], [x, y, z]]                 where the wire of a hanging lamp is fixed (else: the nearest
 *       house fronts on both sides); fountain variant "… temple …": an open round temple over the fountain
 *   detail.groundPlane: { origin: [x, y], z, dzdx, dzdy, nearWalk: { z, dzdx, dzdy } }   the plane of the street as
 *       measured; flatten uses nearWalk (else the plane itself) instead of its own fit, and h.plane.given says so
 *   Missing z: things stand on the detailed ground below them.
 *
 * Detail by distance (when the scene has a path): trees within 45 m of the walk and house fronts within 48 m are
 *   drawn in full; further away limbs, shoots, crowns and window frames are coarser, beyond 95 m simplest. The
 *   sun's shadow picture covers 45 m around the walk; beyond it shadows are soft round ones.
 */
(function () {
  'use strict';

  // ---------- types (the data and the API: src/types/station-detail.d.ts) ----------
  type V3 = [x: number, y: number, z: number];
  /** A point of a round bar: where it is and how thick. */
  type P4 = [x: number, y: number, z: number, radius: number];
  /** A point in the plan that may bring its own height. */
  type XYz = [x: number, y: number, z?: number];
  /** sRGB, 0..1 each. */
  type RGB = [r: number, g: number, b: number];
  type Box = [x0: number, y0: number, x1: number, y1: number];
  type Tri = [a: number, b: number, c: number];
  type Rng = () => number;
  type ToScene = (x: number, y: number, z: number) => V3;

  /** What paletteOf() makes of a palette: every colour as a triple. */
  type Pal = { [K in keyof Station3DDetailPalette]: Station3DDetailPalette[K] extends number ? number : Station3DDetailPalette[K] extends string[] ? RGB[] : RGB };
  type PalSrc = Record<string, string | number | string[]>;
  type PalOver = Record<string, Station3DDetailColor | Station3DDetailColor[] | number | undefined>;
  type GroundKind = 'asphalt' | 'paving' | 'cobble' | 'gravel' | 'grass' | 'soil' | 'water' | 'tram';

  /** A cleaned ring; keep[i] = the index its point i had in the ring that was given. */
  interface Ring extends Array<XY> { keep: number[] }
  interface BoxedRing extends Ring { box: Box }
  interface Axis { ux: number; uy: number; u0: number; u1: number; v0: number; v1: number; len: number; wid: number }
  /** A point of a line: p, the direction of travel t, the mitre l to its left. */
  interface Frame { p: XY; t: XY; l: XY }
  interface Step { p: XY; t: XY; s: number; corner: boolean; last?: boolean }

  /** [ax, ay, az, bx, by, bz, cx, cy, cz, twice the area in the plan, layer] */
  type GroundTri = [number, number, number, number, number, number, number, number, number, number, number];
  interface Ground {
    t: GroundTri[];
    grid: Map<number, number[]>;
    cell: number;
    add(a: V3, b: V3, c: V3, layer?: number): void;
    hit(x: number, y: number): { z: number; layer: number } | null;
    at(x: number, y: number): number | null;
  }
  interface Batch {
    p: number[];
    c: number[];
    i: number[];
    uv: number[] | null;
    n: number;
    alpha: boolean;
    vert(p: V3, c: RGB, a?: number): number;
  }
  interface GroundBatch extends Batch { uv: number[]; kind: GroundKind; layer: number }
  /** A triangle of the ground the sun's shadows fall on, and its layer (-1: the plain ground). */
  type CastTri = [a: V3, b: V3, c: V3, layer: number];
  /** z = c + a·x + b·y. given: the plane is the data's (detail.groundPlane), not our fit. */
  interface Plane { a: number; b: number; c: number; given?: boolean }
  /** The shadow picture: the canvas and the part of the plan (model metres) it covers. */
  interface Cast { canvas: HTMLCanvasElement; x0: number; y0: number; w: number; h: number; triangles: number }
  /** A corner of the plain ground: p where it is drawn, q what groundAt answers there, open: 1 where no surface lies over it. */
  interface PlatePt { p: V3; q: V3; open: number }
  // Ground, Batch and Writer are functions used with `new`
  type GroundNew = typeof Ground & (new () => Ground);
  type BatchNew = typeof Batch & (new (alpha?: boolean) => Batch);
  type WriterNew = typeof Writer & (new (batch: Batch, shade: Shade) => Writer);

  /** 1: glows by itself, 2: already shaded by the shape (see makeShade). */
  type Mode = 0 | 1 | 2;
  type Shade = (col: RGB, n: V3, p: V3, mode?: Mode) => RGB;
  /** The colour of a vertex: given, or worked out from its position and normal. */
  type Col = RGB | ((P: V3, n: V3) => RGB);
  /** … or one colour per corner of the face. */
  type Cols = Col | RGB[];
  interface FaceOpt { n?: V3; mode?: Mode; a?: number; two?: boolean }
  interface QuadOpt { n?: V3; mode?: Mode; a?: number | number[]; two?: boolean }
  interface BoxOpt { top?: RGB; mode?: Mode; bottom?: boolean; skip?: string }
  interface CylOpt { mode?: Mode; col1?: RGB; phase?: number; cap?: boolean; capCol?: RGB }
  interface TubeOpt { mode?: Mode; cap?: boolean; cols?: RGB[] }
  interface LatheOpt { mode?: Mode; phase?: number; facet?: boolean }
  type LathePt = [radius: number, height: number, colour?: RGB];
  interface Writer {
    b: Batch;
    shade: Shade;
    /** The local frame, null: model coordinates. */
    o: { x: number; y: number; z: number; c: number; s: number } | null;
    frame(x: number, y: number, z: number, heading?: number): Writer;
    world(): Writer;
    P(p: V3): V3;
    N(n: V3): V3;
    emit(P: V3, n: V3, col: Col, mode?: Mode, a?: number): number;
    tri(a: V3, b: V3, c: V3, col: Cols, opt?: FaceOpt): void;
    quad(a: V3, b: V3, c: V3, d: V3, col: Cols, opt?: QuadOpt): void;
    fan(pts: V3[], col: Col, opt?: FaceOpt): void;
    box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, col: RGB, opt?: BoxOpt): void;
    obox(c: V3, ax: V3, ay: V3, az: V3, col: RGB, opt?: BoxOpt): void;
    cyl(x: number, y: number, z0: number, z1: number, r0: number, r1: number, seg: number, col: RGB, opt?: CylOpt): void;
    tube(path: P4[], seg: number, col: RGB, opt?: TubeOpt): void;
    lathe(x: number, y: number, z: number, profile: LathePt[], seg: number, col: RGB, opt?: LatheOpt): void;
    lump(c: V3, rad: V3, f: number, amp: number, seed: number, col: (P: V3, n: V3, dir: V3) => RGB, mode?: Mode): void;
  }
  interface Ico { v: V3[]; t: Tri[] }

  /** A lamp as the shading sees it: where, its reach squared, its power. */
  interface LampLight { x: number; y: number; z: number; r2: number; k: number }
  interface Glow { p: V3; size: number; a: number }
  /** Everything the builders of one scene share. */
  interface Ctx {
    THREE: ThreeModule;
    detail: Partial<StationDetailModel>;
    opts: Station3DDetailOptions;
    pal: Pal;
    dark: boolean;
    high: boolean;
    sun: V3;
    /** Drawn coarser: the thing being built stands far from the walk. */
    far: boolean;
    /** Where the shadow picture reaches (null: everywhere). */
    castBox: Box | null;
    ground: Ground;
    z0: number;
    plane: ((x: number, y: number) => number) | null;
    season: Station3DDetailSeason | null;
    counts: Station3DDetailCounts;
    warn(m: string): void;
    walk: [V3, V3, V3][];
    /** The plain ground where the data has no surface. */
    base: Ground;
    gtris: CastTri[];
    /** The sun's shadows are drawn as a picture. */
    cast: boolean;
    fit: Plane;
    /** The level of the nearest street (low: towards the lowest nearby). Set by basePlate. */
    zNear?: (x: number, y: number, low?: boolean) => number;
    /** Whether the shadow picture covers this point. */
    casts(x: number, y: number): boolean;
    groundBatches: Map<string, GroundBatch>;
    shadow: Batch;
    pool: Batch;
    feather: Batch;
    glows: Glow[];
    W: Record<'solid' | 'bld' | 'crown' | 'glass' | 'decal', Writer>;
    path: XY[] | null;
    clearance: number;
    lobeF: number;
    windowBudget: number;
    /** The footprint of each building, by its index in detail.buildings. */
    rings: (BoxedRing | null)[];
    meshBuildings?: boolean;
  }
  /** What fill() makes in one go; casts is added right after. */
  type CtxDraft = Omit<Ctx, 'casts'>;

  /** A surface as read: cleaned rings, a height per ring point, its layer. */
  interface Surf {
    src: StationDetailSurface;
    order: number;
    kind: string;
    ring: Ring;
    zs: number[];
    holes: Ring[];
    zAt: (x: number, y: number) => number;
    box: Box;
    zMean: number;
    layer: number;
  }
  interface TrackLine { line: XY[]; width?: number }
  /** What stripes() needs of a surface. */
  interface Striped { ring: Ring; src: { heading?: number }; zAt: (x: number, y: number) => number }
  /** A marking as buildMarking takes it: one given among the surfaces can bring any text as its kind. */
  interface Marking extends Omit<StationDetailMarking, 'kind'> { kind?: string }
  interface StripPt { f: Frame; top: number; gl: number; gr: number }
  interface StripOpt { w: number; top: RGB; face: RGB; arris?: number; arrisCol?: RGB; shadow?: number; shadowA?: number; walk?: [V3, V3, V3][] }

  /** A prop while it is drawn: _host = the radius of the mast it is strapped to, _span = the wire it hangs on. */
  interface Prop extends StationDetailProp { _host?: number; _span?: Wire }
  /** The two ends of a wire across the street. */
  interface Wire { a: V3; b: V3 }
  interface Span extends Wire { len: number }
  interface PropLight { at: V3; reach: number; power: number; glow: number }
  /** The shadow under a prop: half sizes and strength. */
  interface PropShadow { rx: number; ry: number; a: number }
  type PropFn = (C: Ctx, p: Prop, W: Writer, R: Rng, x: number, y: number, z: number) => PropShadow | null;

  interface Gap { s0: number; s1: number; top: number }
  /** One straight piece of wall: from a to b, t along it, n outwards. */
  interface Wall { a: XY; b: XY; len: number; t: XY; n: XY; gaps: Gap[]; gable?: boolean }
  interface RingEdge extends Wall { i: number }
  /** A stretch of wall laid out as one front. Made in steps: buildBuilding fills it in. */
  interface Run {
    edges: RingEdge[];
    A: XY;
    B: XY;
    len: number;
    t: XY;
    n: XY;
    spec: Partial<StationDetailFace>;
    party: boolean;
    col: RGB;
    floors: number;
    kind: StationDetailGroundFloor;
    bays: number;
    gf: number;
    fh: number;
    deco: boolean;
    Q: (s: number, out: number, z: number) => V3;
    zg: (s: number) => number;
    arcade: boolean;
    // only on a real arcade:
    D: number;
    pd: number;
    openA: boolean;
    openB: boolean;
  }
  interface Runs extends Array<Run> { E?: RingEdge[] }
  /** A bay window laid out on a front: s = its middle along the front, its first and last floor, width and depth. */
  interface Oriel { s: number; f0: number; f1: number; w: number; d: number }
  interface Balcony { s: number; floor: number; w: number }
  interface MeshTri { A: V3; B: V3; D: V3; n: V3; ar: number }

  type Res = THREE.BufferGeometry | THREE.Material | THREE.Texture;
  interface Handle extends Station3DDetailHandle { _res: Res[]; _THREE: ThreeModule; _ground: Ground | null; _base: Ground | null; _vehicles: Veh[]; _map: ToScene; _flip: boolean; _tracks: XY[][] }
  /** What build() makes itself; fill() and the end of build() add the rest of a Handle. */
  type HandleDraft = Pick<Handle, 'group' | 'detail' | 'opts' | 'lamps' | '_res' | '_THREE'> & { stats: null; parts: {} };

  // ---------- small maths ----------
  const RAD = Math.PI / 180, TAU = Math.PI * 2;
  const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  const sat = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
  const smooth = (a: number, b: number, v: number) => { const t = sat((v - a) / (b - a)); return t * t * (3 - 2 * t); };
  const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : undefined);
  const or = (v: unknown, d: number) => (typeof v === 'number' && isFinite(v) ? v : d);
  const sub = (a: V3 | P4, b: V3 | P4): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add3 = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const mul3 = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
  const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: V3): V3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
  function faceN(a: V3, b: V3, c: V3): V3 | null {
    const n = cross(sub(b, a), sub(c, a)), l = Math.hypot(n[0], n[1], n[2]);
    return l < 1e-10 ? null : [n[0] / l, n[1] / l, n[2] / l];
  }
  // a seed from a position (centimetre grid), and a small random generator: the same place always looks the same
  function seedOf(x: number, y: number, salt?: number) {
    let h = (Math.imul(Math.round(x * 100), 73856093) ^ Math.imul(Math.round(y * 100), 19349663) ^ Math.imul((salt || 0) + 1, 83492791)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x45d9f3b); h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function rng(seed: number): Rng {
    let a = (seed >>> 0) || 1;
    return () => {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // smooth noise in 3D, 0..1
  function hash3(i: number, j: number, k: number) { const s = Math.sin(i * 127.1 + j * 311.7 + k * 74.7) * 43758.5453; return s - Math.floor(s); }
  function noise3(x: number, y: number, z: number) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let fx = x - xi, fy = y - yi, fz = z - zi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy); fz = fz * fz * (3 - 2 * fz);
    const a = lerp(lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), fx), lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), fx), fy);
    const b = lerp(lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), fx), lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), fx), fy);
    return lerp(a, b, fz);
  }

  // ---------- colours: sRGB triples 0..1 while building, linear in the buffers ----------
  function hex(h: RGB | string | boolean | null | undefined): RGB | null {
    if (Array.isArray(h)) return h;
    let s = String(h || '').trim().replace('#', '');
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    const n = parseInt(s, 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const mix = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
  const tone = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k];
  const lum = (c: RGB) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
  const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4));
  const css = (c: RGB, a?: number) => 'rgba(' + Math.round(sat(c[0]) * 255) + ',' + Math.round(sat(c[1]) * 255) + ',' + Math.round(sat(c[2]) * 255) + ',' + (a == null ? 1 : a) + ')';
  const WHITE: RGB = [1, 1, 1], BLACK: RGB = [0, 0, 0];

  const PALETTE = {
    light: {
      sky: '#DCEBFA', horizon: '#F4F1EA', ground: '#F3EFE7',
      paving: '#E3DCCD', asphalt: '#C9C7C2', road: '#B5B6BA', pavement: '#DAD4C8', cobble: '#DAD2C2', gravel: '#E3D4B6', grass: '#BFDDA6', soil: '#BCAA8E', water: '#9CCBEB',
      tram: '#BFC0C2', kerb: '#EDE8DC', stone: '#D9D2C2', marking: '#F0C93F', rail: '#74787F',
      wall: '#E6DFCF', wallShade: '#CDC5B4', trim: '#F7F3E9', roof: '#B2A99C', roofTile: '#BC7A5E',
      glass: '#7C9AB9', glassLit: '#FFE9B0', pane: '#CFE3F2', door: '#8A735D',
      crown: '#A9D18E', crownDark: '#8FBF78', crownLight: '#C4E2AC', hedge: '#9CC784', conifer: '#7FB08A',
      trunk: '#8D7B68', metal: '#6E7278', steel: '#B4B8BD', wood: '#B08A62',
      lamp: '#FFE9B0', lens: '#FBF7EA', bronze: '#6F9080', sign: '#4C8FE0', hydrant: '#C8705F',
      shadow: '#3C4352', shadowAlpha: 0.27, castAlpha: 0.36,
      awnings: ['#C9907C', '#A3B79E', '#E3CFA2', '#9FB1C4'], shutters: ['#9DB39A', '#A8B6BF', '#BC958C'],
      flowers: ['#E58F8F', '#F2C75C', '#E9A6C6'],
    },
    dark: {
      sky: '#101216', horizon: '#1B1D22', ground: '#26282C',
      paving: '#36383D', asphalt: '#2F3035', road: '#2B2C31', pavement: '#383A40', cobble: '#313236', gravel: '#3B3A34', grass: '#25392C', soil: '#2F2C26', water: '#1E3449',
      tram: '#292A2F', kerb: '#4B4D54', stone: '#46484E', marking: '#A38B36', rail: '#666A72',
      wall: '#3B3D43', wallShade: '#2F3136', trim: '#494B52', roof: '#2A2B30', roofTile: '#3A302C',
      glass: '#1D2530', glassLit: '#FFD98A', pane: '#2B3A4A', door: '#3A322B',
      crown: '#2F4A36', crownDark: '#27402F', crownLight: '#38573F', hedge: '#2B4532', conifer: '#263E33',
      trunk: '#4A4138', metal: '#55585E', steel: '#6B6F76', wood: '#6A5440',
      lamp: '#FFD98A', lens: '#FFF1C9', bronze: '#3F5048', sign: '#35629F', hydrant: '#7A4439',
      shadow: '#000000', shadowAlpha: 0.34, castAlpha: 0,
      awnings: ['#6A4A40', '#4A5A4A', '#6B6046', '#46546A'], shutters: ['#3F5244', '#465058', '#5A433E'],
      flowers: ['#8E5252', '#9A7F35', '#8E5F78'],
    },
  } satisfies Record<Station3DDetailTheme, Station3DDetailPalette>;
  function paletteOf(theme: Station3DDetailTheme | undefined, over?: PalOver | null): Pal {
    const src: PalSrc = PALETTE[theme === 'dark' ? 'dark' : 'light'], out: Record<string, RGB | RGB[] | number> = {};
    for (const k of Object.keys(src)) {
      const v = over && over[k] != null ? over[k] : src[k];
      if (Array.isArray(src[k])) out[k] = (Array.isArray(v) ? v as Station3DDetailColor[] : src[k]).map((c) => hex(c) || hex((src[k] as string[])[0])!);
      else if (typeof src[k] === 'number') out[k] = typeof v === 'number' ? v : src[k];
      else out[k] = hex(v as Station3DDetailColor) || hex(src[k])!;
    }
    return out as Pal;
  }

  // ---------- polygons and lines in the plan ----------
  const area2 = (r: XY[]) => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
  // A usable ring: no repeated points, counter-clockwise. keep[] says which of the given points stayed (for zs).
  function cleanRing(ring: XY[] | null | undefined): Ring | null {
    if (!Array.isArray(ring)) return null;
    const pts = [] as XY[] as Ring, keep: number[] = [];
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      const q = pts[pts.length - 1];
      if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-4) continue;
      pts.push([+p[0], +p[1]]); keep.push(i);
    }
    while (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-4) { pts.pop(); keep.pop(); }
    if (pts.length < 3) return null;
    if (Math.abs(area2(pts)) < 1e-6) return null;
    if (area2(pts) < 0) { pts.reverse(); keep.reverse(); }
    pts.keep = keep;
    return pts;
  }
  function inRing(r: XY[], x: number, y: number) {
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const a = r[i], b = r[j];
      if ((a[1] > y) !== (b[1] > y) && x < (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]) inside = !inside;
    }
    return inside;
  }
  const boxOf = (r: XY[]): Box => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of r) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); } return [x0, y0, x1, y1]; };
  const centroid = (r: XY[]): XY => { let x = 0, y = 0; for (const p of r) { x += p[0]; y += p[1]; } return [x / r.length, y / r.length]; };
  function segDist(px: number, py: number, a: XY, b: XY) {
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
    const t = l2 ? clamp(((px - a[0]) * dx + (py - a[1]) * dy) / l2, 0, 1) : 0;
    return Math.hypot(px - a[0] - dx * t, py - a[1] - dy * t);
  }
  function lineDist(line: XY[], x: number, y: number) { let d = Infinity; for (let i = 0; i + 1 < line.length; i++) d = Math.min(d, segDist(x, y, line[i], line[i + 1])); return d; }
  // keep the part of a polygon where A·x + B·y + C >= 0
  function clipPoly(poly: XY[], A: number, B: number, C: number) {
    const out: XY[] = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const dp = A * p[0] + B * p[1] + C, dq = A * q[0] + B * q[1] + C;
      if (dp >= 0) out.push(p);
      if ((dp >= 0) !== (dq >= 0)) { const t = dp / (dp - dq); out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]); }
    }
    return out;
  }
  // The direction most edges of a ring run in (degrees, 0..90 folded: paving is laid along or across it)
  function grainOf(ring: XY[]) {
    let c = 0, s = 0;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const t = Math.atan2(b[1] - a[1], b[0] - a[0]) * 4;
      c += Math.cos(t) * l; s += Math.sin(t) * l;
    }
    return Math.atan2(s, c) / 4;
  }
  // The long axis of a ring: [ux, uy] and the extents along and across it
  function longAxis(ring: XY[], ang?: number | null) {
    let best = null as Axis | null;
    const tryDir = (t: number) => {
      const ux = Math.cos(t), uy = Math.sin(t);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const p of ring) { const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
      const r = { ux, uy, u0, u1, v0, v1, len: u1 - u0, wid: v1 - v0 };
      if (ang != null) { best = r; return; }
      if (!best || r.len * r.wid < best.len * best.wid - 1e-6) best = r;
    };
    if (ang != null) tryDir(ang);
    else for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length]; if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0.05) tryDir(Math.atan2(b[1] - a[1], b[0] - a[0])); }
    if (best && best.wid > best.len) best = { ux: -best.uy, uy: best.ux, u0: best.v0, u1: best.v1, v0: -best.u1, v1: -best.u0, len: best.wid, wid: best.len };
    return best;
  }
  // A line without repeated points; closed: the last point joins the first
  function cleanLine(line: (XY | StationDetailXYZ)[] | null | undefined, closed?: boolean) {
    const pts: XY[] = [];
    for (const p of line || []) {
      if (!p || !isFinite(p[0]) || !isFinite(p[1])) continue;
      const q = pts[pts.length - 1];
      if (q && Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-3) continue;
      pts.push([+p[0], +p[1]]);
    }
    if (closed && pts.length > 2 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-3) pts.pop();
    return pts.length >= 2 ? pts : null;
  }
  // Per point of a line: the direction of travel and the mitre to its left (already scaled for a clean corner)
  function lineFrames(pts: XY[], closed: boolean) {
    const n = pts.length, out: Frame[] = [];
    for (let i = 0; i < n; i++) {
      const a = closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)], b = closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)], p = pts[i];
      let d0x = p[0] - a[0], d0y = p[1] - a[1], d1x = b[0] - p[0], d1y = b[1] - p[1];
      let l0 = Math.hypot(d0x, d0y), l1 = Math.hypot(d1x, d1y);
      if (l0 < 1e-6) { d0x = d1x; d0y = d1y; l0 = l1; }
      if (l1 < 1e-6) { d1x = d0x; d1y = d0y; l1 = l0; }
      d0x /= l0 || 1; d0y /= l0 || 1; d1x /= l1 || 1; d1y /= l1 || 1;
      let tx = d0x + d1x, ty = d0y + d1y;
      const tl = Math.hypot(tx, ty);
      if (tl < 1e-6) { tx = d1x; ty = d1y; } else { tx /= tl; ty /= tl; }
      const cosHalf = Math.max(0.35, tx * d1x + ty * d1y); // limits the spike of a sharp corner
      out.push({ p, t: [tx, ty], l: [-ty / cosHalf, tx / cosHalf] });
    }
    return out;
  }
  const offPt = (f: Frame, d: number): XY => [f.p[0] + f.l[0] * d, f.p[1] + f.l[1] * d];
  // Points every `step` metres along a line (corners always included): [{ p, t, s }]
  function walkLine(pts: XY[], step: number, closed: boolean) {
    const out: Step[] = [], n = pts.length, m = closed ? n : n - 1;
    let s = 0;
    for (let i = 0; i < m; i++) {
      const a = pts[i], b = pts[(i + 1) % n], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (l < 1e-6) continue;
      const k = Math.max(1, Math.round(l / step)), t: XY = [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
      for (let j = 0; j < k; j++) out.push({ p: [lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k)], t, s: s + l * j / k, corner: j === 0 });
      s += l;
      if (i === m - 1) out.push({ p: [b[0], b[1]], t, s, corner: true, last: true });
    }
    return out;
  }

  // ---------- the detailed ground: what z a point has ----------
  function Ground(this: Ground) { this.t = []; this.grid = new Map(); this.cell = 4; }
  (Ground.prototype as Ground).add = function (a, b, c, layer) {
    const d = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(d) < 1e-9) return;
    const i = this.t.length;
    this.t.push([a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], d, layer || 0]);
    const s = this.cell;
    const x0 = Math.floor(Math.min(a[0], b[0], c[0]) / s), x1 = Math.floor(Math.max(a[0], b[0], c[0]) / s);
    const y0 = Math.floor(Math.min(a[1], b[1], c[1]) / s), y1 = Math.floor(Math.max(a[1], b[1], c[1]) / s);
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
      const k = x * 100003 + y;
      let l = this.grid.get(k);
      if (!l) this.grid.set(k, (l = []));
      l.push(i);
    }
  };
  // z of the surface drawn last at (x, y); hit(x, y) also tells its layer
  (Ground.prototype as Ground).hit = function (x, y) {
    const l = this.grid.get(Math.floor(x / this.cell) * 100003 + Math.floor(y / this.cell));
    if (!l) return null;
    for (let i = l.length - 1; i >= 0; i--) {
      const t = this.t[l[i]];
      const w1 = ((x - t[0]) * (t[7] - t[1]) - (y - t[1]) * (t[6] - t[0])) / t[9];
      const w2 = ((t[3] - t[0]) * (y - t[1]) - (t[4] - t[1]) * (x - t[0])) / t[9];
      if (w1 < -1e-6 || w2 < -1e-6 || w1 + w2 > 1 + 1e-6) continue;
      return { z: t[2] + (t[5] - t[2]) * w1 + (t[8] - t[2]) * w2, layer: t[10] };
    }
    return null;
  };
  (Ground.prototype as Ground).at = function (x, y) { const h = this.hit(x, y); return h ? h.z : null; };

  // ---------- geometry buffers ----------
  // One merged mesh in the making. Positions are model coordinates until finish() maps them to the scene.
  function Batch(this: Batch, alpha?: boolean) { this.p = []; this.c = []; this.i = []; this.uv = null; this.n = 0; this.alpha = !!alpha; }
  (Batch.prototype as Batch).vert = function (p, c, a) {
    this.p.push(p[0], p[1], p[2]);
    if (this.alpha) this.c.push(c[0], c[1], c[2], a == null ? 1 : a); else this.c.push(c[0], c[1], c[2]);
    return this.n++;
  };

  // Writes shapes into a batch. Points are given in a local frame (frame(): x to the right, y the way the thing
  // faces, z up) or in model coordinates (world()). Every vertex colour runs through shade().
  function Writer(this: Writer, batch: Batch, shade: Shade) { this.b = batch; this.shade = shade; this.o = null; }
  (Writer.prototype as Writer).frame = function (x, y, z, heading) { const h = (heading || 0) * RAD; this.o = { x, y, z, c: Math.cos(h), s: Math.sin(h) }; return this; };
  (Writer.prototype as Writer).world = function () { this.o = null; return this; };
  (Writer.prototype as Writer).P = function (p) { const o = this.o; return o ? [o.x + p[0] * o.c + p[1] * o.s, o.y - p[0] * o.s + p[1] * o.c, o.z + p[2]] : p; };
  (Writer.prototype as Writer).N = function (n) { const o = this.o; return o ? [n[0] * o.c + n[1] * o.s, -n[0] * o.s + n[1] * o.c, n[2]] : n; };
  // one vertex: world position, world normal, colour (or a function of both), mode (see shade), alpha
  (Writer.prototype as Writer).emit = function (P, n, col, mode, a) {
    const c = typeof col === 'function' ? col(P, n) : col;
    return this.b.vert(P, this.shade(c, n, P, mode), a);
  };
  (Writer.prototype as Writer).tri = function (a, b, c, col, opt) {
    const A = this.P(a), B = this.P(b), C = this.P(c);
    let n = faceN(A, B, C);
    if (!n) return;
    let flip = false;
    if (opt && opt.n) { const h = this.N(opt.n); if (dot(n, h) < 0) { flip = true; n = [-n[0], -n[1], -n[2]]; } }
    const cs = Array.isArray(col) && Array.isArray(col[0]) ? col as RGB[] : null, mode = opt && opt.mode, al = opt && opt.a;
    const i0 = this.emit(A, n, cs ? cs[0] : col as Col, mode, al), i1 = this.emit(B, n, cs ? cs[1] : col as Col, mode, al), i2 = this.emit(C, n, cs ? cs[2] : col as Col, mode, al);
    if (flip) this.b.i.push(i0, i2, i1); else this.b.i.push(i0, i1, i2);
    if (opt && opt.two) { if (flip) this.b.i.push(i0, i1, i2); else this.b.i.push(i0, i2, i1); }
  };
  // a flat four-sided face; opt.n: a direction the face should look to (the winding is turned to match),
  // opt.two: visible from both sides, col: one colour, four colours or a function, opt.a: alpha or four alphas
  (Writer.prototype as Writer).quad = function (a, b, c, d, col, opt) {
    const A = this.P(a), B = this.P(b), C = this.P(c), D = this.P(d);
    let n = faceN(A, B, C) || faceN(A, C, D) || faceN(B, C, D);
    if (!n) return;
    let flip = false;
    if (opt && opt.n) { const h = this.N(opt.n); if (dot(n, h) < 0) { flip = true; n = [-n[0], -n[1], -n[2]]; } }
    const cs = Array.isArray(col) && Array.isArray(col[0]) ? col as RGB[] : null, mode = opt && opt.mode, al = opt && opt.a, as = Array.isArray(al) ? al : null;
    const i0 = this.emit(A, n, cs ? cs[0] : col as Col, mode, as ? as[0] : al as number | undefined), i1 = this.emit(B, n, cs ? cs[1] : col as Col, mode, as ? as[1] : al as number | undefined);
    const i2 = this.emit(C, n, cs ? cs[2] : col as Col, mode, as ? as[2] : al as number | undefined), i3 = this.emit(D, n, cs ? cs[3] : col as Col, mode, as ? as[3] : al as number | undefined);
    if (flip) this.b.i.push(i0, i2, i1, i0, i3, i2); else this.b.i.push(i0, i1, i2, i0, i2, i3);
    if (opt && opt.two) { if (flip) this.b.i.push(i0, i1, i2, i0, i2, i3); else this.b.i.push(i0, i2, i1, i0, i3, i2); }
  };
  // a flat convex face from its outline
  (Writer.prototype as Writer).fan = function (pts, col, opt) {
    if (pts.length < 3) return;
    const W = pts.map((p) => this.P(p));
    let n: V3 | null = null;
    for (let i = 1; i + 1 < W.length && !n; i++) n = faceN(W[0], W[i], W[i + 1]);
    if (!n) return;
    let flip = false;
    if (opt && opt.n) { const h = this.N(opt.n); if (dot(n, h) < 0) { flip = true; n = [-n[0], -n[1], -n[2]]; } }
    const mode = opt && opt.mode, idx = W.map((p) => this.emit(p, n, col, mode, opt && opt.a));
    for (let i = 1; i + 1 < idx.length; i++) {
      if (flip) this.b.i.push(idx[0], idx[i + 1], idx[i]); else this.b.i.push(idx[0], idx[i], idx[i + 1]);
      if (opt && opt.two) { if (flip) this.b.i.push(idx[0], idx[i], idx[i + 1]); else this.b.i.push(idx[0], idx[i + 1], idx[i]); }
    }
  };
  // a box along the axes of the frame; opt.top: colour of the lid, opt.bottom: draw the underside too
  (Writer.prototype as Writer).box = function (x0, y0, z0, x1, y1, z1, col, opt) {
    const t = (opt && opt.top) || col, o = opt && opt.mode ? { mode: opt.mode } : {};
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], t, Object.assign({ n: [0, 0, 1] as V3 }, o));
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col, Object.assign({ n: [0, -1, 0] as V3 }, o));
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], col, Object.assign({ n: [0, 1, 0] as V3 }, o));
    this.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], col, Object.assign({ n: [-1, 0, 0] as V3 }, o));
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], col, Object.assign({ n: [1, 0, 0] as V3 }, o));
    if (opt && opt.bottom) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], col, Object.assign({ n: [0, 0, -1] as V3 }, o));
  };
  // a box of any orientation: centre and three half-axes
  (Writer.prototype as Writer).obox = function (c, ax, ay, az, col, opt) {
    const P = (i: number, j: number, k: number): V3 => [c[0] + ax[0] * i + ay[0] * j + az[0] * k, c[1] + ax[1] * i + ay[1] * j + az[1] * k, c[2] + ax[2] * i + ay[2] * j + az[2] * k];
    const o = (n: V3): QuadOpt => (opt && opt.mode ? { n, mode: opt.mode } : { n });
    const skip = (opt && opt.skip) || '';
    if (!skip.includes('+z')) this.quad(P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1), (opt && opt.top) || col, o(az));
    if (!skip.includes('-z')) this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, 1, -1), P(-1, 1, -1), col, o(mul3(az, -1)));
    if (!skip.includes('-y')) this.quad(P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1), col, o(mul3(ay, -1)));
    if (!skip.includes('+y')) this.quad(P(-1, 1, -1), P(1, 1, -1), P(1, 1, 1), P(-1, 1, 1), col, o(ay));
    if (!skip.includes('-x')) this.quad(P(-1, -1, -1), P(-1, 1, -1), P(-1, 1, 1), P(-1, -1, 1), col, o(mul3(ax, -1)));
    if (!skip.includes('+x')) this.quad(P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1), col, o(ax));
  };
  // an upright round post or cone, smooth around; opt.cap: close the top, opt.col1: colour at the top
  (Writer.prototype as Writer).cyl = function (x, y, z0, z1, r0, r1, seg, col, opt) {
    const h = z1 - z0, sl = (r0 - r1) / (h || 1), il = 1 / Math.hypot(1, sl), mode = opt && opt.mode;
    const c1 = (opt && opt.col1) || col, base = this.b.n, ph = (opt && opt.phase) || 0;
    for (let k = 0; k <= seg; k++) {
      const a = ph + (k / seg) * TAU, ca = Math.cos(a), sa = Math.sin(a), n = this.N([ca * il, sa * il, sl * il]);
      this.emit(this.P([x + ca * r0, y + sa * r0, z0]), n, col, mode);
      this.emit(this.P([x + ca * r1, y + sa * r1, z1]), n, c1, mode);
    }
    for (let k = 0; k < seg; k++) { const a = base + k * 2; this.b.i.push(a, a + 2, a + 3, a, a + 3, a + 1); }
    if (opt && opt.cap && r1 > 1e-4) {
      const pts: V3[] = [];
      for (let k = 0; k < seg; k++) { const a = ph + (k / seg) * TAU; pts.push([x + Math.cos(a) * r1, y + Math.sin(a) * r1, z1]); }
      this.fan(pts, (opt && opt.capCol) || c1, { n: [0, 0, 1], mode });
    }
  };
  // a round bar along a path of [x, y, z, radius]; opt.cap: close the far end; opt.cols: a colour per path point
  (Writer.prototype as Writer).tube = function (path, seg, col, opt) {
    const n = path.length;
    if (n < 2) return;
    const mode = opt && opt.mode, base = this.b.n;
    let u: V3 | null = null;
    for (let i = 0; i < n; i++) {
      const a = path[Math.max(0, i - 1)], b = path[Math.min(n - 1, i + 1)];
      const t = norm(sub(b, a));
      if (!u) u = Math.abs(t[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
      u = norm(sub(u, mul3(t, dot(u, t))));
      const v = cross(t, u), p = path[i], r = p[3], c = opt && opt.cols ? opt.cols[i] : col;
      for (let k = 0; k <= seg; k++) {
        const an = (k / seg) * TAU, ca = Math.cos(an), sa = Math.sin(an);
        const d: V3 = [u[0] * ca + v[0] * sa, u[1] * ca + v[1] * sa, u[2] * ca + v[2] * sa];
        this.emit(this.P([p[0] + d[0] * r, p[1] + d[1] * r, p[2] + d[2] * r]), this.N(d), c, mode);
      }
    }
    const m = seg + 1;
    for (let i = 0; i + 1 < n; i++) for (let k = 0; k < seg; k++) {
      const a = base + i * m + k, b = a + m;
      this.b.i.push(a, a + 1, b + 1, a, b + 1, b);
    }
    if (opt && opt.cap && path[n - 1][3] > 1e-3) {
      const t = norm(sub(path[n - 1], path[n - 2])), p = path[n - 1], r = p[3];
      let w: V3 = Math.abs(t[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1];
      w = norm(sub(w, mul3(t, dot(w, t))));
      const v = cross(t, w), pts: V3[] = [];
      for (let k = 0; k < seg; k++) { const an = (k / seg) * TAU; pts.push([p[0] + (w[0] * Math.cos(an) + v[0] * Math.sin(an)) * r, p[1] + (w[1] * Math.cos(an) + v[1] * Math.sin(an)) * r, p[2] + (w[2] * Math.cos(an) + v[2] * Math.sin(an)) * r]); }
      this.fan(pts, opt.cols ? opt.cols[n - 1] : col, { n: t, mode });
    }
  };
  // a turned shape around an upright axis: profile [[radius, height, colour?], …] from the bottom up.
  // Few sides give facets (an octagonal basin), many a round body.
  (Writer.prototype as Writer).lathe = function (x, y, z, profile, seg, col, opt) {
    const mode = opt && opt.mode, ph = (opt && opt.phase) || 0, facet = opt && opt.facet != null ? opt.facet : seg <= 8;
    for (let i = 0; i + 1 < profile.length; i++) {
      const a = profile[i], b = profile[i + 1], c = b[2] || col;
      if (Math.abs(a[0] - b[0]) < 1e-5 && Math.abs(a[1] - b[1]) < 1e-5) continue;
      if (facet) {
        for (let k = 0; k < seg; k++) {
          const a0 = ph + (k / seg) * TAU, a1 = ph + ((k + 1) / seg) * TAU, am = (a0 + a1) / 2;
          const dz = b[1] - a[1], dr = b[0] - a[0], l = Math.hypot(dz, dr) || 1;
          const hint: V3 = [Math.cos(am) * dz / l, Math.sin(am) * dz / l, -dr / l];
          const p0: V3 = [x + Math.cos(a0) * a[0], y + Math.sin(a0) * a[0], z + a[1]], p1: V3 = [x + Math.cos(a1) * a[0], y + Math.sin(a1) * a[0], z + a[1]];
          const p2: V3 = [x + Math.cos(a1) * b[0], y + Math.sin(a1) * b[0], z + b[1]], p3: V3 = [x + Math.cos(a0) * b[0], y + Math.sin(a0) * b[0], z + b[1]];
          if (a[0] < 1e-5) this.tri(p0, p2, p3, c, { n: hint, mode });
          else if (b[0] < 1e-5) this.tri(p0, p1, p2, c, { n: hint, mode });
          else this.quad(p0, p1, p2, p3, c, { n: hint, mode });
        }
      } else {
        const dz = b[1] - a[1], dr = b[0] - a[0], l = Math.hypot(dz, dr) || 1, base = this.b.n;
        for (let k = 0; k <= seg; k++) {
          const an = ph + (k / seg) * TAU, ca = Math.cos(an), sa = Math.sin(an), nn = this.N([ca * dz / l, sa * dz / l, -dr / l]);
          this.emit(this.P([x + ca * a[0], y + sa * a[0], z + a[1]]), nn, c, mode);
          this.emit(this.P([x + ca * b[0], y + sa * b[0], z + b[1]]), nn, c, mode);
        }
        for (let k = 0; k < seg; k++) { const q = base + k * 2; this.b.i.push(q, q + 2, q + 3, q, q + 3, q + 1); }
      }
    }
  };

  // A ball of triangles (an icosahedron with every face split f × f), made once per f
  const ICO: Record<number, Ico> = {};
  function icosphere(f: number) {
    if (ICO[f]) return ICO[f];
    const t = (1 + Math.sqrt(5)) / 2;
    const V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    const F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    const v: V3[] = [], tris: Tri[] = [], key = new Map<string, number>();
    const put = (x: number, y: number, z: number) => {
      const l = Math.hypot(x, y, z), q: V3 = [x / l, y / l, z / l], k = Math.round(q[0] * 1e4) + ',' + Math.round(q[1] * 1e4) + ',' + Math.round(q[2] * 1e4);
      let i = key.get(k);
      if (i == null) { i = v.length; v.push(q); key.set(k, i); }
      return i;
    };
    for (const [a, b, c] of F) {
      const A = V[a], B = V[b], C = V[c], idx: number[][] = [];
      for (let i = 0; i <= f; i++) {
        idx[i] = [];
        for (let j = 0; j <= f - i; j++) { const k = f - i - j; idx[i][j] = put(A[0] * i + B[0] * j + C[0] * k, A[1] * i + B[1] * j + C[1] * k, A[2] * i + B[2] * j + C[2] * k); }
      }
      for (let i = 0; i < f; i++) for (let j = 0; j < f - i; j++) {
        tris.push([idx[i][j], idx[i + 1][j], idx[i][j + 1]]);
        if (j < f - i - 1) tris.push([idx[i + 1][j], idx[i + 1][j + 1], idx[i][j + 1]]);
      }
    }
    for (const tr of tris) { // all faces look outwards
      const n = cross(sub(v[tr[1]], v[tr[0]]), sub(v[tr[2]], v[tr[0]]));
      if (dot(n, v[tr[0]]) < 0) { const s = tr[1]; tr[1] = tr[2]; tr[2] = s; }
    }
    return (ICO[f] = { v, t: tris });
  }
  // A soft lump: a ball with radii rad, dented by noise. col(P, n, dir) gives the colour of a vertex.
  (Writer.prototype as Writer).lump = function (c, rad, f, amp, seed, col, mode) {
    const ico = icosphere(f), base = this.b.n, sx = (seed % 97) * 0.37, sy = (seed % 89) * 0.53;
    for (const d of ico.v) {
      const k = 1 + amp * (noise3(d[0] * 1.9 + sx, d[1] * 1.9 + sy, d[2] * 1.9) - 0.5) * 2;
      const P = this.P([c[0] + d[0] * rad[0] * k, c[1] + d[1] * rad[1] * k, c[2] + d[2] * rad[2] * k]);
      const n = this.N(norm([d[0] / rad[0], d[1] / rad[1], d[2] / rad[2]]));
      this.b.vert(P, this.shade(col(P, n, d), n, P, mode));
    }
    for (const t of ico.t) this.b.i.push(base + t[0], base + t[1], base + t[2]);
  };

  // ---------- ground textures, painted once per theme ----------
  // How many metres one repeat of a texture covers
  const TILE = { asphalt: 5, paving: 3.6, cobble: 2.4, gravel: 3, grass: 6, soil: 3, water: 4, tram: 5 };
  const TEXTURED: Record<string, number | undefined> = { asphalt: 1, paving: 1, cobble: 1, gravel: 1, grass: 1, soil: 1, water: 1, tram: 1 };
  function paint(kind: GroundKind, pal: Pal, n: number, dark: boolean) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = n;
    const g = cv.getContext('2d')!, R = rng(seedOf(kind.length * 3.7, kind.charCodeAt(0) * 1.3, 5));
    const base = kind === 'asphalt' ? pal.pavement : pal[kind] || pal.paving, k = dark ? 0.7 : 1, px = n / 512;
    g.fillStyle = css(base);
    g.fillRect(0, 0, n, n);
    const dots = (count: number, c: RGB, a: number, r0: number, r1: number) => {
      g.fillStyle = css(c, a);
      for (let i = 0; i < count; i++) { const r = lerp(r0, r1, R()) * px; g.fillRect(R() * n, R() * n, r, r); }
    };
    const clouds = (count: number, c: RGB, a: number, r0: number, r1: number) => {
      for (let i = 0; i < count; i++) {
        const x = R() * n, y = R() * n, r = lerp(r0, r1, R()) * n;
        for (const ox of [-n, 0, n]) for (const oy of [-n, 0, n]) {
          if (x + ox + r < 0 || x + ox - r > n || y + oy + r < 0 || y + oy - r > n) continue;
          const gr = g.createRadialGradient(x + ox, y + oy, 0, x + ox, y + oy, r);
          gr.addColorStop(0, css(c, a)); gr.addColorStop(1, css(c, 0));
          g.fillStyle = gr;
          g.fillRect(x + ox - r, y + oy - r, 2 * r, 2 * r);
        }
      }
    };
    const lighter = mix(base, WHITE, dark ? 0.16 : 0.5), darker = tone(base, dark ? 0.72 : 0.84);
    if (kind === 'asphalt' || kind === 'tram') {
      clouds(14, darker, 0.07 * k, 0.1, 0.3); clouds(10, lighter, 0.08 * k, 0.1, 0.25);
      dots(3600, lighter, 0.22 * k, 1.6, 3.2); dots(3600, darker, 0.2 * k, 1.6, 3.2);
    } else if (kind === 'gravel') {
      clouds(12, darker, 0.08 * k, 0.1, 0.3); clouds(10, lighter, 0.1 * k, 0.1, 0.3);
      dots(9000, lighter, 0.55 * k, 1.4, 3.2); dots(9000, darker, 0.42 * k, 1.4, 3.2); dots(2600, tone(base, 0.66), 0.4 * k, 1.2, 2.6); dots(700, mix(base, WHITE, 0.7), 0.5 * k, 2.4, 4.4);
    } else if (kind === 'soil') {
      clouds(12, darker, 0.12 * k, 0.1, 0.3);
      dots(6000, lighter, 0.3 * k, 1.2, 3); dots(7000, darker, 0.36 * k, 1.2, 3.4);
    } else if (kind === 'grass') {
      const warm = mix(base, hex(dark ? '#3A4A2A' : '#E3EBA9')!, 0.6);
      clouds(16, darker, 0.16 * k, 0.08, 0.26); clouds(14, lighter, 0.16 * k, 0.08, 0.26); clouds(8, warm, 0.14 * k, 0.06, 0.2);
      for (let i = 0; i < 7000; i++) { // short blades
        const x = R() * n, y = R() * n, l = (2 + R() * 4) * px, a = -Math.PI / 2 + (R() - 0.5) * 1.1;
        g.strokeStyle = css(R() < 0.5 ? lighter : darker, 0.2 * k);
        g.lineWidth = px;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
      }
    } else if (kind === 'water') {
      clouds(14, lighter, 0.2 * k, 0.08, 0.22); clouds(10, darker, 0.14 * k, 0.1, 0.25);
      g.lineCap = 'round';
      for (let i = 0; i < 70; i++) { // ripples
        const x = R() * n, y = R() * n, l = (14 + R() * 30) * px;
        g.strokeStyle = css(WHITE, (dark ? 0.08 : 0.34) * (0.5 + R() * 0.5));
        g.lineWidth = 1.4 * px;
        g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + l / 2, y - 3 * px, x + l, y); g.stroke();
      }
    } else if (kind === 'cobble') {
      // setts laid in arcs (Bogenpflaster): courses 10 cm apart, each a row of shallow arcs 1.2 m wide
      const m = n / TILE.cobble, W = 1.2 * m, s = 0.1 * m, rise = 0.27 * m, gap = 0.014 * m, rows = Math.round(n / s);
      g.fillStyle = css(tone(base, dark ? 0.74 : 0.83));
      g.fillRect(0, 0, n, n);
      const f = (x: number) => rise * (1 - Math.pow(2 * x / W - 1, 2)), S = 48, len = [0];
      for (let i = 1; i <= S; i++) len.push(len[i - 1] + Math.hypot(W / S, f(i * W / S) - f((i - 1) * W / S)));
      const N = Math.round(len[S] / (0.105 * m)), sl = len[S] / N;
      for (let row = -4; row < rows + 1; row++) for (let arc = 0; arc * W < n - 1; arc++) for (let i = 0; i < N; i++) {
        const want = (i + 0.5) * sl;
        let j = 1;
        while (j < S && len[j] < want) j++;
        const u = (j - 1 + (want - len[j - 1]) / (len[j] - len[j - 1])) / S, x = u * W, ang = Math.atan2(f(x + 1) - f(x - 1), 2);
        const h = hash3(((row % rows) + rows) % rows, arc, i), h2 = hash3(i, ((row % rows) + rows) % rows, arc + 7);
        const c = mix(tone(base, 0.95 + h * 0.1 * k), hex(dark ? '#3A3833' : '#D9CBB5')!, h2 * 0.25);
        g.save();
        g.translate(arc * W + x, row * s + f(x) + s / 2);
        g.rotate(ang);
        g.fillStyle = css(c);
        const w = sl - gap, hh = s - gap, r = Math.min(w, hh) * 0.28;
        g.beginPath();
        if (g.roundRect) g.roundRect(-w / 2, -hh / 2, w, hh, r); else g.rect(-w / 2, -hh / 2, w, hh);
        g.fill();
        g.restore();
      }
      clouds(8, lighter, 0.06 * k, 0.1, 0.3);
    } else {
      // paving: slabs 90 × 60 cm in running bond
      const cols = 4, rows = 6, w = n / cols, h = n / rows;
      for (let j = 0; j < rows; j++) for (let i = -1; i <= cols; i++) {
        const t = hash3(((i % cols) + cols) % cols, j, 3), t2 = hash3(j, ((i % cols) + cols) % cols, 11);
        g.fillStyle = css(mix(tone(base, 0.972 + t * 0.05 * k), hex(dark ? '#34332F' : '#E6DCCB')!, t2 * 0.3));
        g.fillRect(i * w + (j % 2) * w / 2, j * h, w, h);
      }
      dots(2600, lighter, 0.3 * k, 1, 2); dots(2600, darker, 0.16 * k, 1, 2);
      g.strokeStyle = css(tone(base, dark ? 0.72 : 0.86), 0.95);
      g.lineWidth = Math.max(1.5, n / 380);
      g.beginPath();
      for (let j = 0; j <= rows; j++) { g.moveTo(0, j * h); g.lineTo(n, j * h); }
      for (let j = 0; j < rows; j++) for (let i = 0; i <= cols; i++) { const x = i * w + (j % 2) * w / 2; g.moveTo(x, j * h); g.lineTo(x, (j + 1) * h); }
      g.stroke();
    }
    return cv;
  }

  // ---------- light ----------
  // shade(colour, normal, position, mode) → the colour a vertex gets. mode 1: glows by itself (untouched),
  // mode 2: already shaded by the shape (crowns), only the lamps are added at night.
  function makeShade(dark: boolean, L: V3, lamps: LampLight[], lampCol: RGB): Shade {
    return function (col, n, p, mode) {
      if (mode === 1) return col;
      const nL = lamps.length;
      let r = col[0], g = col[1], b = col[2];
      if (mode !== 2) {
        if (dark) { const m = 0.88 + 0.14 * (0.5 + 0.5 * n[2]); r *= m; g *= m; b *= m; }
        else {
          const t = sat((n[0] * L[0] + n[1] * L[1] + n[2] * L[2] + 0.2) / 0.95);
          let m = 0.81 + 0.19 * t + 0.035 * Math.max(0, n[2]);
          if (n[2] < 0) m *= 1 + 0.22 * n[2];
          const w = (t - 0.4) * 0.03; // warmer in the sun, cooler in the shade
          r *= m * (1 + w); g *= m; b *= m * (1 - w * 1.5);
        }
      }
      if (nL) {
        let w = 0;
        for (let i = 0; i < nL; i++) {
          const l = lamps[i], dx = l.x - p[0], dy = l.y - p[1], dz = l.z - p[2], d2 = dx * dx + dy * dy + dz * dz;
          if (d2 >= l.r2) continue;
          const f = 1 - d2 / l.r2, nl = (n[0] * dx + n[1] * dy + n[2] * dz) / Math.sqrt(d2 + 1e-4);
          w += f * f * (0.3 + 0.7 * Math.max(0, nl)) * l.k;
        }
        if (w > 0) {
          w = Math.min(w, 1.25);
          const k = 1 + 2.3 * w, s = sat(w * 1.2);
          r = r * k * lerp(1, lampCol[0] * 1.06, s) + 0.05 * w * lampCol[0];
          g = g * k * lerp(1, lampCol[1], s) + 0.05 * w * lampCol[1];
          b = b * k * lerp(1, lampCol[2] * 0.92, s) + 0.05 * w * lampCol[2];
        }
      }
      return [r, g, b];
    };
  }

  // ---------- shadows on the ground: dark, see-through shapes that lie on it ----------
  function groundZ(C: Ctx, x: number, y: number, fallback?: number | null) {
    let z = C.ground.at(x, y);
    if (z == null && fallback == null) z = C.base.at(x, y);
    return z == null ? (fallback == null ? C.z0 : fallback) : z;
  }
  // a soft round or oval shadow; the ground is followed point by point
  function blob(C: Ctx, x: number, y: number, rx: number, ry: number, heading: number, alpha: number, zf?: number) {
    const b = C.shadow, n = C.high ? 14 : 10, h = (heading || 0) * RAD, c = Math.cos(h), s = Math.sin(h), col = C.pal.shadow;
    const a = Math.min(0.6, alpha * C.pal.shadowAlpha);
    // the rim follows rising ground but never drops below the middle: beside a kerb it would vanish under the pavement
    const zc = groundZ(C, x, y, zf), i0 = b.vert([x, y, zc + 0.012], col, a);
    for (let ring = 0; ring < 2; ring++) for (let k = 0; k < n; k++) {
      const an = (k / n) * TAU, f = ring ? 1 : 0.55, lx = Math.cos(an) * rx * f, ly = Math.sin(an) * ry * f;
      const px = x + lx * c + ly * s, py = y - lx * s + ly * c;
      b.vert([px, py, Math.max(zc, groundZ(C, px, py, zf)) + 0.012], col, ring ? 0 : a * 0.8);
    }
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n, a0 = i0 + 1 + k, a1 = i0 + 1 + k1, b0 = i0 + 1 + n + k, b1 = i0 + 1 + n + k1;
      b.i.push(i0, a0, a1, a0, b0, b1, a0, b1, a1);
    }
  }
  // a band of shadow between two lines of points (inner: dark, outer: gone)
  function shadeStrip(C: Ctx, inner: XYz[], outer: XYz[], alpha: number, zf?: number, closed?: boolean) {
    const b = C.shadow, col = C.pal.shadow, a = Math.min(0.6, alpha * C.pal.shadowAlpha), base = b.n, n = inner.length;
    for (let i = 0; i < n; i++) {
      b.vert([inner[i][0], inner[i][1], (inner[i][2] != null ? inner[i][2]! : groundZ(C, inner[i][0], inner[i][1], zf)) + 0.01], col, a);
      b.vert([outer[i][0], outer[i][1], (outer[i][2] != null ? outer[i][2]! : groundZ(C, outer[i][0], outer[i][1], zf)) + 0.01], col, 0);
    }
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const p = base + i * 2, q = base + ((i + 1) % n) * 2;
      b.i.push(p, q, q + 1, p, q + 1, p + 1, p, q + 1, q, p, p + 1, q + 1); // both windings: the side does not matter
    }
  }
  // a pool of lamp light on the ground (night)
  function pool(C: Ctx, x: number, y: number, r: number, strength: number, zf?: number) {
    const b = C.pool, n = C.high ? 18 : 10, col = C.pal.lamp;
    const zc = groundZ(C, x, y, zf), i0 = b.vert([x, y, zc + 0.014], col, strength);
    const rings = [[0.3, 0.72], [0.62, 0.3], [1, 0]];
    rings.forEach((rg) => {
      for (let k = 0; k < n; k++) {
        const an = (k / n) * TAU, px = x + Math.cos(an) * r * rg[0], py = y + Math.sin(an) * r * rg[0];
        b.vert([px, py, Math.max(zc, groundZ(C, px, py, zf)) + 0.014], col, strength * rg[1]);
      }
    });
    for (let k = 0; k < n; k++) {
      const k1 = (k + 1) % n;
      b.i.push(i0, i0 + 1 + k, i0 + 1 + k1);
      for (let rg = 0; rg < 2; rg++) { const a0 = i0 + 1 + rg * n + k, a1 = i0 + 1 + rg * n + k1; b.i.push(a0, a0 + n, a1 + n, a0, a1 + n, a1); }
    }
  }

  // ---------- surfaces ----------
  function triangulate(THREE: ThreeModule, ring: XY[], holes?: XY[][]) {
    const V2 = THREE.Vector2, c = ring.map((p) => new V2(p[0], p[1])), hs = (holes || []).map((h) => h.map((p) => new V2(p[0], p[1])));
    let f;
    try { f = THREE.ShapeUtils.triangulateShape(c, hs); } catch (e) { return []; }
    return f || [];
  }
  function ringsTouch(a: Surf, b: Surf) {
    const A = a.box, B = b.box;
    if (A[0] > B[2] || B[0] > A[2] || A[1] > B[3] || B[1] > A[3]) return false;
    for (const p of a.ring) if (inRing(b.ring, p[0], p[1])) return true;
    for (const p of b.ring) if (inRing(a.ring, p[0], p[1])) return true;
    const ca = centroid(a.ring), cb = centroid(b.ring);
    return inRing(b.ring, ca[0], ca[1]) || inRing(a.ring, cb[0], cb[1]);
  }
  // Read the surfaces: clean rings, a height per point, and the layer each lies in (a surface on top of another at
  // the same height is drawn a layer higher, so the two never flicker).
  function readSurfaces(C: Ctx) {
    const out: Surf[] = [];
    (C.detail.surfaces || []).forEach((s, order) => {
      if (!s || s.kind === 'marking') return; // markings are painted later, on top
      const ring = cleanRing(s.ring);
      if (!ring) { if (s.ring) C.warn('surface ' + order + ': ring unusable'); return; }
      const zs = ring.keep.map((i) => (Array.isArray(s.zs) && isFinite(s.zs[i]) ? +s.zs[i] : or(s.z, 0)));
      const holes = (s.holes || []).map(cleanRing).filter(Boolean) as Ring[];
      // a plane through the ring, for the height of hole points
      let sx = 0, sy = 0, sz = 0;
      ring.forEach((p, i) => { sx += p[0]; sy += p[1]; sz += zs[i]; });
      const cx = sx / ring.length, cy = sy / ring.length, cz = sz / ring.length;
      let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
      ring.forEach((p, i) => { const dx = p[0] - cx, dy = p[1] - cy, dz = zs[i] - cz; xx += dx * dx; xy += dx * dy; yy += dy * dy; xz += dx * dz; yz += dy * dz; });
      const det = xx * yy - xy * xy, pa = Math.abs(det) > 1e-9 ? (xz * yy - yz * xy) / det : 0, pb = Math.abs(det) > 1e-9 ? (yz * xx - xz * xy) / det : 0;
      const zAt = (x: number, y: number) => cz + pa * (x - cx) + pb * (y - cy);
      const kind = s.kind === 'tram-track' ? 'tram' : String(s.kind || 'paving');
      const rec: Surf = { src: s, order, kind, ring, zs, holes, zAt, box: boxOf(ring), zMean: cz, layer: 0 };
      for (const o of out) {
        if (!ringsTouch(o, rec)) continue;
        // the same height where they meet? (compared at a point both cover, so slopes do not mislead)
        const c = centroid(rec.ring), oc = centroid(o.ring), q = inRing(o.ring, c[0], c[1]) ? c : inRing(rec.ring, oc[0], oc[1]) ? oc : rec.ring.find((p) => inRing(o.ring, p[0], p[1])) || o.ring.find((p) => inRing(rec.ring, p[0], p[1])) || c;
        if (Math.abs(o.zAt(q[0], q[1]) - rec.zAt(q[0], q[1])) < 0.06) rec.layer = Math.max(rec.layer, o.layer + 1);
      }
      rec.layer = Math.min(rec.layer, 4);
      out.push(rec);
    });
    return out;
  }
  function groundBatch(C: Ctx, kind: GroundKind, layer: number) {
    const key = kind + ':' + layer;
    let g = C.groundBatches.get(key);
    if (!g) { g = new (Batch as BatchNew)(false) as GroundBatch; g.uv = []; g.kind = kind; g.layer = layer; C.groundBatches.set(key, g); }
    return g;
  }
  function buildSurfaces(C: Ctx, list: Surf[]) {
    const THREE = C.THREE;
    for (const s of list) {
      const all = s.ring.concat(...s.holes), zOf = (i: number) => (i < s.ring.length ? s.zs[i] : s.zAt(all[i][0], all[i][1])) + s.layer * 0.003;
      const tris = triangulate(THREE, s.ring, s.holes);
      if (!tris.length) { C.warn('surface ' + s.order + ': could not be triangulated'); continue; }
      const crossing = s.kind === 'crossing';
      if (!crossing) {
        const kind = (TEXTURED[s.kind] ? s.kind : 'paving') as GroundKind;
        const b = groundBatch(C, kind, s.layer), tile = TILE[kind];
        // the pattern runs along the surface: its own heading, or the direction most of its edges have
        const grain = kind === 'paving' || kind === 'cobble' ? (num(s.src.heading) != null ? (90 - s.src.heading!) * RAD : grainOf(s.ring)) : 0.4;
        const ca = Math.cos(grain), sa = Math.sin(grain), base = b.n;
        // what the surface is used for sets its tone: roads a shade darker, pavements and squares warmer
        const use = String(s.src.use || ''), P0 = C.pal, tint: RGB = [1, 1, 1];
        if (kind === 'asphalt') { // roads a clearly darker, cooler grey than the pavements beside them
          const want = /road|street|carriage|fahrbahn|lane/.test(use) ? P0.road : /pavement|sidewalk|footway|trottoir|island|insel|platform/.test(use) ? P0.pavement : P0.asphalt;
          for (let k = 0; k < 3; k++) tint[k] = Math.min(1, want[k] / Math.max(0.05, P0.pavement[k]));
        }
        const given = !C.dark && kind !== 'asphalt' && hex(s.src.color); // elsewhere a colour from the data shifts the tone a little
        if (given) { const want = mix(P0[kind], given, 0.15); for (let k = 0; k < 3; k++) tint[k] = Math.min(1, want[k] / Math.max(0.05, P0[kind][k])); }
        all.forEach((p, i) => {
          b.vert([p[0], p[1], zOf(i)], tint);
          b.uv.push((p[0] * ca + p[1] * sa) / tile, (-p[0] * sa + p[1] * ca) / tile);
        });
        for (const t of tris) {
          const A = all[t[0]], B = all[t[1]], D = all[t[2]];
          const cr = (B[0] - A[0]) * (D[1] - A[1]) - (B[1] - A[1]) * (D[0] - A[0]);
          if (Math.abs(cr) < 1e-9) continue;
          if (cr > 0) b.i.push(base + t[0], base + t[1], base + t[2]); else b.i.push(base + t[0], base + t[2], base + t[1]);
        }
      }
      for (const t of tris) {
        const P = (i: number): V3 => [all[i][0], all[i][1], zOf(i)];
        if (!crossing || C.ground.at(all[t[0]][0], all[t[0]][1]) == null) C.ground.add(P(t[0]), P(t[1]), P(t[2]), s.layer);
        if (!crossing) C.gtris.push([P(t[0]), P(t[1]), P(t[2]), s.layer]);
      }
      C.counts.surfaces++;
      // a skirt down from every edge: where the neighbour lies lower, the step has a face
      if (!crossing) {
        const col = tone(C.pal[(TEXTURED[s.kind] ? s.kind : 'paving') as GroundKind], C.dark ? 0.78 : 0.84), W = C.W.solid.world();
        const skirt = (r: XY[], zf: (i: number) => number, out: number) => {
          for (let i = 0; i < r.length; i++) {
            const a = r[i], b = r[(i + 1) % r.length], za = zf(i), zb = zf((i + 1) % r.length);
            const nx = (b[1] - a[1]) * out, ny = -(b[0] - a[0]) * out;
            W.quad([a[0], a[1], za], [b[0], b[1], zb], [b[0], b[1], zb - 0.4], [a[0], a[1], za - 0.4], col, { n: [nx, ny, 0] });
          }
        };
        skirt(s.ring, (i) => s.zs[i] + s.layer * 0.003, 1);
        s.holes.forEach((h) => skirt(h, (i) => s.zAt(h[i][0], h[i][1]) + s.layer * 0.003, -1));
      }
      if (s.kind === 'tram') rails(C, s);
      if (crossing) stripes(C, s);
    }
  }
  // a flat band along a line, lying on the ground (rails, markings): into the decal batch
  function band(C: Ctx, line: XY[], off: number, half: number, col: RGB, lift: number, mode?: Mode) {
    const W = C.W.decal.world(), fr = lineFrames(line, false);
    for (let i = 0; i + 1 < fr.length; i++) {
      const a = fr[i], b = fr[i + 1];
      const p = [offPt(a, off - half), offPt(b, off - half), offPt(b, off + half), offPt(a, off + half)].map((q): V3 => [q[0], q[1], groundZ(C, q[0], q[1]) + lift]);
      W.quad(p[0], p[1], p[2], p[3], col, { n: [0, 0, 1], mode });
    }
  }
  // split a line so no piece is longer than `step` (so bands follow sloping ground)
  function densify(line: XY[], step: number) {
    const out = [line[0]];
    for (let i = 0; i + 1 < line.length; i++) {
      const a = line[i], b = line[i + 1], k = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let j = 1; j <= k; j++) out.push([lerp(a[0], b[0], j / k), lerp(a[1], b[1], j / k)]);
    }
    return out;
  }
  // Where the rails of a tram-track surface run: its own centre line, else worked out from the outline
  function trackLine(s: Surf): TrackLine {
    const own = s.src.line && cleanLine(s.src.line);
    if (own) return { line: own, width: num(s.src.width) };
    const r = s.ring, n = r.length;
    if (n >= 4 && n % 2 === 0) { // a ribbon: the points of one side, then those of the other going back
      let best: (TrackLine & { len: number }) | null = null;
      for (let k = 0; k < n / 2; k++) {
        const mids: XY[] = [], ws: number[] = [];
        for (let i = 0; i < n / 2; i++) { const a = r[(k + i) % n], b = r[(k - 1 - i + 2 * n) % n]; mids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]); ws.push(Math.hypot(a[0] - b[0], a[1] - b[1])); }
        const wMin = Math.min(...ws), wMax = Math.max(...ws);
        let len = 0;
        for (let i = 0; i + 1 < mids.length; i++) len += Math.hypot(mids[i + 1][0] - mids[i][0], mids[i + 1][1] - mids[i][1]);
        if (wMin < 1 || wMax / wMin > 1.5 || len < wMax * 1.5) continue;
        if (!best || len > best.len) best = { line: mids, width: (wMin + wMax) / 2, len };
      }
      if (best) return best;
    }
    const ax = longAxis(r)!, vm = (ax.v0 + ax.v1) / 2;
    return { line: [[ax.ux * ax.u0 - ax.uy * vm, ax.uy * ax.u0 + ax.ux * vm], [ax.ux * ax.u1 - ax.uy * vm, ax.uy * ax.u1 + ax.ux * vm]], width: ax.wid };
  }
  function rails(C: Ctx, s: Surf) {
    const t = trackLine(s);
    if (!t || !t.line || t.line.length < 2) return;
    const line = densify(t.line, 3), width = t.width || 2.6, gauge = or(s.src.gauge, 1.0);
    const tracks = clamp(Math.round(or(s.src.tracks, width / 3.3)), 1, 4), pitch = width / tracks;
    const steel = C.pal.rail, groove = tone(C.pal.rail, C.dark ? 0.5 : 0.62), edge = mix(C.pal.tram, BLACK, C.dark ? 0.2 : 0.1);
    for (let k = 0; k < tracks; k++) {
      const c = (k - (tracks - 1) / 2) * pitch;
      for (const side of [-1, 1]) {
        const o = c + side * gauge / 2;
        band(C, line, o, 0.075, edge, 0.004);            // the joint of the rail in the paving
        band(C, line, o + side * 0.012, 0.03, steel, 0.006); // the head you see shine
        band(C, line, o - side * 0.028, 0.014, groove, 0.007); // the groove the flange runs in
      }
    }
  }
  // a pedestrian crossing: yellow bars (this is Switzerland), each as long as the crossing is wide
  function stripes(C: Ctx, s: Striped, colour?: RGB) {
    const dir = num(s.src.heading) != null ? (90 - s.src.heading!) * RAD : null;
    const ax = longAxis(s.ring, dir)!, W = C.W.decal.world(), col = colour || C.pal.marking;
    const n = Math.max(1, Math.floor((ax.len + 0.5) / 1)), start = ax.u0 + (ax.len - (n - 0.5)) / 2;
    for (let i = 0; i < n; i++) {
      const u0 = start + i, u1 = u0 + 0.5;
      // the part of the ring between u0 and u1 along the walking direction
      let poly = clipPoly(s.ring, ax.ux, ax.uy, -u0);
      poly = clipPoly(poly, -ax.ux, -ax.uy, u1);
      if (poly.length < 3) continue;
      for (const t of triangulate(C.THREE, poly)) {
        const P = (j: number): V3 => [poly[j][0], poly[j][1], groundZ(C, poly[j][0], poly[j][1], s.zAt(poly[j][0], poly[j][1])) + 0.006];
        W.tri(P(t[0]), P(t[1]), P(t[2]), col, { n: [0, 0, 1], mode: 1 });
      }
    }
  }
  // The plane that fits the street best: z = c + a·x + b·y. Surfaces with a height per point say how the street
  // lies; a stray point does not tip it. (The same fit the viewer makes; flatten: true takes this plane out.)
  function fitPlane(list: Surf[]): Plane {
    let S: V3[] = [];
    for (const s of list) if (Array.isArray(s.src.zs)) s.ring.forEach((p, i) => S.push([p[0], p[1], s.zs[i]]));
    if (S.length < 12) { S = []; for (const s of list) s.ring.forEach((p, i) => S.push([p[0], p[1], s.zs[i]])); }
    const mean = S.length ? S.reduce((m, q) => m + q[2], 0) / S.length : 0, flat = { a: 0, b: 0, c: mean };
    if (S.length < 12) return flat;
    let t = flat, use = S;
    for (let it = 0; it < 4 && use.length >= 12; it++) {
      const m = use.length;
      let mx = 0, my = 0, mz = 0, xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
      for (const q of use) { mx += q[0]; my += q[1]; mz += q[2]; }
      mx /= m; my /= m; mz /= m;
      for (const q of use) { const dx = q[0] - mx, dy = q[1] - my, dz = q[2] - mz; xx += dx * dx; xy += dx * dy; yy += dy * dy; xz += dx * dz; yz += dy * dz; }
      const det = xx * yy - xy * xy;
      if (!(Math.abs(det) > 1e-6)) return flat;
      const a = (xz * yy - yz * xy) / det, b = (yz * xx - xz * xy) / det;
      t = { a, b, c: mz - a * mx - b * my };
      use = S.filter((q) => Math.abs(q[2] - (t.c + t.a * q[0] + t.b * q[1])) < 0.6);
    }
    return isFinite(t.a + t.b + t.c) && Math.hypot(t.a, t.b) < 0.12 ? t : flat;
  }
  // The plain ground of the stretch, wherever the data has no surface: it carries on at the height of the nearest
  // street (under houses too), so nothing stands in the air and groundAt never answers with something far below.
  // Under the surfaces it lies a little lower, out of sight. Beyond the outline it fades out (opts.feather).
  function basePlate(C: Ctx, list: Surf[]) {
    const pts: V3[] = [];
    for (const s of list) s.ring.forEach((p, i) => pts.push([p[0], p[1], s.zs[i]]));
    C.fit = fitPlane(list);
    const gp = C.detail.groundPlane, gq = gp && gp.nearWalk && isFinite(gp.nearWalk.dzdx) ? gp.nearWalk : gp;
    if (gp && Array.isArray(gp.origin) && gq && isFinite(gq.z) && isFinite(gq.dzdx) && isFinite(gq.dzdy) && Math.hypot(gq.dzdx, gq.dzdy) < 0.12) C.fit = { a: gq.dzdx, b: gq.dzdy, c: gq.z - gq.dzdx * gp.origin[0] - gq.dzdy * gp.origin[1], given: true };
    if (pts.length) C.z0 = pts.reduce((m, q) => m + q[2], 0) / pts.length;
    const near = C.zNear = (x: number, y: number, low?: boolean) => {
      if (!pts.length) return C.z0;
      let d0 = Infinity, d1 = Infinity, d2 = Infinity, z0 = 0, z1 = 0, z2 = 0;
      for (let i = 0; i < pts.length; i++) {
        const p = pts[i], d = (p[0] - x) * (p[0] - x) + (p[1] - y) * (p[1] - y);
        if (d < d0) { d2 = d1; z2 = z1; d1 = d0; z1 = z0; d0 = d; z0 = p[2]; } else if (d < d1) { d2 = d1; z2 = z1; d1 = d; z1 = p[2]; } else if (d < d2) { d2 = d; z2 = p[2]; }
      }
      const w0 = 1 / (d0 + 0.5), w1 = d1 < Infinity ? 1 / (d1 + 0.5) : 0, w2 = d2 < Infinity ? 1 / (d2 + 0.5) : 0;
      // towards the lowest of the three: plain ground beside a road must not rise above it
      const avg = (z0 * w0 + z1 * w1 + z2 * w2) / (w0 + w1 + w2);
      return low ? 0.3 * avg + 0.7 * Math.min(z0, w1 ? z1 : z0, w2 ? z2 : z0) : avg;
    };
    const area = cleanRing(C.detail.area);
    if (!area) return;
    const W = C.W.solid.world(), col = C.pal.ground, box = boxOf(area), cell = C.high ? 3 : 4.5;
    // drawn: a little under the lowest street nearby (it must not rise above a road); answered by groundAt: the level between them
    const zb = (x: number, y: number): [drawn: number, open: number, level: number] => { const g = C.ground.at(x, y); return g != null ? [g - 0.25, 0, g - 0.02] : [near(x, y, true) - 0.02, 1, near(x, y)]; };
    for (let gx = Math.floor(box[0] / cell); gx * cell < box[2]; gx++) for (let gy = Math.floor(box[1] / cell); gy * cell < box[3]; gy++) {
      const x0 = gx * cell, y0 = gy * cell, x1 = x0 + cell, y1 = y0 + cell;
      let poly: XY[] | null = clipPoly(area, 1, 0, -x0);
      if (poly.length >= 3) poly = clipPoly(poly, -1, 0, x1);
      if (poly.length >= 3) poly = clipPoly(poly, 0, 1, -y0);
      if (poly.length >= 3) poly = clipPoly(poly, 0, -1, y1);
      poly = cleanRing(poly);
      if (!poly) continue;
      // p: where it is drawn (dipping under the surfaces); q: what groundAt answers (the level of the street)
      const V = poly.map((p): PlatePt => { const z = zb(p[0], p[1]); return { p: [p[0], p[1], z[0]], q: [p[0], p[1], z[2]], open: z[1] }; });
      for (const t of poly.length === 3 ? [[0, 1, 2]] : triangulate(C.THREE, poly)) {
        const a = V[t[0]], b = V[t[1]], c = V[t[2]];
        W.tri(a.p, b.p, c.p, col, { n: [0, 0, 1], mode: 1 });
        if (a.open || b.open || c.open) { C.base.add(a.q, b.q, c.q, -1); C.gtris.push([a.p, b.p, c.p, -1]); }
      }
    }
    // the rim: beyond the outline the ground fades to nothing, in the colour the viewer's ground has (featherColor);
    // featherInside: the last metres inside the outline already take on that colour
    const f = or(C.opts.feather, 5), fc = hex(C.opts.featherColor) || col, fi = or(C.opts.featherInside, 0);
    const lvl = (p: XY): V3 => { const g = C.ground.at(p[0], p[1]); return [p[0], p[1], (g != null ? g : near(p[0], p[1])) + (fi > 0 ? 0.03 : -0.02)]; };
    if (f > 0 || fi > 0) {
      const ring: XY[] = [];
      for (let i = 0; i < area.length; i++) { const a = area[i], q = area[(i + 1) % area.length], k = Math.max(1, Math.ceil(Math.hypot(q[0] - a[0], q[1] - a[1]) / 3)); for (let j = 0; j < k; j++) ring.push([lerp(a[0], q[0], j / k), lerp(a[1], q[1], j / k)]); }
      const fr = lineFrames(ring, true), b = C.feather, n = fr.length;
      const band = (d0: number, d1: number, a0: number, a1: number) => {
        const base = b.n;
        fr.forEach((q) => {
          const e = lvl(q.p), i0 = offPt(q, d0), i1 = offPt(q, d1);
          b.vert(d0 > 0 ? lvl(i0) : [i0[0], i0[1], e[2]], fc, a0); b.vert(d1 > 0 ? lvl(i1) : [i1[0], i1[1], e[2]], fc, a1);
        });
        for (let i = 0; i < n; i++) { const p = base + i * 2, q = base + ((i + 1) % n) * 2; b.i.push(p, p + 1, q + 1, p, q + 1, q, p, q + 1, p + 1, p, q, q + 1); }
      };
      if (fi > 0) { band(fi, fi * 0.45, 0, 0.6); band(fi * 0.45, 0, 0.6, 1); }
      if (f > 0) band(0, -f, 1, 0);
    }
  }
  // The shadows the sun casts on the ground, baked into one picture: every triangle that stands above the ground
  // is laid down along the sun's direction and filled into a canvas (a filled picture cannot darken a spot twice),
  // softened a little, and laid over the ground. Bare branches give branch shadows, crowns give blobs, houses a
  // band on the side away from the sun.
  function castShadows(C: Ctx, batches: Batch[]): Cast | null {
    const L = C.sun;
    if (L[2] < 0.2 || !C.gtris.length || typeof document === 'undefined') return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const t of C.gtris) for (let j = 0 as 0 | 1 | 2; j < 3; j++) { x0 = Math.min(x0, t[j][0]); y0 = Math.min(y0, t[j][1]); x1 = Math.max(x1, t[j][0]); y1 = Math.max(y1, t[j][1]); }
    if (C.castBox) { x0 = Math.max(x0, C.castBox[0]); y0 = Math.max(y0, C.castBox[1]); x1 = Math.min(x1, C.castBox[2]); y1 = Math.min(y1, C.castBox[3]); }
    const w = x1 - x0, hh = y1 - y0;
    if (!(w > 1 && hh > 1)) return null;
    const N = C.high ? 1792 : 896, k = N / Math.max(w, hh), cw = Math.max(8, Math.round(w * k)), ch = Math.max(8, Math.round(hh * k));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const g = cv.getContext('2d')!, kx = L[0] / L[2], ky = L[1] / L[2], cache = new Map<number, number>();
    const gz = (x: number, y: number) => {
      const key = Math.round(x * 2) * 100003 + Math.round(y * 2);
      let z: number | null | undefined = cache.get(key);
      if (z === undefined) { z = C.ground.at(x, y); if (z == null) z = C.base.at(x, y); if (z == null) z = C.zNear ? C.zNear(x, y) : C.z0; cache.set(key, z); }
      return z;
    };
    g.fillStyle = '#000';
    g.beginPath();
    let count = 0;
    const S = [0, 0, 0, 0, 0, 0];
    for (const b of batches) {
      const P = b.p, I = b.i;
      for (let i = 0; i + 2 < I.length; i += 3) {
        let up = false;
        { const q = I[i] * 3; if (P[q] < x0 - 40 || P[q] > x1 + 40 || P[q + 1] < y0 - 40 || P[q + 1] > y1 + 40) continue; } // too far to reach the picture
        for (let j = 0; j < 3; j++) {
          const q = I[i + j] * 3, x = P[q], y = P[q + 1], z = P[q + 2];
          let h = z - gz(x, y);
          if (h > 0.22) up = true;
          if (h < 0) h = 0;
          let sx = x - kx * h, sy = y - ky * h;
          if (h > 0.5) { const h2 = Math.max(0, z - gz(sx, sy)); sx = x - kx * h2; sy = y - ky * h2; } // onto the ground where it lands
          S[j * 2] = (sx - x0) * k; S[j * 2 + 1] = (y1 - sy) * k;
        }
        if (!up) continue;
        const ar = (S[2] - S[0]) * (S[5] - S[1]) - (S[3] - S[1]) * (S[4] - S[0]);
        if (Math.abs(ar) < 0.015) continue;
        g.moveTo(S[0], S[1]);
        if (ar > 0) { g.lineTo(S[2], S[3]); g.lineTo(S[4], S[5]); } else { g.lineTo(S[4], S[5]); g.lineTo(S[2], S[3]); } // one winding: overlaps add up to one area
        g.closePath();
        if (++count % 64 === 0) { g.fill(); g.beginPath(); } // small batches: a path of thousands of triangles fills very slowly
      }
    }
    g.fill();
    if (!count) return null;
    // soft edges: the picture laid over itself a few times, slightly moved
    const out = document.createElement('canvas');
    out.width = cw; out.height = ch;
    const o = out.getContext('2d')!, r = C.high ? 1.5 : 1.1, taps = [[0, 0], [r, 0], [-r, 0], [0, r], [0, -r], [r * 0.7, r * 0.7], [-r * 0.7, r * 0.7], [r * 0.7, -r * 0.7], [-r * 0.7, -r * 0.7]];
    o.globalCompositeOperation = 'lighter';
    o.globalAlpha = 1 / taps.length;
    for (const t of taps) o.drawImage(cv, t[0], t[1]);
    o.globalAlpha = 1;
    o.globalCompositeOperation = 'source-in';
    o.fillStyle = css(C.pal.shadow);
    o.fillRect(0, 0, cw, ch);
    o.globalCompositeOperation = 'destination-out'; // a clear rim: beyond the picture there is no shadow
    o.fillStyle = '#000';
    o.fillRect(0, 0, cw, 3); o.fillRect(0, ch - 3, cw, 3); o.fillRect(0, 0, 3, ch); o.fillRect(cw - 3, 0, 3, ch);
    return { canvas: out, x0, y0, w, h: hh, triangles: count };
  }
  // ---------- markings painted on the ground ----------
  // detail.markings: [{ kind: "bike-symbol" | "arrow", xy: [x, y], heading: 15, size: 1.8, color: "#…" },
  //                   { kind: "lane-line" | "stop-line", line: [[x, y], …], width: 0.12, dash: [1, 1], color: "#…" },
  //                   { kind: "crossing", ring: [[x, y], …], heading: 15, color: "#…" }]
  // heading: the way the traffic it speaks to moves (a symbol stands upright for someone coming that way).
  function buildMarking(C: Ctx, m: Marking) {
    const pal = C.pal, given = hex(m.color), col = given ? (C.dark ? mix(pal.marking, tone(given, 0.62), 0.6) : mix(given, hex('#EDE9DD')!, 0.12)) : pal.marking;
    const W = C.W.decal.world(), lift = 0.007, kind = String(m.kind || '');
    const P = (x: number, y: number): V3 => [x, y, groundZ(C, x, y) + lift];
    // a painted stroke along points, cut into short pieces so it follows the ground
    const stroke = (pts: XY[], width: number) => {
      for (let i = 0; i + 1 < pts.length; i++) {
        const a = pts[i], b = pts[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (l < 1e-4) continue;
        const nx = -(b[1] - a[1]) / l * width / 2, ny = (b[0] - a[0]) / l * width / 2, ex = (b[0] - a[0]) / l * width * 0.25, ey = (b[1] - a[1]) / l * width * 0.25;
        W.quad(P(a[0] - nx - ex, a[1] - ny - ey), P(b[0] - nx + ex, b[1] - ny + ey), P(b[0] + nx + ex, b[1] + ny + ey), P(a[0] + nx - ex, a[1] + ny - ey), col, { n: [0, 0, 1], mode: 1 });
      }
    };
    C.counts.markings = (C.counts.markings || 0) + 1;
    if (kind === 'crossing') {
      const ring = cleanRing(m.ring);
      if (ring) stripes(C, { ring, src: m, zAt: (x, y) => groundZ(C, x, y) }, col);
      return;
    }
    if (kind === 'lane-line' || kind === 'stop-line' || kind === 'line') {
      const line = cleanLine(m.line);
      if (!line) return;
      const width = or(m.width, kind === 'stop-line' ? 0.4 : 0.12), fine = densify(line, 1.5), dash = Array.isArray(m.dash) && m.dash[0] > 0 ? m.dash : null;
      if (!dash) { stroke(fine, width); return; }
      let s = 0;
      const period = dash[0] + (dash[1] || dash[0]);
      for (let i = 0; i + 1 < fine.length; i++) { // only the painted part of every period
        const a = fine[i], b = fine[i + 1], l = Math.hypot(b[0] - a[0], b[1] - a[1]);
        let t = 0;
        while (t < l - 1e-6) {
          const ph = (s + t) % period, on = ph < dash[0], step = Math.min(l - t, (on ? dash[0] : period) - ph);
          if (on) stroke([[lerp(a[0], b[0], t / l), lerp(a[1], b[1], t / l)], [lerp(a[0], b[0], (t + step) / l), lerp(a[1], b[1], (t + step) / l)]], width);
          t += step;
        }
        s += l;
      }
      return;
    }
    const xy = m.xy;
    if (!xy || !isFinite(xy[0]) || !isFinite(xy[1])) return;
    const h = or(m.heading, 0) * RAD, fx = Math.sin(h), fy = Math.cos(h), rx = Math.cos(h), ry = -Math.sin(h);
    if (kind === 'arrow') {
      const s = or(m.size, 2.2), T = (u: number, v: number): XY => [xy[0] + rx * u * s + fx * v * s, xy[1] + ry * u * s + fy * v * s];
      stroke(densify([T(0, -0.5), T(0, 0.12)], 0.6), 0.1 * s);
      const a = T(-0.17, 0.1), b = T(0.17, 0.1), c = T(0, 0.5);
      W.tri(P(a[0], a[1]), P(b[0], b[1]), P(c[0], c[1]), col, { n: [0, 0, 1], mode: 1 });
      return;
    }
    if (kind === 'bike-symbol' || kind === 'bike' || kind === 'bicycle') {
      // a bicycle seen from the side, lying on the road, stretched along the way you ride so it looks right from the saddle
      const s = or(m.size, 1.8), sx = s * 0.375, sy = s * 1.28, T = (u: number, v: number): XY => [xy[0] + rx * u * sx + fx * (v - 0.39) * sy, xy[1] + ry * u * sx + fy * (v - 0.39) * sy]; // size: its length along the way; 0.6 of that wide
      const wd = 0.045 * s, line = (pts: XY[]) => stroke(pts.map((q) => T(q[0], q[1])), wd);
      const wheel = (cx: number) => { const pts: XY[] = []; for (let k = 0; k <= 14; k++) { const a = (k / 14) * TAU; pts.push([cx + Math.cos(a) * 0.3, 0.2 + Math.sin(a) * 0.2]); } line(pts); };
      wheel(-0.5); wheel(0.5);
      line([[-0.5, 0.2], [-0.16, 0.6], [0.3, 0.6], [-0.04, 0.2], [-0.5, 0.2]]);   // the frame
      line([[-0.04, 0.2], [-0.2, 0.68]]);                                           // seat tube
      line([[-0.32, 0.7], [-0.1, 0.7]]);                                            // saddle
      line([[0.5, 0.2], [0.3, 0.6], [0.26, 0.74]]);                                 // fork and stem
      line([[0.14, 0.76], [0.36, 0.72]]);                                           // handlebar
    }
  }

  // ---------- edges: kerbs, ledges, walls, fences, railings, hedges, steps ----------
  // A solid strip along a line: a top, a face on each side down to the ground there, closed ends.
  // st[i] = { f: frame, top, gl, gr } with gl / gr the ground left and right. o: { w, top, face, arris, lip }
  function strip(C: Ctx, st: StripPt[], closed: boolean, o: StripOpt) {
    const W = C.W.solid.world(), n = st.length, h = o.w / 2;
    const L = st.map((s) => offPt(s.f, h)), R = st.map((s) => offPt(s.f, -h));
    const faceCols = [o.face, o.face, tone(o.face, 0.84), tone(o.face, 0.84)];
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const j = (i + 1) % n, a = st[i], b = st[j];
      const dx = b.f.p[0] - a.f.p[0], dy = b.f.p[1] - a.f.p[1], ln = [-dy, dx, 0];
      W.quad([R[i][0], R[i][1], a.top], [R[j][0], R[j][1], b.top], [L[j][0], L[j][1], b.top], [L[i][0], L[i][1], a.top], o.top, { n: [0, 0, 1] });
      if (o.walk && a.top - Math.min(a.gl, a.gr) < 0.3) { // low enough to step on: part of the ground
        const A: V3 = [R[i][0], R[i][1], a.top], B: V3 = [R[j][0], R[j][1], b.top], D: V3 = [L[j][0], L[j][1], b.top], E: V3 = [L[i][0], L[i][1], a.top];
        o.walk.push([A, B, D], [A, D, E]);
      }
      for (const side of [1, -1]) {
        const E = side > 0 ? L : R, ga = side > 0 ? a.gl : a.gr, gb = side > 0 ? b.gl : b.gr;
        if (a.top - ga < 0.012 && b.top - gb < 0.012) continue;
        const hint: V3 = [ln[0] * side, ln[1] * side, 0];
        W.quad([E[i][0], E[i][1], a.top], [E[j][0], E[j][1], b.top], [E[j][0], E[j][1], gb - 0.06], [E[i][0], E[i][1], ga - 0.06], faceCols, { n: hint });
        if (o.arris) { // the light edge that makes a low step readable from eye height
          const I = st.map((s) => offPt(s.f, side * (h - o.arris!)));
          W.quad([E[i][0], E[i][1], a.top + 0.002], [E[j][0], E[j][1], b.top + 0.002], [I[j][0], I[j][1], b.top + 0.002], [I[i][0], I[i][1], a.top + 0.002], o.arrisCol!, { n: [0, 0, 1] });
        }
        if (o.shadow) {
          const O = st.map((s) => offPt(s.f, side * (h + o.shadow!)));
          shadeStrip(C, [[E[i][0], E[i][1], ga], [E[j][0], E[j][1], gb]], [[O[i][0], O[i][1], ga], [O[j][0], O[j][1], gb]], o.shadowA || 1.3);
        }
      }
    }
    if (!closed) for (const e of [0, n - 1]) {
      const s = st[e], t = s.f.t, sign = e ? 1 : -1;
      W.quad([L[e][0], L[e][1], s.top], [R[e][0], R[e][1], s.top], [R[e][0], R[e][1], s.gr - 0.06], [L[e][0], L[e][1], s.gl - 0.06], o.face, { n: [t[0] * sign, t[1] * sign, 0] });
    }
  }
  function buildEdge(C: Ctx, e: StationDetailEdge) {
    const closed = !!e.closed, pts = cleanLine(e.line, closed);
    if (!pts) return;
    const pal = C.pal, kind = e.kind, ez = num(e.z);
    C.counts.edges++;
    if (kind === 'steps') return steps(C, e, pts);
    if (kind === 'fence' || kind === 'railing') return fence(C, e, pts, closed);
    if (kind === 'hedge') return hedge(C, e, pts, closed);
    const w = or(e.width, kind === 'kerb' ? 0.2 : kind === 'wall' ? 0.3 : 0.35);
    const hgt = or(e.height, kind === 'kerb' ? 0.12 : kind === 'wall' ? 1.0 : 0.4);
    // finer along the line, so the strip follows sloping ground
    const fr = lineFrames(closed ? pts : densify(pts, 4), closed);
    const st = fr.map((f) => {
      const l = offPt(f, w / 2 + 0.12), r = offPt(f, -w / 2 - 0.12);
      let gl = C.ground.at(l[0], l[1]), gr = C.ground.at(r[0], r[1]);
      if (gl == null && gr == null) gl = gr = ez != null ? ez : C.z0;
      else if (gl == null) gl = gr!; else if (gr == null) gr = gl;
      let top;
      if (kind === 'kerb') {
        if (Math.abs(gl - gr!) >= 0.02) top = Math.max(gl, gr!) + 0.004;       // a step in the ground: the kerb is its face
        else if (ez != null && Math.abs(ez - hgt - Math.min(gl, gr!)) < 0.035) top = ez; // z given as the top
        else top = Math.min(gl, gr!) + hgt;                                   // flat ground: a kerb stone standing on it
      } else top = (ez != null ? ez : Math.min(gl, gr!)) + hgt;
      return { f, top, gl: Math.min(gl, top), gr: Math.min(gr!, top) };
    });
    if (kind === 'kerb') {
      // the higher the step, the wider the dark line at its foot: that is what you see of it from the upper side
      const step = st.reduce((m, q) => Math.max(m, q.top - Math.min(q.gl, q.gr)), 0), c = pal.kerb;
      strip(C, st, closed, { w, top: mix(c, WHITE, C.dark ? 0.06 : 0.25), face: tone(c, C.dark ? 0.72 : 0.68), arris: Math.min(0.03, w * 0.3), arrisCol: mix(c, WHITE, C.dark ? 0.3 : 0.75), shadow: clamp(0.1 + 1.5 * step, 0.14, 0.42), shadowA: 1.8, walk: C.walk });
    } else if (kind === 'wall') {
      const c = pal.stone, capH = Math.min(0.09, hgt * 0.25);
      strip(C, st.map((s) => ({ f: s.f, top: s.top - capH, gl: s.gl, gr: s.gr })), closed, { w, top: c, face: tone(c, 0.94), shadow: 0.3, shadowA: 1.3 });
      strip(C, st.map((s) => ({ f: s.f, top: s.top, gl: s.top - capH, gr: s.top - capH })), closed, { w: w + 0.07, top: mix(c, WHITE, C.dark ? 0.1 : 0.4), face: mix(c, WHITE, C.dark ? 0.03 : 0.12), arris: 0.025, arrisCol: mix(c, WHITE, C.dark ? 0.3 : 0.8) });
    } else { // ledge, and anything unknown that has a line: a plain stone block
      const c = pal.stone;
      // the rim of a raised surface (the base of a monument): its top would lie in the plane of that surface and
      // flicker with it, so it stands 3 cm proud of it, as a lip all the way round
      if (st.filter((s) => s.top - Math.max(s.gl, s.gr) < 0.02).length * 2 >= st.length) for (const s of st) s.top += 0.03;
      strip(C, st, closed, { w, top: mix(c, WHITE, C.dark ? 0.08 : 0.3), face: tone(c, 0.9), arris: Math.min(0.03, w * 0.25), arrisCol: mix(c, WHITE, C.dark ? 0.3 : 0.8), shadow: 0.24, shadowA: 1.5, walk: C.walk });
    }
  }
  function steps(C: Ctx, e: StationDetailEdge, pts: XY[]) {
    const W = C.W.solid.world(), pal = C.pal, hgt = or(e.height, 0.48), width = or(e.width, Math.max(0.3, hgt / 0.16 * 0.3));
    const fr = lineFrames(pts, false), n = Math.max(1, Math.round(hgt / 0.165)), rh = hgt / n, td = width / n;
    // which way they climb: said in the data, else towards the higher ground, else to the left of the line
    let side = e.side === 'right' ? -1 : e.side === 'left' ? 1 : 0;
    if (!side) {
      const m = fr[Math.floor(fr.length / 2)], l = offPt(m, width + 0.3), r = offPt(m, -width - 0.3);
      const zl = C.ground.at(l[0], l[1]), zr = C.ground.at(r[0], r[1]);
      side = zl != null && zr != null && zr > zl + 0.05 ? -1 : 1;
    }
    const z0 = fr.map((f) => { const q = offPt(f, -side * 0.15); return num(e.z) != null ? e.z! : groundZ(C, q[0], q[1]); });
    const tread = mix(pal.stone, WHITE, C.dark ? 0.08 : 0.3), riser = tone(pal.stone, C.dark ? 0.8 : 0.8), nose = mix(pal.stone, WHITE, C.dark ? 0.3 : 0.8);
    const at = (i: number, k: number, z: number): V3 => { const q = offPt(fr[i], side * k * td); return [q[0], q[1], z0[i] + z]; };
    for (let i = 0; i + 1 < fr.length; i++) {
      const dx = fr[i + 1].p[0] - fr[i].p[0], dy = fr[i + 1].p[1] - fr[i].p[1], down: V3 = [dy * side, -dx * side, 0];
      for (let k = 0; k < n; k++) {
        W.quad(at(i, k, k * rh), at(i + 1, k, k * rh), at(i + 1, k, (k + 1) * rh), at(i, k, (k + 1) * rh), [tone(riser, 0.9), tone(riser, 0.9), riser, riser], { n: down });
        W.quad(at(i, k, (k + 1) * rh), at(i + 1, k, (k + 1) * rh), at(i + 1, k + 1, (k + 1) * rh), at(i, k + 1, (k + 1) * rh), tread, { n: [0, 0, 1] });
        const a = (ii: number): V3 => { const q = offPt(fr[ii], side * (k * td + 0.035)); return [q[0], q[1], z0[ii] + (k + 1) * rh + 0.002]; };
        W.quad([at(i, k, 0)[0], at(i, k, 0)[1], z0[i] + (k + 1) * rh + 0.002], [at(i + 1, k, 0)[0], at(i + 1, k, 0)[1], z0[i + 1] + (k + 1) * rh + 0.002], a(i + 1), a(i), nose, { n: [0, 0, 1] });
      }
      // walking on them: a ramp from the first to the last edge
      const A = at(i, 0, 0), B = at(i + 1, 0, 0), D = at(i + 1, n, hgt), E = at(i, n, hgt);
      C.ground.add(A, B, D, 9); C.ground.add(A, D, E, 9);
      const O = [offPt(fr[i], -side * 0.2), offPt(fr[i + 1], -side * 0.2)];
      shadeStrip(C, [[A[0], A[1], A[2]], [B[0], B[1], B[2]]], [[O[0][0], O[0][1], A[2]], [O[1][0], O[1][1], B[2]]], 1.2);
    }
    for (const i of [0, fr.length - 1]) { // the cheeks at both ends
      const t = fr[i].t, sign = i ? 1 : -1;
      for (let k = 0; k < n; k++) W.quad(at(i, k, -0.1), at(i, k + 1, -0.1), at(i, k + 1, (k + 1) * rh), at(i, k, (k + 1) * rh), tone(pal.stone, 0.9), { n: [t[0] * sign, t[1] * sign, 0] });
    }
  }
  function fence(C: Ctx, e: StationDetailEdge, pts: XY[], closed: boolean) {
    const W = C.W.solid.world(), pal = C.pal, rail = e.kind === 'railing';
    const hgt = or(e.height, rail ? 1.0 : 1.2), wood = /wood|picket|holz/i.test(e.variant || '');
    const col = wood ? pal.wood : pal.metal, light = mix(col, WHITE, C.dark ? 0.06 : 0.18);
    const posts = walkLine(pts, rail ? 1.5 : 2.2, closed);
    const zf = (p: XY) => (num(e.z) != null ? e.z! : groundZ(C, p[0], p[1]));
    const pw = wood ? 0.05 : rail ? 0.022 : 0.03;
    const list = closed ? posts.concat([Object.assign({}, posts[0])]) : posts;
    for (let i = 0; i < list.length; i++) {
      const a = list[i], za = zf(a.p);
      if (!(closed && i === list.length - 1)) {
        if (rail) W.cyl(a.p[0], a.p[1], za, za + hgt, pw, pw, 5, col);
        else W.box(a.p[0] - pw, a.p[1] - pw, za, a.p[0] + pw, a.p[1] + pw, za + hgt + (wood ? 0.06 : 0.1), col, { top: light });
        blob(C, a.p[0], a.p[1], 0.14, 0.14, 0, 0.9, za);
      }
      if (i + 1 >= list.length) continue;
      const b = list[i + 1], zb = zf(b.p);
      const dx = b.p[0] - a.p[0], dy = b.p[1] - a.p[1], l = Math.hypot(dx, dy);
      if (l < 1e-4) continue;
      const lat: V3 = [-dy / l, dx / l, 0];
      const bar = (z: number, th: number, tw: number, c: RGB) => W.obox([(a.p[0] + b.p[0]) / 2, (a.p[1] + b.p[1]) / 2, (za + zb) / 2 + z], [dx / 2, dy / 2, (zb - za) / 2], mul3(lat, tw), [0, 0, th], c, { skip: '+x-x' });
      if (rail) { bar(hgt, 0.028, 0.028, light); bar(hgt * 0.52, 0.016, 0.016, col); bar(0.12, 0.016, 0.016, col); }
      else {
        bar(hgt - 0.08, 0.025, wood ? 0.02 : 0.016, light); bar(0.18, 0.025, wood ? 0.02 : 0.016, col);
        const gap = wood ? 0.14 : C.high ? 0.13 : 0.26, k = Math.max(1, Math.round(l / gap)), half = wood ? 0.045 : 0.011;
        for (let j = 1; j < k + (wood ? 1 : 0); j++) {
          const f = (j - (wood ? 0.5 : 0)) / k, x = lerp(a.p[0], b.p[0], f), y = lerp(a.p[1], b.p[1], f), z = lerp(za, zb, f);
          const tx = dx / l * half, ty = dy / l * half, top = z + hgt + (wood ? 0.04 : 0.06);
          W.quad([x - tx, y - ty, z + 0.1], [x + tx, y + ty, z + 0.1], [x + tx, y + ty, top], [x - tx, y - ty, top], col, { two: true, n: lat });
        }
      }
    }
  }
  function leaf(C: Ctx, q: number) { // a leaf colour: 0 deep in the shade, 1 in the sun
    const p = C.pal;
    return q < 0.5 ? mix(p.crownDark, p.crown, smooth(0, 0.5, q)) : mix(p.crown, p.crownLight, smooth(0.5, 1, q));
  }
  function hedge(C: Ctx, e: StationDetailEdge, pts: XY[], closed: boolean) {
    const W = C.W.crown.world(), hgt = or(e.height, 1.1), w = or(e.width, 0.7), L = C.sun;
    const st = walkLine(pts, 0.7, closed), prof = [[-0.5, 0.0], [-0.53, 0.55], [-0.36, 0.92], [0, 1.02], [0.36, 0.92], [0.53, 0.55], [0.5, 0.0]];
    const base = W.b.n, m = prof.length, hc = C.pal.hedge;
    const rows = closed ? st.filter((s) => !s.last) : st;
    rows.forEach((s) => {
      const z = num(e.z) != null ? e.z! : groundZ(C, s.p[0], s.p[1]), lx = -s.t[1], ly = s.t[0];
      prof.forEach((q, k) => {
        const nz = noise3(s.p[0] * 1.7 + k, s.p[1] * 1.7, k * 0.6), d = 1 + (nz - 0.5) * 0.16;
        const P: V3 = [s.p[0] + lx * q[0] * w * d, s.p[1] + ly * q[0] * w * d, z + q[1] * hgt * (k === 0 || k === m - 1 ? 1 : d)];
        const n = norm([lx * q[0] * 2, ly * q[0] * 2, (q[1] - 0.45) * 1.6]);
        const t = sat(0.5 + 0.5 * dot(n, L)) * 0.6 + q[1] * 0.3 + (nz - 0.5) * 0.3;
        W.b.vert(P, W.shade(mix(hc, leaf(C, sat(t)), 0.6), n, P, 2));
      });
    });
    const nr = rows.length;
    for (let i = 0; i < (closed ? nr : nr - 1); i++) for (let k = 0; k + 1 < m; k++) {
      const a = base + i * m + k, b = base + ((i + 1) % nr) * m + k;
      W.b.i.push(a, b, b + 1, a, b + 1, a + 1);
    }
    if (!closed) for (const i of [0, nr - 1]) for (let k = 1; k + 1 < m; k++) { const a = base + i * m; if (i) W.b.i.push(a, a + k + 1, a + k); else W.b.i.push(a, a + k, a + k + 1); }
    const fr = lineFrames(pts, closed);
    for (const side of [1, -1]) shadeStrip(C, fr.map((f) => offPt(f, side * w * 0.5)), fr.map((f) => offPt(f, side * (w * 0.5 + 0.45))), 1.1, num(e.z), closed);
  }

  // ---------- trees ----------
  const GENUS: Record<string, [bright: number, hue: number]> = { aesculus: [-0.07, 0], tilia: [0.03, 0.3], platanus: [0.02, 0.5], acer: [0.04, 0.4], quercus: [-0.05, 0.1], fagus: [-0.02, 0.2], betula: [0.07, 0.6], carpinus: [-0.03, 0], fraxinus: [0.02, 0.2], robinia: [0.05, 0.5], prunus: [0.03, 0.3], ginkgo: [0.06, 0.7] };
  // a branch and what grows from it; env(p) says whether a point is still inside the crown
  function grow(W: Writer, C: Ctx, R: Rng, p: V3, d: V3, len: number, rad: number, depth: number, maxDepth: number, env: (p: V3) => boolean, col: RGB) {
    const side = norm(cross(d, Math.abs(d[2]) > 0.9 ? [1, 0, 0] : [0, 0, 1])), up = cross(side, d), bend = len * 0.09 * (R() - 0.5) * 2;
    const mid = [p[0] + d[0] * len * 0.5 + side[0] * bend, p[1] + d[1] * len * 0.5 + side[1] * bend, p[2] + d[2] * len * 0.5 + len * 0.03];
    const end = [p[0] + d[0] * len, p[1] + d[1] * len, p[2] + d[2] * len + len * 0.06];
    const sides = depth === 0 ? (C.high ? 6 : 5) : depth === 1 ? (C.high ? 5 : 4) : 3;
    const c = mix(col, C.pal.stone, Math.min(0.3, depth * 0.07));
    if (depth <= 1) W.tube([[p[0], p[1], p[2], rad], [mid[0], mid[1], mid[2], rad * 0.8], [end[0], end[1], end[2], rad * 0.6]], sides, c);
    else W.tube([[p[0], p[1], p[2], rad], [end[0], end[1], end[2], rad * 0.5]], sides, c);
    if (depth >= maxDepth || rad < 0.012) return;
    const kids = depth === 0 ? 3 : 2 + (C.high && R() < 0.45 ? 1 : 0);
    for (let i = 0; i < kids; i++) {
      const az = (i / kids) * TAU + R() * 1.6, tilt = i === 0 ? 0.16 + R() * 0.22 : 0.45 + R() * 0.45;
      const ca = Math.cos(az) * Math.sin(tilt), sa = Math.sin(az) * Math.sin(tilt), ct = Math.cos(tilt);
      const nd = norm([d[0] * ct + side[0] * ca + up[0] * sa, d[1] * ct + side[1] * ca + up[1] * sa, d[2] * ct + side[2] * ca + up[2] * sa + 0.16]);
      const f = i === 0 ? 1 : 0.45 + R() * 0.55, start: V3 = [lerp(mid[0], end[0], f), lerp(mid[1], end[1], f), lerp(mid[2], end[2], f)];
      let l2 = len * (0.62 + R() * 0.2);
      if (!env([start[0] + nd[0] * l2, start[1] + nd[1] * l2, start[2] + nd[2] * l2])) {
        l2 *= 0.55;
        if (!env([start[0] + nd[0] * l2, start[1] + nd[1] * l2, start[2] + nd[2] * l2])) continue;
      }
      grow(W, C, R, start, nd, l2, rad * (i === 0 ? 0.6 : 0.46), depth + 1, maxDepth, env, col);
    }
  }
  function buildTree(C: Ctx, t: StationDetailTree) {
    const xy = t.xy;
    if (!xy || !isFinite(xy[0]) || !isFinite(xy[1])) return;
    const x = +xy[0], y = +xy[1], R = rng(seedOf(x, y, 1)), pal = C.pal, L = C.sun;
    const z0 = num(t.z) != null ? t.z! : groundZ(C, x, y);
    const kind = t.kind === 'conifer' || t.kind === 'columnar' ? t.kind : 'broadleaf';
    const H = clamp(or(t.height, kind === 'columnar' ? 12 : 9), 1.5, 60);
    const cr = clamp(or(t.crown, H * (kind === 'conifer' ? 0.2 : kind === 'columnar' ? 0.13 : 0.32)), 0.4, 25);
    const age = num(t.planted) != null ? clamp(2026 - t.planted!, 3, 160) : null;
    const tr = clamp(or(t.trunk, age != null ? clamp(0.13 + age * 0.0029, 0.1, 0.5) : clamp(H * 0.022, 0.07, 0.5)), 0.03, 1.5);
    let cb = or(t.crownBase, kind === 'broadleaf' ? clamp(H * 0.3, 2.2, 5) : kind === 'conifer' ? clamp(H * 0.12, 0.8, 2.5) : clamp(H * 0.15, 1.5, 3));
    if (C.path && lineDist(C.path, x, y) < cr + 1.2) cb = Math.max(cb, C.clearance); // nothing hangs into the walk at eye height
    cb = clamp(cb, 0.3, H * 0.7);
    // the season of the scene wins over what the data says about one tree
    const leaves = C.season === 'summer' ? true : C.season === 'winter' ? false : t.leaves !== false;
    // pollarded: cut back every year to the same knuckles (form: "pollard" or pollarded: true in the data)
    const pollard = kind === 'broadleaf' && (C.opts.pollard != null ? !!C.opts.pollard : t.pollarded === true || /pollard|kopf|knob|knuckle/i.test(String(t.form || t.pruning || t.shape || t.variant || '')));
    const c = (H - cb) / 2, zc = (cb + H) / 2;
    const lx = (R() - 0.5) * 0.05 * H, ly = (R() - 0.5) * 0.05 * H;
    C.counts.trees++;

    // trunk: a wide foot, a slight taper and lean
    const W = C.W.solid.frame(x, y, z0, 0);
    const bark = mix(tone(pal.trunk, 0.94 + R() * 0.12), pal.stone, R() * 0.18), seg = C.high ? 8 : 6;
    const topZ = pollard ? cb + 0.1 : leaves ? cb + c * 0.7 : cb + c * 0.25;
    const tp: P4[] = [[0, 0, -0.15, tr * 1.5], [0, 0, 0.1, tr * 1.28], [0, 0, 0.55, tr * 1.03], [lx * 0.3, ly * 0.3, cb * 0.6, tr * 0.93], [lx * 0.6, ly * 0.6, cb - (pollard ? 0.5 : 0), tr * (pollard ? 0.9 : 0.84)], [pollard ? lx * 0.6 : lx, pollard ? ly * 0.6 : ly, topZ, tr * (pollard ? 0.95 : leaves ? 0.45 : 0.62)]];
    W.tube(tp, seg, bark, { cols: tp.map((p, i) => tone(bark, i < 2 ? 0.8 : i < 3 ? 0.9 : 1)), cap: true });
    blob(C, x, y, tr * 3.6, tr * 3.6, 0, 1.5, z0);
    const sh = norm([-L[0], -L[1], 0]), far = leaves ? 0.28 : 0.22;
    if (C.dark || !C.casts(x, y)) blob(C, x + sh[0] * cr * far, y + sh[1] * cr * far, cr * 1.05, cr * 1.05, 0, leaves ? (C.dark ? 0.55 : 1.0) : pollard ? 0.62 : 0.42, z0);

    const env = (p: V3) => { const dx = (p[0] - lx) / cr, dy = (p[1] - ly) / cr, dz = (p[2] - zc) / (c * 1.03); return dx * dx + dy * dy + dz * dz <= 1; };
    const limbs = (n: number, maxDepth: number, len0: number) => {
      for (let i = 0; i < n; i++) {
        const az = (i / n) * TAU + R() * 0.9, tilt = 0.5 + R() * 0.4, zs = cb - 0.45 + R() * Math.min(1.0, c * 0.4);
        const d: V3 = [Math.cos(az) * Math.sin(tilt), Math.sin(az) * Math.sin(tilt), Math.cos(tilt)];
        grow(W, C, R, [lx * 0.6, ly * 0.6, zs], d, len0 * (0.85 + R() * 0.3), tr * 0.5, 0, maxDepth, env, bark);
      }
    };
    // a tint per tree and species, so a row of trees is not a row of copies
    const g = GENUS[String(t.species || '').split(' ')[0].toLowerCase()] || [0, R()];
    const bright = 1 + g[0] + (R() - 0.5) * 0.07, warm = hex(C.dark ? '#3D4A2C' : '#C8D989')!, cool = hex(C.dark ? '#254036' : '#93CDA4')!, hue = (g[1] - 0.5) * 0.3;
    const tint = (col: RGB) => tone(mix(col, hue > 0 ? warm : cool, Math.abs(hue)), bright);
    const WC = C.W.crown.frame(x, y, z0, 0), amp = C.high ? 0.11 : 0.08;
    const lobe = (cx: number, cy: number, cz: number, rx: number, rz: number, bias: number, coneCol?: RGB | null, ff?: number) => {
      const s = seedOf(x + cx, y + cy, Math.round(cz * 10));
      bias += ((s % 1000) / 1000 - 0.5) * 0.2; // every lobe its own tone, so the crown reads as a cluster
      WC.lump([cx, cy, cz], [rx, rx, rz], C.far ? 1 : C.high ? ff || C.lobeF : Math.min(2, ff || C.lobeF), amp, s, (P, n) => {
        const hz = sat((P[2] - z0 - cb) / (H - cb)), rim = sat(Math.hypot(P[0] - x - lx, P[1] - y - ly) / cr);
        const sun = C.dark ? 0.5 + 0.3 * n[2] : sat(0.5 + 0.5 * dot(n, L));
        // lighter towards the sun, the top and the outside of the crown; deep inside and underneath it is dark
        let q = 0.44 * sun + 0.3 * hz + 0.2 * rim * rim + bias + (noise3(P[0] * 0.8, P[1] * 0.8, P[2] * 0.8) - 0.5) * 0.24;
        if (n[2] < 0) q += 0.16 * n[2];
        const cl = q < 0 ? tone(pal.crownDark, 1 + Math.max(-0.5, q) * 0.36) : leaf(C, sat(q));
        return tint(coneCol ? mix(cl, coneCol, 0.6) : cl);
      }, 2);
    };
    if (pollard) {
      // A pollarded tree: a boss on the trunk, a few stout kinked limbs that fork, a knuckle at every end;
      // from the knuckles the thin shoots of one year (or, in summer, a tuft of leaves).
      const shoot = Math.min(1.05, (H - cb) * 0.27), top = H - shoot * 0.8, nL = C.high ? 5 : 4, heads: P4[] = [], a0 = R() * TAU, bx = lx * 0.6, by = ly * 0.6;
      const tl = Math.max(tr, lerp(tr, 0.34, 0.5)); // limbs and knuckles thin out more slowly than the trunk on a young tree
      const knob = (p: V3, r: number, show?: boolean) => { if (show || !leaves) W.lump(p, [r, r, r * 1.08], C.high ? 2 : 1, 0.34, seedOf(x + p[0], y + p[1], 7), () => tone(bark, 0.88)); heads.push([p[0], p[1], p[2], r]); };
      const limb = (a: V3, b: V3, r0: number, r1: number, sides: number) => {
        const k = Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.22, m = [lerp(a[0], b[0], 0.55) + (R() - 0.5) * k, lerp(a[1], b[1], 0.55) + (R() - 0.5) * k, lerp(a[2], b[2], 0.34)];
        W.tube([[a[0], a[1], a[2], r0], [m[0], m[1], m[2], lerp(r0, r1, 0.55)], [b[0], b[1], b[2], r1]], sides, bark);
      };
      W.lump([bx, by, cb - 0.12], [tr * 1.12, tr * 1.12, tr * 0.95], C.high ? 2 : 1, 0.2, seedOf(x, y, 8), () => tone(bark, 0.94));
      for (let i = 0; i < nL; i++) {
        const az = a0 + (i / nL) * TAU + (R() - 0.5) * 0.6, reach = cr * (0.4 + R() * 0.2), rise = (top - cb) * (0.18 + R() * 0.34);
        const p2: V3 = [bx + Math.cos(az) * reach, by + Math.sin(az) * reach, cb + rise];
        limb([bx, by, cb - 0.4], p2, Math.min(tr * 0.8, tl * 0.66), tl * 0.5, C.high ? 6 : 5);
        knob(p2, tl * 0.7, true); // in summer only these lower knuckles show under the leaves
        const arms = C.high ? 2 + (R() < 0.4 ? 1 : 0) : 1 + (R() < 0.5 ? 1 : 0);
        for (let a = 0; a < arms; a++) {
          const az2 = az + (arms === 1 ? 0 : (a / (arms - 1) - 0.5) * (1.3 + R() * 0.5)) + (R() - 0.5) * 0.35, r2 = Math.min(cr, reach + cr * (0.26 + R() * 0.3));
          const e: V3 = [bx + Math.cos(az2) * r2, by + Math.sin(az2) * r2, Math.min(top, p2[2] + (top - p2[2]) * (0.3 + R() * 0.7))];
          limb(p2, e, tl * 0.42, tl * 0.3, C.high ? 5 : 4);
          knob(e, tl * 0.55);
          if (leaves && C.high) heads.push([(p2[0] + e[0]) / 2, (p2[1] + e[1]) / 2, (p2[2] + e[2]) / 2, 0]); // in summer leaves along the limb too
        }
      }
      const pt: V3 = [bx + (R() - 0.5) * cr * 0.25, by + (R() - 0.5) * cr * 0.25, top];
      limb([bx, by, cb - 0.2], pt, Math.min(tr * 0.8, tl * 0.6), tl * 0.34, C.high ? 6 : 5);
      knob(pt, tl * 0.58);
      const twig = mix(bark, pal.stone, 0.25);
      for (const hd of heads) {
        if (leaves) { const r = shoot * 0.95 + (hd[3] ? 0.6 : 0.45); lobe(hd[0], hd[1], hd[2] + r * 0.28, r, r * 0.85, (R() - 0.5) * 0.1, null, 2); continue; }
        const n = C.far ? 0 : C.high ? 8 : 4, ox = hd[0] - bx, oy = hd[1] - by, ol = Math.hypot(ox, oy) || 1; // shoots are too thin to see from afar
        for (let k = 0; k < n; k++) {
          const az = R() * TAU, tilt = 0.04 + R() * 0.46, l = shoot * (0.35 + R() * 0.65);
          const d = norm([Math.cos(az) * Math.sin(tilt) + ox / ol * 0.14, Math.sin(az) * Math.sin(tilt) + oy / ol * 0.14, Math.cos(tilt)]), s = hd[3] * 0.55;
          W.tube([[hd[0] + d[0] * s, hd[1] + d[1] * s, hd[2] + d[2] * s, 0.015], [hd[0] + d[0] * (s + l), hd[1] + d[1] * (s + l), hd[2] + d[2] * (s + l), 0.004]], 3, twig);
        }
      }
      if (leaves) lobe(bx, by, cb + (top - cb) * 0.5, cr * 0.72, (H - cb) * 0.42, -0.15);
      return;
    }
    if (!leaves) {
      // a winter tree: limbs, branches, twigs
      const depth = C.far ? 1 : C.high ? 3 : 2;
      limbs(kind === 'columnar' ? 3 : C.high ? 5 : 4, depth, kind === 'columnar' ? c * 0.5 : 0.36 * (cr + c));
      grow(W, C, R, [lx, ly, topZ - 0.4], norm([lx * 0.02, ly * 0.02, 1]), c * 0.75, tr * 0.6, 0, depth, env, bark);
      return;
    }
    if (kind === 'conifer') {
      // tiers of drooping skirts, one above the other
      const n = C.high ? 6 : 4, segs = C.high ? 12 : 8, th = (H - cb) / n * 1.9, cc = pal.conifer;
      for (let i = 0; i < n; i++) {
        const zb = cb + (H - cb) * (i / n) * 0.9, r = cr * (1 - (i / n) * 0.8), zt = Math.min(H, zb + th), base = WC.b.n;
        const colAt = (P: V3, nn: V3) => {
          const sun = C.dark ? 0.5 : sat(0.5 + 0.5 * dot(nn, L));
          return tint(mix(leaf(C, sat(0.2 + 0.5 * sun + 0.25 * i / n)), cc, 0.65));
        };
        const apex = WC.P([lx, ly, zt]);
        WC.b.vert(apex, WC.shade(colAt(apex, [0, 0, 1]), [0, 0, 1], apex, 2));
        for (let k = 0; k < segs; k++) {
          const a = (k / segs) * TAU + i * 0.5, rr = r * (k % 2 ? 0.84 : 1), P = WC.P([lx + Math.cos(a) * rr, ly + Math.sin(a) * rr, zb + (k % 2 ? th * 0.1 : 0)]);
          const nn = norm([Math.cos(a) * th, Math.sin(a) * th, r]);
          WC.b.vert(P, WC.shade(tone(colAt(P, nn), 0.9), nn, P, 2));
        }
        const under = WC.P([lx, ly, zb + th * 0.3]), ui = WC.b.vert(under, WC.shade(tone(tint(pal.crownDark), 0.8), [0, 0, -1], under, 2));
        for (let k = 0; k < segs; k++) { const k1 = (k + 1) % segs; WC.b.i.push(base, base + 1 + k, base + 1 + k1, ui, base + 1 + k1, base + 1 + k); }
      }
      return;
    }
    limbs(C.high ? 4 : 3, 0, Math.min(0.62 * cr, 0.9 * c));
    if (kind === 'columnar') {
      const n = Math.max(3, Math.round((H - cb) / (cr * 2.2)));
      for (let i = 0; i < n; i++) {
        const k = i === n - 1 ? 0.78 : 0.9 + R() * 0.14, rz = (H - cb) / n * 0.78;
        lobe(lx + (R() - 0.5) * cr * 0.2, ly + (R() - 0.5) * cr * 0.2, cb + (H - cb) * (i + 0.5) / n, cr * k, rz, -0.06);
      }
      return;
    }
    // broadleaf: a core, a ring of lobes around it, a few on top
    lobe(lx, ly, zc + 0.05 * c, cr * 0.62, c * 0.8, -0.12);
    const nr = C.high ? 5 : 4, a0 = R() * TAU;
    for (let i = 0; i < nr; i++) {
      const a = a0 + (i / nr) * TAU + (R() - 0.5) * 0.5, d = cr * 0.46 * (0.86 + R() * 0.22), r = cr * 0.52 * (0.88 + R() * 0.22), rz = Math.min(c * 0.64, r * 0.92);
      lobe(lx + Math.cos(a) * d, ly + Math.sin(a) * d, Math.max(cb + rz + 0.05, zc - 0.3 * c + (R() - 0.5) * 0.25 * c), r, rz, -0.05);
    }
    const nt = C.high ? 3 : 2, a1 = R() * TAU;
    for (let i = 0; i < nt; i++) {
      const a = a1 + (i / nt) * TAU, d = cr * 0.24, r = cr * 0.5 * (0.9 + R() * 0.2);
      lobe(lx + Math.cos(a) * d, ly + Math.sin(a) * d, zc + 0.42 * c, r, Math.min(c * 0.52, r), 0.05);
    }
  }

  // ---------- props ----------
  // Where a prop gives light at night: [{ at: [x, y, z] in its own frame, reach, power, glow }]
  function lightsOf(p: Prop): PropLight[] {
    const v = String(p.variant || '').toLowerCase();
    if (p.kind === 'lamp') {
      const hung = /wire|hung|hang|suspend|catenary|seil|pendant|cable/.test(v), wall = /wall|bracket|wand/.test(v), lantern = /lantern|historic|laterne|candelabr/.test(v);
      const H = or(p.height, hung ? 7 : wall ? 3.4 : lantern ? 3.6 : 4.5);
      if (hung) return [{ at: [0, 0, H - 0.08], reach: Math.max(H * 2.4, 16), power: 1.1, glow: 1.15 }];
      if (wall) return [{ at: [0, 0.55, H - 0.2], reach: H * 2.2, power: 0.9, glow: 0.9 }];
      if (lantern) return [{ at: [0, 0, H - 0.26], reach: H * 2.4, power: 1, glow: 1 }];
      const reach = clamp(or(p.length, H * 0.2), 0.5, 1.6), dirs = /double|twin|zwei/.test(v) ? [1, -1] : [1];
      return dirs.map((d) => ({ at: [0, d * (reach + 0.22), H - 0.07], reach: H * 2.3, power: 1, glow: 1 }));
    }
    if (p.kind === 'shelter') return [{ at: [0, 0.1, or(p.height, 2.5) - 0.08], reach: 5.5, power: 0.75, glow: 0 }];
    return [];
  }
  const PROPS: Partial<Record<StationDetailProp['kind'], PropFn>> = {};
  PROPS.bench = function (C, p, W, R) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase();
    const back = !/backless|no-?back|without|flat|ohne|hocker|block|stone/.test(v), stone = /stone|block|stein|concrete|beton/.test(v);
    const L = or(p.length, 1.8), D = or(p.width, 0.5), ht = back ? clamp(or(p.height, 0.84), 0.7, 1.1) : 0, hs = back ? 0.45 : clamp(or(p.height, 0.45), 0.3, 0.7);
    const M = pal.metal, wood = pal.wood;
    if (stone) W.box(-L / 2 + 0.04, -D / 2 + 0.03, 0, L / 2 - 0.04, D / 2 - 0.03, hs - 0.04, pal.stone, { top: mix(pal.stone, WHITE, 0.2) });
    else for (const sx of [-1, 1]) {
      const fx = sx * (L / 2 - 0.22);
      W.box(fx - 0.025, D / 2 - 0.09, 0, fx + 0.025, D / 2 - 0.04, hs - 0.04, M);
      W.box(fx - 0.025, -D / 2 + 0.04, 0, fx + 0.025, -D / 2 + 0.09, hs - 0.04, M);
      W.box(fx - 0.025, -D / 2 + 0.04, hs - 0.085, fx + 0.025, D / 2 - 0.04, hs - 0.04, M, { bottom: true });
    }
    const n = 4, gap = 0.016, sw = (D - gap * (n - 1)) / n;
    for (let i = 0; i < n; i++) {
      const c = tone(wood, 0.95 + R() * 0.1), y0 = -D / 2 + i * (sw + gap);
      W.box(-L / 2, y0, hs - 0.036, L / 2, y0 + sw, hs, c, { top: mix(c, WHITE, C.dark ? 0.04 : 0.14), bottom: true });
    }
    if (back) {
      const ta = 14 * RAD, dir: V3 = [0, -Math.sin(ta), Math.cos(ta)], nr: V3 = [0, Math.cos(ta), Math.sin(ta)], y0 = -D / 2 + 0.03, len = (ht - hs) / Math.cos(ta);
      if (!stone) for (const sx of [-1, 1]) {
        const fx = sx * (L / 2 - 0.22);
        W.obox([fx, y0 + dir[1] * len / 2 - 0.02, hs - 0.04 + dir[2] * len / 2], [0.025, 0, 0], mul3(nr, 0.02), mul3(dir, len / 2 + 0.02), M);
      }
      const ns = len > 0.33 ? 3 : 2, sh = Math.min(0.055, (len - 0.08) / ns / 2 - 0.008);
      for (let i = 0; i < ns; i++) {
        const d = len - sh - i * (sh * 2 + 0.02), c = tone(wood, 0.95 + R() * 0.1);
        W.obox([0, y0 + dir[1] * d + nr[1] * 0.02, hs - 0.04 + dir[2] * d + nr[2] * 0.02], [L / 2, 0, 0], mul3(nr, 0.016), mul3(dir, sh), c, { top: mix(c, WHITE, C.dark ? 0.03 : 0.1) });
      }
    }
    return { rx: L / 2 + 0.16, ry: D / 2 + 0.2, a: 1.15 };
  };
  PROPS.lamp = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), M = pal.metal, ML = mix(M, WHITE, C.dark ? 0.08 : 0.2), lens = pal.lens;
    const hung = /wire|hung|hang|suspend|catenary|seil|pendant|cable/.test(v), wall = /wall|bracket|wand/.test(v), lantern = /lantern|historic|laterne|candelabr/.test(v);
    const H = or(p.height, hung ? 7 : wall ? 3.4 : lantern ? 3.6 : 4.5), on = C.dark;
    const lensCol = on ? lens : mix(lens, pal.steel, 0.25);
    if (hung) {
      // a light hung on a wire across the street; the wire runs across the heading
      const span = or(p.length, 14), path: P4[] = [], sp = p._span;
      if (sp) { // from house to house, as the span wires of the trams are
        const o = W.o, top = W.P([0, 0, H + 0.28]);
        W.world();
        for (const e of [sp.a, sp.b]) {
          const pts: P4[] = [];
          for (let i = 0; i <= 6; i++) { const u = i / 6; pts.push([lerp(top[0], e[0], u), lerp(top[1], e[1], u), top[2] + (e[2] - top[2]) * u * u, 0.012]); }
          W.tube(pts, 3, tone(M, 0.8));
        }
        W.o = o;
      } else {
        for (let i = -5; i <= 5; i++) { const u = i / 5; path.push([u * span / 2, 0, H + 0.28 + 0.5 * u * u, 0.011]); }
        W.tube(path, 3, tone(M, 0.8));
      }
      W.cyl(0, 0, H + 0.1, H + 0.3, 0.012, 0.012, 4, M);
      W.lathe(0, 0, H - 0.1, [[0.3, 0, ML], [0.11, 0.14, ML], [0.05, 0.2, M], [0, 0.21, M]], C.high ? 12 : 8, ML, { facet: false });
      const pts: V3[] = [];
      for (let k = 0; k < 10; k++) pts.push([Math.cos(k / 10 * TAU) * 0.27, Math.sin(k / 10 * TAU) * 0.27, H - 0.1]);
      W.fan(pts, lensCol, { n: [0, 0, -1], mode: 1 });
      return null;
    }
    if (wall) {
      const path: P4[] = [];
      for (let k = 0; k <= 5; k++) { const a = (k / 5) * Math.PI / 2; path.push([0, 0.55 * Math.sin(a), H + 0.25 * (1 - Math.cos(a)) - 0.0, 0.02]); }
      W.tube(path, 4, M);
      W.box(-0.1, -0.02, H - 0.18, 0.1, 0.02, H + 0.12, M);
      W.box(-0.11, 0.44, H - 0.38, 0.11, 0.66, H - 0.1, lensCol, { mode: 1, bottom: true });
      W.lathe(0, 0.55, H - 0.1, [[0.19, 0], [0.04, 0.14], [0, 0.15]], 4, M, { phase: Math.PI / 4 });
      return null;
    }
    const seg = C.high ? 10 : 6;
    W.lathe(0, 0, 0, [[0.105, 0], [0.105, 0.05], [0.08, 0.09], [0.075, 0.95], [0.058, 1.0]], seg, tone(M, 0.92), { facet: false });
    if (lantern) {
      W.cyl(0, 0, 1.0, H - 0.55, 0.055, 0.045, seg, M);
      W.lathe(0, 0, H - 0.55, [[0.045, 0], [0.11, 0.06], [0.11, 0.1]], 6, M);
      W.lathe(0, 0, H - 0.45, [[0.1, 0], [0.17, 0.36]], 6, lensCol, { mode: 1 });
      W.lathe(0, 0, H - 0.09, [[0.2, 0], [0.2, 0.03], [0.05, 0.2], [0, 0.26]], 6, M);
      return { rx: 0.22, ry: 0.22, a: 1.2 };
    }
    W.cyl(0, 0, 1.0, H - 0.4, 0.058, 0.04, seg, M, { col1: ML });
    const reach = clamp(or(p.length, H * 0.2), 0.5, 1.6), dirs = /double|twin|zwei/.test(v) ? [1, -1] : [1];
    for (const d of dirs) {
      const path: P4[] = [];
      for (let k = 0; k <= 6; k++) { const a = (k / 6) * Math.PI / 2; path.push([0, d * reach * (1 - Math.cos(a)), H - 0.4 + 0.4 * Math.sin(a), lerp(0.04, 0.03, k / 6)]); }
      W.tube(path, C.high ? 6 : 4, ML);
      const cy = d * (reach + 0.2);
      W.obox([0, cy, H - 0.012], [0.12, 0, 0], [0, 0.3, 0], [0, 0, 0.035], M, { top: ML, skip: '-z' });
      W.quad([-0.12, cy - 0.3, H - 0.047], [0.12, cy - 0.3, H - 0.047], [0.12, cy + 0.3, H - 0.047], [-0.12, cy + 0.3, H - 0.047], tone(M, 0.8), { n: [0, 0, -1] });
      W.quad([-0.09, cy - 0.25, H - 0.05], [0.09, cy - 0.25, H - 0.05], [0.09, cy + 0.25, H - 0.05], [-0.09, cy + 0.25, H - 0.05], lensCol, { n: [0, 0, -1], mode: 1 });
    }
    return { rx: 0.22, ry: 0.22, a: 1.2 };
  };
  PROPS.bollard = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), h = or(p.height, 0.9), r = or(p.width, 0.16) / 2;
    if (/stone|stein|granit/.test(v)) {
      const q = Math.max(r, 0.13) * 1.3;
      W.lathe(0, 0, 0, [[q * 1.15, 0], [q * 1.15, 0.08], [q, 0.1], [q * 0.86, h - 0.1], [q * 0.5, h, mix(pal.stone, WHITE, 0.25)], [0, h + 0.02, mix(pal.stone, WHITE, 0.25)]], 4, pal.stone, { phase: Math.PI / 4 });
      return { rx: q * 1.6, ry: q * 1.6, a: 1.2 };
    }
    const M = pal.metal, band = mix(pal.steel, WHITE, C.dark ? 0.1 : 0.45);
    W.lathe(0, 0, 0, [[r + 0.02, 0], [r + 0.02, 0.04], [r, 0.06], [r, h - 0.24], [r + 0.006, h - 0.235, band], [r + 0.006, h - 0.14, band], [r, h - 0.135], [r, h - 0.05], [r * 0.62, h, mix(M, WHITE, 0.15)], [0, h + 0.012, mix(M, WHITE, 0.15)]], C.high ? 10 : 6, M, { facet: false });
    return { rx: r * 2.6, ry: r * 2.6, a: 1.2 };
  };
  PROPS.bin = function (C, p, W) {
    // the Swiss street bin: a steel cylinder with a slanted mouth
    const pal = C.pal, h = or(p.height, 0.95), r = or(p.width, 0.44) / 2, S = pal.steel, seg = C.high ? 14 : 8;
    if (/recycl|sammel|trenn/.test(String(p.variant || '').toLowerCase())) {
      // a recycling station: three bins side by side, a coloured lid each
      const lids = [pal.sign, pal.marking, pal.hydrant], w = 0.52;
      for (let i = 0; i < 3; i++) {
        const x0 = (i - 1.5) * w;
        W.box(x0 + 0.02, -0.26, 0.05, x0 + w - 0.02, 0.26, 1.02, tone(S, 0.94), { top: S });
        W.box(x0, -0.28, 1.02, x0 + w, 0.28, 1.12, lids[i], { top: mix(lids[i], WHITE, C.dark ? 0.05 : 0.2), bottom: true });
        W.quad([x0 + 0.12, 0.262, 0.74], [x0 + w - 0.12, 0.262, 0.74], [x0 + w - 0.12, 0.262, 0.9], [x0 + 0.12, 0.262, 0.9], tone(pal.metal, 0.3), { n: [0, 1, 0] });
      }
      return { rx: 1.0, ry: 0.5, a: 1.2 };
    }
    W.cyl(0, 0, 0, 0.07, r * 0.5, r * 0.5, 6, tone(pal.metal, 0.8));
    W.cyl(0, 0, 0.07, h * 0.8, r, r, seg, tone(S, 0.92), { col1: S });
    const base = W.b.n, zt = (a: number) => h * 0.9 - h * 0.1 * Math.sin(a), pts: V3[] = [];
    for (let k = 0; k <= seg; k++) {
      const a = (k / seg) * TAU, ca = Math.cos(a), sa = Math.sin(a), n = W.N([ca, sa, 0]);
      W.emit(W.P([ca * r, sa * r, h * 0.8]), n, S);
      W.emit(W.P([ca * r, sa * r, zt(a)]), n, mix(S, WHITE, C.dark ? 0.05 : 0.2));
      if (k < seg) pts.push([ca * r, sa * r, zt(a)]);
    }
    for (let k = 0; k < seg; k++) { const a = base + k * 2; W.b.i.push(a, a + 2, a + 3, a, a + 3, a + 1); }
    W.fan(pts, tone(pal.metal, 0.45), { n: [0, 0.3, 1] });
    W.fan(pts.map((q): V3 => [q[0] * 0.55, q[1] * 0.55 + r * 0.12, lerp(zt(Math.PI / 2), q[2], 0.55) + 0.003]), tone(pal.metal, 0.22), { n: [0, 0.3, 1] });
    return { rx: r * 1.5, ry: r * 1.5, a: 1.25 };
  };
  PROPS['bike-stand'] = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), h = or(p.height, 0.8), S = pal.steel, sides = C.high ? 5 : 4;
    const hoop = (cx: number, cy: number, l: number, alongX: boolean) => {
      const path: P4[] = [], rc = 0.13, P = (u: number, z: number): P4 => (alongX ? [cx + u, cy, z, 0.022] : [cx, cy + u, z, 0.022]);
      path.push(P(-l / 2, -0.05), P(-l / 2, h - rc));
      for (let k = 1; k <= 3; k++) { const a = (k / 3) * Math.PI / 2; path.push(P(-l / 2 + rc * (1 - Math.cos(a)), h - rc + rc * Math.sin(a))); }
      for (let k = 2; k >= 0; k--) { const a = (k / 3) * Math.PI / 2; path.push(P(l / 2 - rc * (1 - Math.cos(a)), h - rc + rc * Math.sin(a))); }
      path.push(P(l / 2, -0.05));
      W.tube(path, sides, S);
    };
    const cap = num(p.capacity), row = /row|reihe|rack/.test(v) || or(p.length, 0) >= 1.6 || cap! > 2;
    if (!row) { hoop(0, 0, or(p.length, 0.8), true); return { rx: or(p.length, 0.8) / 2 + 0.1, ry: 0.16, a: 0.9 }; }
    // two bikes lean on a hoop; a place for a hundred is drawn as a row of at most ten metres
    const L = or(p.length, cap ? clamp(cap / 2 * 0.75, 1.5, 10) : 3), n = Math.max(2, Math.round(L / 0.75) + 1), l = or(p.width, 0.8);
    for (let i = 0; i < n; i++) hoop(-L / 2 + (i / (n - 1)) * L, 0, l, false);
    return { rx: L / 2 + 0.2, ry: l / 2 + 0.15, a: 0.7 };
  };
  // A standing knight, for statues and fountain columns (in the frame: y the way he looks, +x his right
  // hand side, z up; h: his height). Plate armour: greaves and knee cops, a skirt of
  // plates over mail, breastplate, big shoulder plates; bare-headed with hair to the collar; one arm stretched out
  // palm up, the other hand on a sword that stands point down; a cloak falling from the shoulder down his side.
  function figure(C: Ctx, W: Writer, x: number, y: number, z: number, h: number, col: RGB) {
    const hi = mix(col, WHITE, C.dark ? 0.07 : 0.2), lo = tone(col, 0.8), mid = tone(col, 0.92), f = C.high ? 2 : 1, seg = C.high ? 8 : 6;
    const T = (u: number, v: number, w: number, r: number): P4 => [x + u * h, y + v * h, z + w * h, r * h];
    W.box(x - 0.2 * h, y - 0.15 * h, z, x + 0.2 * h, y + 0.17 * h, z + 0.03 * h, lo, { top: mid });
    // legs: the weight on his left leg, the right one a step forward
    const leg = (sx: number, fwd: number) => {
      const hip = T(sx * 0.062, 0, 0.5, 0.064), knee = T(sx * 0.074, fwd * 0.6, 0.295, 0.05), ank = T(sx * 0.082, fwd, 0.075, 0.034);
      W.tube([hip, knee], 6, mid);
      W.tube([[knee[0], knee[1], knee[2], 0.052 * h], T(sx * 0.078, fwd * 0.8, 0.2, 0.05), ank], 6, col);       // the greave, fuller at the calf
      W.lump([knee[0], knee[1] + 0.012 * h, knee[2]], [0.052 * h, 0.056 * h, 0.05 * h], 1, 0.02, 11, () => hi);  // knee cop
      W.obox([ank[0], ank[1] + 0.035 * h, z + 0.052 * h], [0.036 * h, 0, 0], [0, 0.085 * h, 0], [0, 0, 0.024 * h], lo, { top: mid }); // the foot
    };
    leg(1, 0.075); leg(-1, -0.015);
    // the skirt: mail below, a ring of plates over it
    W.lathe(x, y, z + 0.4 * h, [[0.135 * h, 0], [0.128 * h, 0.1 * h]], seg, lo, { facet: false });
    W.lathe(x, y, z + 0.445 * h, [[0.158 * h, 0], [0.142 * h, 0.06 * h], [0.118 * h, 0.115 * h]], 8, col);
    W.lathe(x, y, z + 0.555 * h, [[0.121 * h, 0], [0.121 * h, 0.018 * h]], seg, hi, { facet: false });           // the belt
    // breastplate, back, shoulders
    W.lump([x, y + 0.008 * h, z + 0.665 * h], [0.118 * h, 0.088 * h, 0.125 * h], f, 0.02, 2, (P) => (P[2] > z + 0.7 * h ? hi : col));
    for (const s of [-1, 1]) W.lump([x + s * 0.148 * h, y, z + 0.762 * h], [0.066 * h, 0.07 * h, 0.05 * h], f, 0.03, 12 + s, () => hi);
    W.cyl(x, y, z + 0.775 * h, z + 0.84 * h, 0.04 * h, 0.034 * h, 6, mid);
    // head and hair
    W.lump([x, y + 0.012 * h, z + 0.893 * h], [0.052 * h, 0.06 * h, 0.07 * h], f, 0.02, 4, () => hi);
    W.lump([x, y - 0.024 * h, z + 0.882 * h], [0.066 * h, 0.056 * h, 0.088 * h], f, 0.04, 5, () => lo);
    W.box(x - 0.008 * h, y + 0.066 * h, z + 0.875 * h, x + 0.008 * h, y + 0.082 * h, z + 0.905 * h, hi);        // the nose, so the face has a front
    // his left arm stretched forward, the hand open
    W.tube([T(-0.165, 0.005, 0.745, 0.042), T(-0.205, 0.07, 0.635, 0.036)], 5, col);
    W.lump([x - 0.205 * h, y + 0.07 * h, z + 0.635 * h], [0.045 * h, 0.045 * h, 0.042 * h], 1, 0.02, 13, () => hi);
    W.tube([T(-0.205, 0.07, 0.635, 0.036), T(-0.2, 0.285, 0.655, 0.028)], 5, col);
    W.obox([x - 0.2 * h, y + 0.32 * h, z + 0.657 * h], [0.03 * h, 0, 0], [0, 0.042 * h, 0.006 * h], [0, 0, 0.011 * h], hi);
    // his right arm down to the sword
    W.tube([T(0.165, 0, 0.745, 0.042), T(0.215, -0.005, 0.615, 0.036)], 5, col);
    W.lump([x + 0.215 * h, y - 0.005 * h, z + 0.615 * h], [0.044 * h, 0.044 * h, 0.042 * h], 1, 0.02, 14, () => hi);
    W.tube([T(0.215, -0.005, 0.615, 0.035), T(0.2, 0.085, 0.53, 0.028)], 5, col, { cap: true });
    // the sword, point on the ground
    W.tube([T(0.2, 0.1, 0.5, 0.011), T(0.215, 0.14, 0.035, 0.007)], 4, hi, { cap: true });
    W.obox([x + 0.2 * h, y + 0.1 * h, z + 0.505 * h], [0.05 * h, 0, 0], [0, 0.009 * h, 0], [0, 0, 0.009 * h], hi);
    W.tube([T(0.2, 0.098, 0.505, 0.012), T(0.198, 0.092, 0.565, 0.012)], 4, mid);
    W.lump([x + 0.198 * h, y + 0.09 * h, z + 0.575 * h], [0.02 * h, 0.02 * h, 0.02 * h], 1, 0, 15, () => hi);
    // the cloak: from the right shoulder down the back and side
    W.lump([x + 0.05 * h, y - 0.092 * h, z + 0.47 * h], [0.15 * h, 0.036 * h, 0.33 * h], f, 0.06, 6, () => lo);
    W.lump([x + 0.19 * h, y - 0.04 * h, z + 0.36 * h], [0.045 * h, 0.075 * h, 0.27 * h], f, 0.06, 7, () => tone(col, 0.86));
  }
  // A bear walking uphill, as on the arms of Bern: an outline in a frame u (to the right), w (up)
  const BEAR: XY[] = [[-0.5, 0.06], [-0.43, 0.17], [-0.37, 0.2], [-0.33, 0.28], [-0.26, 0.22], [-0.12, 0.25], [0.1, 0.29], [0.33, 0.24], [0.47, 0.1], [0.45, -0.1], [0.48, -0.27], [0.34, -0.27], [0.3, -0.09], [0.04, -0.07], [-0.02, -0.27], [-0.16, -0.27], [-0.2, -0.05], [-0.33, -0.03], [-0.46, -0.03]];
  PROPS.fountain = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), stone = pal.stone, lt = mix(stone, WHITE, C.dark ? 0.08 : 0.3), water = pal.water;
    if (/temple|tempel|pavilion|rotunda|monopteros/.test(v)) {
      // an open round temple: steps, columns in a circle, a ring of stone, a copper-green dome with a gilt top; a figure inside
      const Rt = or(num(p.width) != null ? p.width : p.length, 5) / 2, H = or(p.height, 7.2), hcol = H * 0.52, n = 6, seg = C.high ? 18 : 12;
      const cop = C.dark ? hex('#35514A')! : hex('#8DBBA8')!, gilt = C.dark ? hex('#8A7437')! : hex('#E0BE5C')!;
      W.lathe(0, 0, 0, [[Rt + 0.35, 0], [Rt + 0.35, 0.16, lt], [Rt + 0.05, 0.16], [Rt + 0.05, 0.32, lt], [0, 0.32, lt]], seg, stone, { facet: false });
      for (let i = 0; i < n; i++) {
        const a = (i / n) * TAU + TAU / 12, cx = Math.cos(a) * Rt * 0.86, cyy = Math.sin(a) * Rt * 0.86;
        W.lathe(cx, cyy, 0.32, [[0.24, 0], [0.24, 0.14], [0.17, 0.2], [0.15, hcol - 0.25], [0.24, hcol - 0.1, lt], [0.24, hcol]], C.high ? 8 : 6, lt, { facet: false });
      }
      W.lathe(0, 0, 0.32 + hcol, [[Rt * 0.74, 0], [Rt * 0.98, 0, stone], [Rt * 0.98, 0.42], [Rt * 1.05, 0.46, lt], [Rt * 1.05, 0.58, lt], [Rt * 0.9, 0.58, lt]], seg, lt, { facet: false });
      const zd = 0.32 + hcol + 0.58, hd = H - zd - 0.5, prof: LathePt[] = [];
      for (let k = 0; k <= 5; k++) { const a = (k / 5) * Math.PI / 2; prof.push([Rt * 0.9 * Math.cos(a) + 0.02, hd * Math.sin(a), k % 2 ? cop : tone(cop, 0.93)]); }
      W.lathe(0, 0, zd, prof, seg, cop, { facet: false });
      W.lathe(0, 0, zd + hd - 0.02, [[0.16, 0], [0.1, 0.22], [0.2, 0.3], [0, 0.52]], 6, gilt);
      W.lathe(0, 0, 0.32, [[0.75, 0], [0.75, 0.5, lt], [0.55, 0.5, water], [0.2, 0.5], [0.18, 1.0, lt], [0, 1.0, lt]], 8, stone, { phase: Math.PI / 8 });
      figure(C, W, 0, 0, 1.32, Math.min(1.5, hcol - 1.3), pal.bronze);
      return { rx: Rt + 0.8, ry: Rt + 0.8, a: 1.2 };
    }
    const trough = /trough|trog|rect|long/.test(v) || (num(p.length) && num(p.width) && p.length! > p.width! * 1.5);
    const low = num(p.height) != null && p.height! < 1.5, hb = low ? p.height! : 0.8, hc = low ? hb + 1.0 : or(p.height, 3.1);
    let cy = 0, Rb = 0, L = 0, D = 0;
    if (trough) {
      L = or(p.length, 3.2); D = or(p.width, 1.3);
      const t = 0.16;
      W.box(-L / 2 - 0.12, -D / 2 - 0.12, 0, L / 2 + 0.12, D / 2 + 0.12, 0.1, tone(stone, 0.94));
      W.box(-L / 2, -D / 2, 0.1, L / 2, -D / 2 + t, hb, stone, { top: lt }); W.box(-L / 2, D / 2 - t, 0.1, L / 2, D / 2, hb, stone, { top: lt });
      W.box(-L / 2, -D / 2 + t, 0.1, -L / 2 + t, D / 2 - t, hb, stone, { top: lt }); W.box(L / 2 - t, -D / 2 + t, 0.1, L / 2, D / 2 - t, hb, stone, { top: lt });
      W.quad([-L / 2 + t, -D / 2 + t, hb - 0.12], [L / 2 - t, -D / 2 + t, hb - 0.12], [L / 2 - t, D / 2 - t, hb - 0.12], [-L / 2 + t, D / 2 - t, hb - 0.12], water, { n: [0, 0, 1], mode: 1 });
      cy = -D / 2 - 0.12;
    } else {
      Rb = or(num(p.width) != null ? p.width : p.length, 2.6) / 2;
      W.lathe(0, 0, 0, [[Rb + 0.14, 0], [Rb + 0.14, 0.1], [Rb + 0.02, 0.12], [Rb, hb - 0.1], [Rb + 0.07, hb - 0.06], [Rb + 0.07, hb], [Rb - 0.17, hb, lt], [Rb - 0.17, hb - 0.16, tone(stone, 0.8)]], 8, stone, { phase: Math.PI / 8 });
      const pts: V3[] = [];
      for (let k = 0; k < 8; k++) { const a = Math.PI / 8 + (k / 8) * TAU; pts.push([Math.cos(a) * (Rb - 0.17), Math.sin(a) * (Rb - 0.17), hb - 0.13]); }
      W.fan(pts, water, { n: [0, 0, 1], mode: 1 });
    }
    // the column (Brunnenstock) with its capital, something on top, and spouts
    W.lathe(0, cy, 0, [[0.3, 0], [0.3, hb + 0.12], [0.2, hb + 0.2], [0.17, hc - 0.5], [0.26, hc - 0.42, lt], [0.29, hc - 0.3, lt], [0.2, hc - 0.27], [0.2, hc - 0.2], [0, hc - 0.2]], 8, lt, { phase: Math.PI / 8 });
    if (/figure|statue|figur/.test(v) || /brunnen/i.test(p.name || '')) figure(C, W, 0, cy, hc - 0.2, Math.max(0.9, hc * 0.36), pal.bronze);
    else W.lump([0, cy, hc - 0.03], [0.19, 0.19, 0.19], 2, 0, 1, () => pal.bronze);
    const jet = mix(water, WHITE, C.dark ? 0.2 : 0.6), zs = hb + 0.42, dirs = trough ? [[0, 1]] : [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (const d of dirs) {
      const e = [d[0] * 0.62, cy + d[1] * 0.62, zs];
      W.tube([[d[0] * 0.15, cy + d[1] * 0.15, zs, 0.022], [e[0], e[1], e[2], 0.018]], 4, pal.metal, { cap: true });
      const path: P4[] = [];
      for (let k = 0; k <= 4; k++) { const u = k / 4; path.push([e[0] + d[0] * 0.3 * u, e[1] + d[1] * 0.3 * u, zs - (zs - hb + 0.13) * u * u, 0.012]); }
      W.tube(path, 3, jet, { mode: 1 });
    }
    return trough ? { rx: L / 2 + 0.45, ry: D / 2 + 0.5, a: 1.2 } : { rx: Rb + 0.5, ry: Rb + 0.5, a: 1.2 };
  };
  PROPS.planter = function (C, p, W, R, x, y, z) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), h = or(p.height, 0.6), L = or(p.length, 1.2), D = or(p.width, Math.min(L, 1.2));
    const st = mix(pal.stone, pal.kerb, 0.4), lt = mix(st, WHITE, C.dark ? 0.08 : 0.3), round = /round|rund|tub|pot/.test(v);
    if (round) {
      const r = Math.max(L, D) / 2;
      W.lathe(0, 0, 0, [[r * 0.82, 0], [r, h], [r - 0.06, h, lt], [r - 0.06, h - 0.07, pal.soil], [0, h - 0.07, pal.soil]], C.high ? 12 : 8, st, { facet: false });
    } else {
      W.box(-L / 2, -D / 2, 0, L / 2, D / 2, h, st, { top: lt });
      W.quad([-L / 2 + 0.06, -D / 2 + 0.06, h + 0.004], [L / 2 - 0.06, -D / 2 + 0.06, h + 0.004], [L / 2 - 0.06, D / 2 - 0.06, h + 0.004], [-L / 2 + 0.06, D / 2 - 0.06, h + 0.004], pal.soil, { n: [0, 0, 1] });
    }
    const WC = C.W.crown.frame(x, y, z, p.heading || 0), n = Math.max(1, Math.round(L / 0.65)), Ls = C.sun;
    for (let i = 0; i < n; i++) {
      const cx = n === 1 ? 0 : -L / 2 + 0.35 + (i / (n - 1)) * (L - 0.7), s = 0.85 + R() * 0.3, rr = Math.min(D / 2 - 0.02, 0.4 * s);
      WC.lump([cx, (R() - 0.5) * 0.1, h + 0.24 * s], [rr, rr, 0.32 * s], C.high ? 2 : 1, 0.12, seedOf(x + cx, y, 3), (P, nn) => leaf(C, sat(0.25 + 0.45 * sat(0.5 + 0.5 * dot(nn, Ls)) + 0.3 * nn[2])), 2);
      if (C.high && !/shrub|hedge|grass/.test(v)) for (let k = 0; k < 5; k++) {
        const a = R() * TAU, e = 0.5 + R() * 0.45, fc = pal.flowers[Math.floor(R() * pal.flowers.length) % pal.flowers.length];
        WC.lump([cx + Math.cos(a) * rr * e, Math.sin(a) * rr * e, h + 0.24 * s + 0.3 * s * Math.sqrt(1 - e * e * 0.8)], [0.05, 0.05, 0.04], 1, 0, 1, () => fc, 2);
      }
    }
    return { rx: L / 2 + 0.25, ry: D / 2 + 0.25, a: 1.2 };
  };
  PROPS.hydrant = function (C, p, W) {
    const pal = C.pal, H = or(p.height, 0.85), c = pal.hydrant, lt = mix(c, WHITE, C.dark ? 0.05 : 0.2), seg = C.high ? 10 : 6;
    W.lathe(0, 0, 0, [[0.13, 0], [0.13, 0.05], [0.085, 0.08], [0.085, H * 0.6], [0.11, H * 0.64, lt], [0.11, H * 0.84, lt], [0.075, H * 0.93], [0.03, H], [0, H + 0.01]], seg, c, { facet: false });
    for (const s of [-1, 1]) W.tube([[s * 0.09, 0, H * 0.74, 0.042], [s * 0.17, 0, H * 0.74, 0.042]], 6, pal.steel, { cap: true });
    W.tube([[0, 0.09, H * 0.74, 0.05], [0, 0.16, H * 0.74, 0.05]], 6, pal.steel, { cap: true });
    return { rx: 0.26, ry: 0.26, a: 1.2 };
  };
  PROPS['sign-post'] = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), blue = pal.sign, white = C.dark ? hex('#C9CCD2')! : hex('#FBFBF8')!, red = pal.hydrant, back = pal.steel;
    if (/guide|finger|wegweis|cycling|velo/.test(v)) {
      // a guidepost: a stout pole with red arrow blades pointing both ways
      const H = or(p.height, 4.2), r = p._host || 0.075, dk = mix(hex(C.dark ? '#7A3A3A' : '#B8454B')!, pal.hydrant, 0.3);
      if (!p._host) {
        W.lathe(0, 0, 0, [[r * 1.7, 0], [r * 1.7, 0.22], [r, 0.28]], C.high ? 8 : 5, tone(pal.metal, 0.9), { facet: false });
        W.cyl(0, 0, 0.28, H, r, r * 0.9, C.high ? 8 : 5, pal.steel, { cap: true });
      }
      [[1, 2.25], [1, 2.55], [1, 2.85], [-1, 2.4], [-1, 2.7], [0.6, 3.25]].forEach(([dir, z0], i) => {
        const s = dir > 0 ? 1 : -1, l = 0.95 * Math.abs(dir) + 0.2, y0 = (i % 2 ? 1 : -1) * (r + 0.012), pts = [[-s * 0.06, 0], [s * (l - 0.14), 0], [s * l, 0.12], [s * (l - 0.14), 0.24], [-s * 0.06, 0.24]];
        for (const side of [1, -1]) W.fan(pts.map((q) => [q[0], y0 + side * 0.004, z0 + q[1]]), dk, { n: [0, side, 0] });
        for (const side of [1, -1]) W.quad([s * 0.14, y0 + side * 0.006, z0 + 0.04], [s * 0.3, y0 + side * 0.006, z0 + 0.04], [s * 0.3, y0 + side * 0.006, z0 + 0.2], [s * 0.14, y0 + side * 0.006, z0 + 0.2], side > 0 ? white : dk, { n: [0, side, 0] });
      });
      return { rx: 0.3, ry: 0.3, a: 1.2 };
    }
    if (/board|map|plan|tafel|panel/.test(v)) {
      // an information board on two legs
      const host = p._host, H = or(p.height, host ? 1.95 : 2.1), w = or(p.length, host ? 0.8 : 1.2) / 2;
      if (host) W.o = Object.assign({}, W.o, { x: W.P([0, host + 0.04, 0])[0], y: W.P([0, host + 0.04, 0])[1] });
      else for (const s of [-1, 1]) W.box(s * w - 0.03, -0.03, 0, s * w + 0.03, 0.03, H, pal.metal);
      W.box(-w, -0.035, H - 1.05, w, 0.035, H - 0.02, tone(pal.metal, 0.9), { bottom: true });
      for (const side of [1, -1]) {
        W.quad([-w + 0.05, side * 0.037, H - 1.0], [w - 0.05, side * 0.037, H - 1.0], [w - 0.05, side * 0.037, H - 0.07], [-w + 0.05, side * 0.037, H - 0.07], white, { n: [0, side, 0] });
        W.quad([-w + 0.12, side * 0.039, H - 0.9], [w * 0.2, side * 0.039, H - 0.9], [w * 0.2, side * 0.039, H - 0.3], [-w + 0.12, side * 0.039, H - 0.3], mix(pal.grass, white, 0.45), { n: [0, side, 0] });
        W.quad([-w + 0.12, side * 0.039, H - 0.25], [w - 0.12, side * 0.039, H - 0.25], [w - 0.12, side * 0.039, H - 0.14], [-w + 0.12, side * 0.039, H - 0.14], blue, { n: [0, side, 0] });
      }
      return { rx: w + 0.2, ry: 0.25, a: 1.1 };
    }
    const H = or(p.height, 2.6);
    W.cyl(0, 0, 0, H, 0.03, 0.03, C.high ? 6 : 4, pal.steel, { cap: true });
    const y0 = 0.034, zc = H - 0.38;
    const plate = (pts: number[][], col: RGB, lift?: number) => W.fan(pts.map((q) => [q[0], y0 + (lift || 0), zc + q[1]]), col, { n: [0, 1, 0] });
    const backPlate = (pts: number[][]) => W.fan(pts.map((q) => [q[0], y0 - 0.006, zc + q[1]]), back, { n: [0, -1, 0] });
    const disc = (r: number, n: number) => { const o: number[][] = []; for (let k = 0; k < n; k++) o.push([Math.cos(k / n * TAU) * r, Math.sin(k / n * TAU) * r]); return o; };
    const rect = (w: number, h: number, dz?: number) => [[-w / 2, -h / 2 + (dz || 0)], [w / 2, -h / 2 + (dz || 0)], [w / 2, h / 2 + (dz || 0)], [-w / 2, h / 2 + (dz || 0)]];
    if (/cross|zebra|fussg|pedestrian/.test(v)) {
      const sq = rect(0.6, 0.6);
      plate(sq, blue); backPlate(sq);
      plate([[-0.24, -0.2], [0.24, -0.2], [0, 0.22]], white, 0.002);
      plate(rect(0.05, 0.2, -0.07), tone(pal.metal, 0.5), 0.004); plate(disc(0.035, 6).map((q) => [q[0], q[1] + 0.08]), tone(pal.metal, 0.5), 0.004);
    } else if (/triang|warn|gefahr|yield|vortritt/.test(v)) {
      const tr = [[-0.36, -0.3], [0.36, -0.3], [0, 0.32]];
      plate(tr, red); backPlate(tr); plate([[-0.25, -0.235], [0.25, -0.235], [0, 0.2]], white, 0.002);
    } else if (/stop|tram|bus|halt/.test(v)) {
      const r = rect(0.46, 0.62);
      plate(r, white); backPlate(r); plate(rect(0.46, 0.22, 0.2), red, 0.002); plate(disc(0.07, 8).map((q) => [q[0], q[1] + 0.2]), white, 0.004);
      W.box(-0.17, -0.03, 1.15, 0.17, 0.05, 1.65, tone(pal.metal, 0.9)); W.quad([-0.14, 0.052, 1.19], [0.14, 0.052, 1.19], [0.14, 0.052, 1.61], [-0.14, 0.052, 1.61], white, { n: [0, 1, 0] });
    } else if (/name|street|strasse|gasse/.test(v)) {
      const r = rect(0.85, 0.2, 0.2);
      plate(r, white); backPlate(r); plate(rect(0.81, 0.16, 0.2), blue, 0.002); plate(rect(0.5, 0.03, 0.2), white, 0.004);
    } else if (/park|square|info|rect/.test(v)) {
      const sq = rect(0.55, 0.55);
      plate(sq, blue); backPlate(sq); plate(rect(0.3, 0.34), white, 0.002);
    } else {
      const d = disc(0.3, C.high ? 16 : 10);
      plate(d, blue); backPlate(d);
      plate(rect(0.07, 0.26, -0.05), white, 0.002); plate([[-0.13, 0.06], [0.13, 0.06], [0, 0.2]], white, 0.002);
    }
    return { rx: 0.2, ry: 0.2, a: 1.1 };
  };
  PROPS.pole = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), H = or(p.height, 6), mast = /tram|mast|fahrleit|span/.test(v) && H > 5.5;
    const r = or(p.width, mast ? 0.3 : 0.15) / 2, M = mast ? mix(pal.metal, pal.steel, 0.45) : pal.metal, seg = C.high ? (mast ? 10 : 8) : 5;
    if (mast) {
      // a tram mast: a round concrete foot, a tapering steel pole, bands where signs were strapped on
      const foot = mix(pal.stone, pal.kerb, 0.5), band = mix(pal.steel, WHITE, C.dark ? 0.1 : 0.4);
      W.lathe(0, 0, 0, [[r * 2.3, 0], [r * 2.3, 0.3, foot], [r * 1.5, 0.36, mix(foot, WHITE, 0.2)], [r * 1.15, 0.36, mix(foot, WHITE, 0.2)]], seg, foot, { facet: false });
      const prof: LathePt[] = [[r * 1.1, 0.36], [r * 1.02, 1.9]];
      if (/band|ring/.test(v)) for (const z of [2.0, 2.45, 2.9, 3.35]) prof.push([r * 1.0, z], [r * 1.07, z + 0.01, band], [r * 1.07, z + 0.1, band], [r * 1.0, z + 0.11]);
      prof.push([r * 0.98, 3.9], [r * 0.62, H - 0.05], [0, H]);
      W.lathe(0, 0, 0, prof, seg, M, { facet: false });
      return { rx: r * 3.4, ry: r * 3.4, a: 1.3 };
    }
    W.lathe(0, 0, 0, [[r * 1.5, 0], [r * 1.5, 0.3], [r * 1.05, 0.36]], seg, tone(M, 0.9), { facet: false });
    W.cyl(0, 0, 0.36, H, r, r * 0.7, seg, M, { col1: mix(M, WHITE, C.dark ? 0.05 : 0.15), cap: true });
    if (/catenary|cantilever|ausleger|arm/.test(v)) {
      const len = or(p.length, 3.2);
      W.tube([[0, 0, H - 0.5, 0.035], [0, len, H - 0.32, 0.028]], 5, M, { cap: true });
      W.tube([[0, 0, H - 0.05, 0.014], [0, len * 0.7, H - 0.37, 0.014]], 3, M);
      W.lump([0, len - 0.1, H - 0.42], [0.045, 0.045, 0.07], 1, 0, 1, () => pal.steel);
    } else if (/flag|fahne/.test(v)) {
      W.quad([0, 0.03, H - 1.0], [0, 1.3, H - 1.05], [0, 1.3, H - 0.15], [0, 0.03, H - 0.1], [pal.hydrant, tone(pal.hydrant, 0.9), pal.hydrant, tone(pal.hydrant, 1.06)], { two: true });
    }
    return { rx: r * 3.2, ry: r * 3.2, a: 1.2 };
  };
  PROPS.shelter = function (C, p, W) {
    const pal = C.pal, L = or(p.length, 4), D = or(p.width, 1.5), H = or(p.height, 2.5), M = pal.metal, ML = mix(M, WHITE, C.dark ? 0.06 : 0.2);
    const G = C.W.glass.frame(W.o!.x, W.o!.y, W.o!.z, p.heading || 0), gc = pal.pane, ga = C.dark ? 0.5 : 0.46;
    const yb = -D / 2 + 0.05, xe = L / 2 - 0.06;
    for (const sx of [-1, 1]) { W.box(sx * xe - 0.03, yb - 0.03, 0, sx * xe + 0.03, yb + 0.03, H, M); W.box(sx * xe - 0.03, D * 0.2 - 0.03, 0, sx * xe + 0.03, D * 0.2 + 0.03, H, M); }
    W.box(-L / 2 - 0.15, -D / 2 - 0.08, H, L / 2 + 0.15, D / 2 + 0.3, H + 0.08, M, { top: ML, bottom: true });
    W.box(-xe, yb - 0.02, 0.1, xe, yb + 0.02, 0.16, M); W.box(-xe, yb - 0.02, H - 0.22, xe, yb + 0.02, H - 0.16, M);
    G.quad([-xe, yb, 0.16], [xe, yb, 0.16], [xe, yb, H - 0.22], [-xe, yb, H - 0.22], gc, { a: ga, two: true, mode: 1 });
    for (const sx of [-1, 1]) G.quad([sx * xe, yb, 0.16], [sx * xe, D * 0.2, 0.16], [sx * xe, D * 0.2, H - 0.22], [sx * xe, yb, H - 0.22], gc, { a: ga, two: true, mode: 1 });
    // a bench inside, and the timetable case
    const own = (C.detail.props || []).some((q) => q && q.kind === 'bench' && q.xy && Math.hypot(q.xy[0] - W.o!.x, q.xy[1] - W.o!.y) < L / 2 + 0.3);
    if (!own) {
      W.box(-L / 2 + 0.5, yb + 0.1, 0.42, L / 2 - 1.1, yb + 0.48, 0.47, pal.wood, { top: mix(pal.wood, WHITE, C.dark ? 0.04 : 0.14), bottom: true });
      for (const bx of [-L / 2 + 0.75, L / 2 - 1.35]) W.box(bx - 0.03, yb + 0.2, 0, bx + 0.03, yb + 0.4, 0.42, M);
    }
    W.box(L / 2 - 0.95, yb + 0.03, 0.75, L / 2 - 0.2, yb + 0.1, 1.95, tone(M, 0.85));
    W.quad([L / 2 - 0.9, yb + 0.102, 0.8], [L / 2 - 0.25, yb + 0.102, 0.8], [L / 2 - 0.25, yb + 0.102, 1.9], [L / 2 - 0.9, yb + 0.102, 1.9], C.dark ? hex('#E9E3CF')! : hex('#FAF8F1')!, { n: [0, 1, 0], mode: C.dark ? 1 : 0 });
    if (C.dark) W.quad([-L / 2 + 0.3, -0.1, H - 0.002], [L / 2 - 0.3, -0.1, H - 0.002], [L / 2 - 0.3, 0.1, H - 0.002], [-L / 2 + 0.3, 0.1, H - 0.002], pal.lens, { n: [0, 0, -1], mode: 1 });
    return { rx: L / 2 + 0.45, ry: D / 2 + 0.5, a: 1.0 };
  };
  PROPS.clock = function (C, p, W) {
    // the station clock: white face, black hands, the red second hand with its disc
    const pal = C.pal, H = or(p.height, 3.6), r = or(p.width, 0.8) / 2, M = pal.metal, dk = tone(pal.metal, 0.35), seg = C.high ? 18 : 10, t = 0.07;
    const face = C.dark ? hex('#F1EBD6')! : hex('#FCFBF6')!, red = hex(C.dark ? '#C24A3E' : '#E0473A')!, zc = H - r;
    W.lathe(0, 0, 0, [[0.09, 0], [0.09, 0.3], [0.06, 0.36]], C.high ? 8 : 5, tone(M, 0.9), { facet: false });
    W.cyl(0, 0, 0.36, zc - r + 0.02, 0.06, 0.05, C.high ? 8 : 5, M);
    for (let k = 0; k < seg; k++) {
      const a0 = (k / seg) * TAU, a1 = ((k + 1) / seg) * TAU, am = (a0 + a1) / 2;
      W.quad([Math.cos(a0) * r, -t, zc + Math.sin(a0) * r], [Math.cos(a1) * r, -t, zc + Math.sin(a1) * r], [Math.cos(a1) * r, t, zc + Math.sin(a1) * r], [Math.cos(a0) * r, t, zc + Math.sin(a0) * r], dk, { n: [Math.cos(am), 0, Math.sin(am)] });
    }
    for (const s of [1, -1]) {
      const y = s * (t + 0.001), ring: V3[] = [], inner: V3[] = [];
      for (let k = 0; k < seg; k++) { const a = (k / seg) * TAU; ring.push([Math.cos(a) * r, y, zc + Math.sin(a) * r]); inner.push([Math.cos(a) * r * 0.9, y + s * 0.002, zc + Math.sin(a) * r * 0.9]); }
      W.fan(ring, dk, { n: [0, s, 0] });
      W.fan(inner, face, { n: [0, s, 0], mode: C.dark ? 1 : 0 });
      const hand = (deg: number, len: number, w: number, col: RGB, lift: number, tail: number) => {
        const a = deg * RAD, dx = Math.sin(a) * s, dz = Math.cos(a), px = Math.cos(a) * s, pz = -Math.sin(a), yy = y + s * lift;
        const P = (u: number, q: number): V3 => [dx * u + px * q, yy, zc + dz * u + pz * q];
        W.quad(P(-tail, -w), P(len, -w), P(len, w), P(-tail, w), col, { n: [0, s, 0], mode: 1 });
      };
      if (C.high) for (let k = 0; k < 12; k++) hand(k * 30, r * 0.84, r * (k % 3 ? 0.018 : 0.035), dk, 0.004, -r * (k % 3 ? 0.7 : 0.62));
      hand(305, r * 0.5, r * 0.05, dk, 0.006, r * 0.12);
      hand(60, r * 0.76, r * 0.04, dk, 0.008, r * 0.12);
      hand(205, r * 0.6, r * 0.014, red, 0.01, r * 0.18);
      const disc: V3[] = [];
      for (let k = 0; k < 8; k++) { const a = (k / 8) * TAU, c = [Math.sin(205 * RAD) * s * r * 0.6, Math.cos(205 * RAD) * r * 0.6]; disc.push([c[0] + Math.cos(a) * r * 0.07, y + s * 0.011, zc + c[1] + Math.sin(a) * r * 0.07]); }
      W.fan(disc, red, { n: [0, s, 0], mode: 1 });
    }
    return { rx: 0.3, ry: 0.3, a: 1.2 };
  };
  PROPS.statue = function (C, p, W) {
    const pal = C.pal, v = String(p.variant || '').toLowerCase(), H = or(p.height, 4.4), L = or(p.length, 1.7), D = or(p.width, L);
    const given = hex(p.plinthColor), metal = hex(p.color);
    const st = given && !C.dark ? mix(pal.stone, given, 0.4) : mix(pal.stone, hex(C.dark ? '#4A4442' : '#D9CCC2')!, 0.5), lt = mix(st, WHITE, C.dark ? 0.08 : 0.3), a = L / 2, b = D / 2;
    const bronze = metal && !C.dark ? mix(pal.bronze, metal, 0.42) : pal.bronze;
    if (/obelisk|column|säule|saeule|stele/.test(v)) {
      W.box(-a, -b, 0, a, b, 0.25, tone(st, 0.94), { top: lt });
      W.lathe(0, 0, 0.25, [[a * 0.62, 0], [a * 0.4, H - 0.75], [0, H - 0.25, lt]], 4, st, { phase: Math.PI / 4 });
      return { rx: a + 0.4, ry: b + 0.4, a: 1.2 };
    }
    const bust = /bust|büste|bueste/.test(v), hp = clamp(or(p.plinthHeight, bust ? H * 0.72 : H * 0.48), 0.3, H - 0.3);
    // a block that may narrow upwards: half sizes a·k0 × b·k0 at the bottom, a·k1 × b·k1 at the top
    const block = (z0: number, z1: number, k0: number, k1: number, col: RGB, top?: RGB) => {
      const q = (k: number, z: number): V3[] => [[-a * k, -b * k, z], [a * k, -b * k, z], [a * k, b * k, z], [-a * k, b * k, z]], lo = q(k0, z0), hi = q(k1, z1), hint: V3[] = [[0, -1, 0], [1, 0, 0], [0, 1, 0], [-1, 0, 0]];
      for (let i = 0; i < 4; i++) W.quad(lo[i], lo[(i + 1) % 4], hi[(i + 1) % 4], hi[i], [tone(col, 0.94), tone(col, 0.94), col, col], { n: hint[i] });
      W.quad(hi[0], hi[1], hi[2], hi[3], top || lt, { n: [0, 0, 1] });
      W.quad(lo[0], lo[1], lo[2], lo[3], tone(col, 0.8), { n: [0, 0, -1] });
    };
    if (L >= 2.4 && hp >= 2.4) {
      // a monument: steps, a base, the tapering die with its inscription, a cornice
      const hs = Math.min(0.9, hp * 0.17), s = hs / 3, z1 = hs + hp * 0.13, z2 = hp - Math.min(0.75, hp * 0.16);
      block(0, s, 1, 1, tone(st, 0.95)); block(s, 2 * s, 0.9, 0.9, tone(st, 0.97)); block(2 * s, hs, 0.8, 0.8, st);
      block(hs, z1, 0.7, 0.68, st); block(z1, z1 + 0.12, 0.72, 0.7, lt);
      block(z1 + 0.12, z2, 0.6, 0.47, st);
      block(z2, z2 + (hp - z2) * 0.3, 0.5, 0.56, lt); block(z2 + (hp - z2) * 0.3, z2 + (hp - z2) * 0.62, 0.58, 0.58, st); block(z2 + (hp - z2) * 0.62, hp, 0.5, 0.42, st);
      // on the front: a bronze band with a shield, the inscription in red letters, a trophy of arms, the bear of Bern
      const dz = z2 - z1 - 0.12, zd = (q: number) => z1 + 0.12 + dz * q, kd = (zz: number) => lerp(0.6, 0.47, (zz - z1 - 0.12) / dz), fy = (zz: number) => b * kd(zz) + 0.012;
      const red = mix(hex(C.dark ? '#7A3F38' : '#B24A3F')!, st, 0.15), bz2 = tone(bronze, 0.86), bz3 = mix(bronze, WHITE, C.dark ? 0.06 : 0.16);
      { const zb = zd(0.87), k = kd(zb) + 0.014; block(zb - 0.07, zb + 0.07, k + 0.003, k - 0.003, bz2, bronze); }
      { const zb = zd(0.87), sz = Math.min(0.62, a * 0.42), yy = fy(zb) + 0.045;
        W.fan([[-0.42, 0.42], [0.42, 0.42], [0.42, -0.05], [0, -0.52], [-0.42, -0.05]].map((q): V3 => [q[0] * sz, yy, zb + q[1] * sz]), bronze, { n: [0, 1, 0] });
        W.fan([[-0.3, 0.3], [0.3, 0.3], [0.3, -0.02], [0, -0.36], [-0.3, -0.02]].map((q): V3 => [q[0] * sz, yy + 0.006, zb + q[1] * sz]), bz3, { n: [0, 1, 0] }); }
      // lettering: a block per letter, so it reads as words from across the square
      const word = (q: number, n: number, lw: number, lh: number, gap: number) => {
        const zz = zd(q), tot = n * lw + (n - 1) * gap;
        for (let i = 0; i < n; i++) { const u0 = -tot / 2 + i * (lw + gap); W.quad([u0, fy(zz), zz], [u0 + lw, fy(zz), zz], [u0 + lw, fy(zz + lh), zz + lh], [u0, fy(zz + lh), zz + lh], red, { n: [0, 1, 0] }); }
      };
      const ls = a / 1.58;
      word(0.66, 6, 0.085 * ls, 0.11 * ls, 0.035 * ls); word(0.585, 3, 0.06 * ls, 0.075 * ls, 0.03 * ls);
      word(0.465, 9, 0.105 * ls, 0.15 * ls, 0.04 * ls); word(0.385, 9, 0.058 * ls, 0.08 * ls, 0.03 * ls);
      // the trophy at the foot of the die: a helmet on crossed weapons
      const zt = zd(0.13), ty = fy(zt) + 0.1;
      W.tube([[-a * 0.44, ty, zt - dz * 0.045, 0.03], [a * 0.44, ty + 0.02, zt + dz * 0.03, 0.026]], 4, bz2, { cap: true });
      W.tube([[-a * 0.4, ty + 0.03, zt + dz * 0.035, 0.026], [a * 0.42, ty + 0.01, zt - dz * 0.05, 0.03]], 4, bz2, { cap: true });
      W.fan([[-a * 0.44, ty + 0.02, zt - dz * 0.045], [-a * 0.52, ty + 0.02, zt + dz * 0.03], [-a * 0.4, ty + 0.02, zt + dz * 0.06], [-a * 0.34, ty + 0.02, zt - dz * 0.02]], bronze, { n: [0, 1, 0], two: true }); // an axe blade
      W.lump([a * 0.44, ty + 0.02, zt - dz * 0.055], [0.07, 0.07, 0.07], 1, 0.1, 21, () => bronze);                                                                                         // a mace
      W.lump([-0.02, ty + 0.05, zt + dz * 0.045], [0.21 * ls, 0.18 * ls, 0.2 * ls], C.high ? 2 : 1, 0.03, 22, (P, n) => (n[2] > 0.3 ? bz3 : bronze));                                         // the helmet
      W.obox([-0.02, ty + 0.2 * ls, zt + dz * 0.03], [0.13 * ls, 0, 0], [0, 0.06 * ls, -0.03 * ls], [0, 0.02 * ls, 0.07 * ls], bz2);                                                         // its visor
      // the bear, walking uphill, on the base
      { const s = Math.min(a * 0.62, (z1 - hs) * 1.35), zc2 = (hs + z1) / 2, yy = b * 0.69 + 0.03, t = 14 * RAD, ct = Math.cos(t), sn = Math.sin(t);
        const pts = cleanRing(BEAR.map((q): XY => [(q[0] * ct - q[1] * sn) * s, (q[0] * sn + q[1] * ct) * s]));
        if (pts) for (const tr of triangulate(C.THREE, pts)) W.tri([pts[tr[0]][0], yy, zc2 + pts[tr[0]][1]], [pts[tr[1]][0], yy, zc2 + pts[tr[1]][1]], [pts[tr[2]][0], yy, zc2 + pts[tr[2]][1]], bronze, { n: [0, 1, 0] }); }
    } else {
      W.box(-a - 0.28, -b - 0.28, 0, a + 0.28, b + 0.28, 0.18, tone(st, 0.92), { top: lt });
      W.box(-a - 0.1, -b - 0.1, 0.18, a + 0.1, b + 0.1, 0.36, tone(st, 0.96), { top: lt });
      block(0.36, hp - 0.18, 0.84, 0.84, st);
      W.box(-a * 0.96, -b * 0.96, hp - 0.18, a * 0.96, b * 0.96, hp, st, { top: lt, bottom: true });
      W.quad([-a * 0.5, b * 0.84 + 0.004, 0.36 + (hp - 0.54) * 0.3], [a * 0.5, b * 0.84 + 0.004, 0.36 + (hp - 0.54) * 0.3], [a * 0.5, b * 0.84 + 0.004, 0.36 + (hp - 0.54) * 0.75], [-a * 0.5, b * 0.84 + 0.004, 0.36 + (hp - 0.54) * 0.75], mix(pal.bronze, st, 0.35), { n: [0, 1, 0] });
    }
    if (bust) {
      const h = H - hp;
      W.lathe(0, 0, hp, [[0.5 * h, 0], [0.55 * h, 0.3 * h], [0.2 * h, 0.5 * h], [0.16 * h, 0.58 * h]], C.high ? 9 : 6, pal.bronze, { facet: false });
      W.lump([0, 0, hp + 0.78 * h], [0.2 * h, 0.22 * h, 0.24 * h], 2, 0.03, 2, () => mix(pal.bronze, WHITE, 0.1));
    } else figure(C, W, 0, 0, hp, H - hp, bronze);
    return { rx: a + 0.55, ry: b + 0.55, a: 1.2 };
  };
  PROPS['ticket-machine'] = function (C, p, W) {
    // a ticket machine: a column with a screen, a red band on top
    const pal = C.pal, H = or(p.height, 1.75), w = or(p.length, 0.72) / 2, d = or(p.width, 0.46) / 2, body = mix(pal.steel, pal.metal, 0.35), dk = tone(pal.metal, 0.55);
    W.box(-w, -d, 0, w, d, 0.1, dk);
    W.box(-w, -d, 0.1, w, d, H - 0.16, body, { top: mix(body, WHITE, 0.15) });
    W.box(-w - 0.01, -d - 0.01, H - 0.16, w + 0.01, d + 0.01, H, pal.hydrant, { top: mix(pal.hydrant, WHITE, 0.15), bottom: true });
    const f = d + 0.004;
    W.quad([-w * 0.82, f, 0.55], [w * 0.82, f, 0.55], [w * 0.82, f, H - 0.24], [-w * 0.82, f, H - 0.24], dk, { n: [0, 1, 0] });
    const scr = C.dark ? hex('#BFD9F2')! : hex('#CFE3F2')!;
    W.quad([-w * 0.6, f + 0.003, 1.12], [w * 0.6, f + 0.003, 1.12], [w * 0.6, f + 0.003, H - 0.34], [-w * 0.6, f + 0.003, H - 0.34], [scr, scr, tone(scr, 0.85), tone(scr, 0.85)], { n: [0, 1, 0], mode: C.dark ? 1 : 0 });
    W.quad([-w * 0.6, f + 0.003, 0.68], [w * 0.1, f + 0.003, 0.68], [w * 0.1, f + 0.003, 0.98], [-w * 0.6, f + 0.003, 0.98], tone(pal.steel, 0.9), { n: [0, 1, 0] });
    W.quad([w * 0.25, f + 0.003, 0.68], [w * 0.6, f + 0.003, 0.68], [w * 0.6, f + 0.003, 0.98], [w * 0.25, f + 0.003, 0.98], tone(pal.metal, 0.3), { n: [0, 1, 0] });
    return { rx: w + 0.3, ry: d + 0.3, a: 1.25 };
  };
  const ALIAS: Partial<Record<StationDetailProp['kind'], StationDetailPropKind>> = { 'street-lamp': 'lamp', streetlamp: 'lamp', 'street_lamp': 'lamp', 'waste-basket': 'bin', 'waste_basket': 'bin', 'bicycle-parking': 'bike-stand', 'bike-rack': 'bike-stand', sign: 'sign-post', signpost: 'sign-post', monument: 'statue', mast: 'pole', 'bus-shelter': 'shelter' };
  // Where the wire of a hanging lamp is fixed: the nearest house fronts on both sides of it (trams hang their
  // span wires the same way). heading given: the wire runs across it. null if there are no two houses in reach.
  function spanWire(C: Ctx, x: number, y: number, z: number, heading?: number): Span | null {
    const hit = (dx: number, dy: number) => {
      for (let d = 1; d <= 70; d += 0.5) {
        const px = x + dx * d, py = y + dy * d;
        for (const r of C.rings) if (r && px >= r.box[0] && px <= r.box[2] && py >= r.box[1] && py <= r.box[3] && inRing(r, px, py)) return d;
      }
      return 0;
    };
    let best: Span | null = null;
    const dirs: number[] = [];
    if (heading != null) dirs.push(heading + 90); else for (let a = 0; a < 180; a += 10) dirs.push(a);
    for (const deg of dirs) {
      const dx = Math.sin(deg * RAD), dy = Math.cos(deg * RAD), d1 = hit(dx, dy), d2 = hit(-dx, -dy);
      if (d1 && d2 && d1 + d2 < 95 && (!best || d1 + d2 < best.len)) best = { len: d1 + d2, a: [x + dx * d1, y + dy * d1, z + 0.045 * d1], b: [x - dx * d2, y - dy * d2, z + 0.045 * d2] };
    }
    return best;
  }
  // A glass roof on columns (kind 'canopy'): panes on a grid of steel ribs over the outline, higher in the middle
  // by `rise`, an edge beam, and columns that branch into the roof. The glass is see-through and throws only a
  // faint shade; you walk under it, so the underside counts as much as the top.
  function buildCanopy(C: Ctx, p: Prop) {
    const ring = cleanRing(p.ring);
    if (!ring) { C.warn('canopy without a ring'); return; }
    const n = ring.length, cen = centroid(ring), z0 = num(p.z) != null ? p.z! : groundZ(C, cen[0], cen[1]);
    const H = or(p.height, 6), rise = Math.max(0, or(p.rise, 0)), ccw = area2(ring) > 0 ? 1 : -1, dark = C.dark, high = C.opts.quality !== 'low';
    const inside = (q: XY) => inRing(ring, q[0], q[1]);
    const edgeD = (x: number, y: number) => { let d = Infinity; for (let i = 0; i < n; i++) d = Math.min(d, segDist(x, y, ring[i], ring[(i + 1) % n])); return d; };
    const ax = longAxis(ring)!, ux = ax.ux, uy = ax.uy, step = high ? 3 : 4.5;
    const nu = Math.max(1, Math.round((ax.u1 - ax.u0) / step)), nv = Math.max(1, Math.round((ax.v1 - ax.v0) / step)), su = (ax.u1 - ax.u0) / nu, sv = (ax.v1 - ax.v0) / nv;
    const at = (u: number, v: number): XY => [ux * u - uy * v, uy * u + ux * v], node = (i: number, j: number) => at(ax.u0 + i * su, ax.v0 + j * sv);
    let D = 0.5; // how far the middle is from the edge
    for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) { const q = node(i, j); if (inside(q)) D = Math.max(D, edgeD(q[0], q[1])); }
    const top = (x: number, y: number) => { const t = sat(edgeD(x, y) / D); return z0 + H + rise * (1 - (1 - t) * (1 - t)); };
    const WG = C.W.glass.world(), WS = C.W.solid.world();
    // the panes: pale green-blue by day, dark with the warm light under them by night
    const gcol = dark ? mix(hex('#18222B')!, C.pal.lamp, 0.22) : hex('#BDE3DC')!, ga = dark ? 0.46 : 0.28, gm: Mode = dark ? 1 : 0;
    const shade = !dark && C.cast, sdx = -C.sun[0] / C.sun[2], sdy = -C.sun[1] / C.sun[2], sa = 0.3 * C.pal.shadowAlpha;
    for (let i = 0; i < nu; i++) for (let j = 0; j < nv; j++) {
      const ua = ax.u0 + i * su, ub = ua + su, va = ax.v0 + j * sv, vb = va + sv, cm = at((ua + ub) / 2, (va + vb) / 2);
      let poly: XY[] = [at(ua, va), at(ub, va), at(ub, vb), at(ua, vb)], tris: number[][] = [[0, 1, 2], [0, 2, 3]];
      if (!(inside(cm) && edgeD(cm[0], cm[1]) > Math.hypot(su, sv) / 2)) { // the edge runs through this pane: cut it
        poly = clipPoly(clipPoly(clipPoly(clipPoly(ring, ux, uy, -ua), -ux, -uy, ub), -uy, ux, -va), uy, -ux, vb);
        if (poly.length < 3) continue;
        tris = triangulate(C.THREE, poly);
      }
      const tint = tone(gcol, (i + j) & 1 ? 1.035 : 0.965);
      for (const t of tris) {
        const P = t.map((k): V3 => [poly[k][0], poly[k][1], top(poly[k][0], poly[k][1])]);
        WG.tri(P[0], P[1], P[2], tint, { n: [0, 0, 1], a: ga, mode: gm });
        if (shade) { // the faint shade of the glass on the ground
          const b = C.shadow, q = P.map((v) => { const x = v[0] + sdx * (v[2] - z0), y = v[1] + sdy * (v[2] - z0); return b.vert([x, y, groundZ(C, x, y, z0) + 0.012], C.pal.shadow, sa); });
          b.i.push(q[0], q[1], q[2], q[0], q[2], q[1]);
        }
      }
    }
    // steel: the ribs under the panes, the beam around the edge
    const steel = mix(C.pal.steel, C.pal.metal, 0.45);
    const bar = (a: XY, b: XY, hw: number, hh: number, drop: number, skip?: string) => {
      const za = top(a[0], a[1]) - drop, zb = top(b[0], b[1]) - drop, dx = (b[0] - a[0]) / 2, dy = (b[1] - a[1]) / 2, l = Math.hypot(dx, dy);
      if (l < 0.05) return;
      WS.obox([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (za + zb) / 2], [dx, dy, (zb - za) / 2], [-dy / l * hw, dx / l * hw, 0], [0, 0, hh], steel, skip ? { skip } : undefined);
    };
    const cut = (a: XY, b: XY): [XY, XY] | null => { // the part of a rib that lies under the roof
      const ia = inside(a), ib = inside(b);
      if (ia && ib) return [a, b];
      if (!ia && !ib) return null;
      let lo = ia ? a : b, hi = ia ? b : a;
      for (let k = 0; k < 10; k++) { const m: XY = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2]; if (inside(m)) lo = m; else hi = m; }
      return ia ? [a, lo] : [lo, b];
    };
    const rib = (a: XY, b: XY) => { const c = cut(a, b); if (c) bar(c[0], c[1], 0.035, 0.07, 0.085, '-x+x'); };
    for (let i = 0; i <= nu; i++) for (let j = 0; j < nv; j++) rib(node(i, j), node(i, j + 1));
    for (let j = 0; j <= nv; j++) for (let i = 0; i < nu; i++) rib(node(i, j), node(i + 1, j));
    for (let i = 0; i < n; i++) bar(ring[i], ring[(i + 1) % n], 0.09, 0.17, 0.06);
    // columns: where the data says, else about every 12 m, 1.5 m inside the edge
    let cols = (p.columns || []).filter((q) => q && isFinite(q[0]) && isFinite(q[1])).map((q): XY => [+q[0], +q[1]]);
    if (!cols.length) {
      const el: number[] = [];
      let per = 0;
      for (let i = 0; i < n; i++) { const a = ring[i], b = ring[(i + 1) % n]; el.push(Math.hypot(b[0] - a[0], b[1] - a[1])); per += el[i]; }
      const cnt = Math.max(3, Math.round(per / 12));
      for (let k = 0; k < cnt; k++) {
        let s = (k + 0.5) * per / cnt, i = 0;
        while (i < n - 1 && s > el[i]) { s -= el[i]; i++; }
        const a = ring[i], b = ring[(i + 1) % n], tx = (b[0] - a[0]) / el[i], ty = (b[1] - a[1]) / el[i];
        const q: XY = [a[0] + tx * s - ty * 1.5 * ccw, a[1] + ty * s + tx * 1.5 * ccw];
        if (inside(q)) cols.push(q);
      }
    }
    for (const c of cols) {
      const zg = groundZ(C, c[0], c[1], z0), zt = top(c[0], c[1]) - 0.1, zb = zg + (zt - zg) * 0.7;
      WS.cyl(c[0], c[1], zg, zt, 0.16, 0.11, high ? 10 : 6, steel);
      for (const d of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) { // four struts that reach into the roof like branches
        const q: XY = [c[0] + (ux * d[0] - uy * d[1]) * 1.6, c[1] + (uy * d[0] + ux * d[1]) * 1.6];
        if (inside(q)) WS.tube([[c[0], c[1], zb, 0.065], [q[0], q[1], top(q[0], q[1]) - 0.12, 0.045]], high ? 6 : 4, steel);
      }
      blob(C, c[0], c[1], 0.5, 0.5, 0, 0.5, zg);
      if (dark) pool(C, c[0], c[1], Math.max(5, H * 0.7), 0.3, zg); // the light under the roof
    }
    C.counts.props++;
  }
  function buildProp(C: Ctx, p: Prop) {
    if (p.kind === 'canopy') { buildCanopy(C, p); return; }
    const xy = p.xy;
    if (!xy || !isFinite(xy[0]) || !isFinite(xy[1])) return;
    const kind = ALIAS[p.kind] || p.kind, fn = PROPS[kind];
    if (!fn) { C.warn('prop kind "' + p.kind + '" is not known'); return; }
    const x = +xy[0], y = +xy[1], z = num(p.z) != null ? p.z! : groundZ(C, x, y), h = or(p.heading, or(p.axis, 0));
    if (p.heading == null && p.axis != null) p = Object.assign({}, p, { heading: p.axis });
    let fx = x, fy = y, fz = z;
    if (kind === 'sign-post' && (p.mount || /mounted|on a (tram )?(pole|mast)/i.test(p.variant || ''))) {
      // a sign strapped to a mast: it goes where the mast is, and brings no pole of its own
      let best: { d: number; q: StationDetailProp } | null = null;
      for (const q of C.detail.props || []) {
        if (!q || (ALIAS[q.kind] || q.kind) !== 'pole' || !q.xy) continue;
        const d = Math.hypot(q.xy[0] - x, q.xy[1] - y);
        if (d < 1.2 && (!best || d < best.d)) best = { d, q };
      }
      if (best) {
        const q = best.q, tall = /tram|mast|fahrleit|span/i.test(q.variant || '') && or(q.height, 6) > 5.5;
        fx = q.xy[0]; fy = q.xy[1]; fz = num(q.z) != null ? q.z! : groundZ(C, fx, fy);
        p = Object.assign({}, p, { _host: or(q.width, tall ? 0.3 : 0.15) / 2 });
      }
    }
    if (kind === 'lamp' && /wire|hung|hang|suspend|catenary|seil|pendant|cable/i.test(p.variant || '')) {
      const wr = Array.isArray(p.wire) && p.wire.length >= 2 && p.wire.every((q) => q && isFinite(q[0]) && isFinite(q[1])) ? p.wire : null, zw = z + or(p.height, 7) + 0.28;
      const sp: Wire | null = wr ? { a: [wr[0][0], wr[0][1], or(wr[0][2], zw + 0.5)], b: [wr[wr.length - 1][0], wr[wr.length - 1][1], or(wr[wr.length - 1][2], zw + 0.5)] } : spanWire(C, x, y, zw, num(p.heading));
      if (sp) p = Object.assign({}, p, { _span: sp });
    }
    const W = C.W.solid.frame(fx, fy, fz, h);
    const sh = fn(C, p, W, rng(seedOf(x, y, 2)), fx, fy, fz);
    if (sh && !p._host) blob(C, fx, fy, sh.rx, sh.ry, h, sh.a, fz);
    C.counts.props++;
    if (C.dark) for (const l of lightsOf(p)) {
      const P = C.W.solid.frame(x, y, z, h).P(l.at);
      if (l.glow) C.glows.push({ p: P, size: 1.5 * l.glow, a: 0.8 }, { p: P, size: 0.42 * l.glow, a: 1 });
      pool(C, P[0], P[1], Math.max(3.2, (P[2] - z) * 1.5), (P[2] - z > 7 ? 0.5 : 0.42) * l.power, z);
    }
  }

  // ---------- buildings ----------
  // A colour from the data, fitted to the theme: by day nearly as given, at night the palette's dark tone tinted by it
  function themed(C: Ctx, given: string | null | undefined, def: RGB): RGB {
    const g = hex(given);
    if (!g) return def;
    if (!C.dark) return mix(g, def, 0.42); // the real tone, softened towards the palette so houses stay one family
    const l = Math.max(lum(g), 0.05), k = lum(def) * (0.7 + 0.55 * l);
    return mix(def, [g[0] / l * k, g[1] / l * k, g[2] / l * k], 0.6);
  }
  // The shape of a pitched roof over a footprint: height above the eaves at any point, the flat pieces it is
  // made of, and the lines where it folds (walls are split there, so they meet the roof without gaps).
  function roofModel(type: StationDetailRoof, ring: XY[], H: number, dirDeg?: number) {
    let ang;
    if (num(dirDeg) != null) ang = (90 - dirDeg!) * RAD;
    else { let best = 0; ang = 0; for (let i = 0; i < ring.length; i++) { const a = ring[i], b = ring[(i + 1) % ring.length], l = Math.hypot(b[0] - a[0], b[1] - a[1]); if (l > best) { best = l; ang = Math.atan2(b[1] - a[1], b[0] - a[0]); } } }
    const ux = Math.cos(ang), uy = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const p of ring) { const u = p[0] * ux + p[1] * uy, v = -p[0] * uy + p[1] * ux; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const cu = (u0 + u1) / 2, cv = (v0 + v1) / 2, a = (u1 - u0) / 2, b = (v1 - v0) / 2;
    const toUV = (p: XY | V3): XY => [p[0] * ux + p[1] * uy - cu, -p[0] * uy + p[1] * ux - cv];
    const toXY = (u: number, v: number): XY => [(u + cu) * ux - (v + cv) * uy, (u + cu) * uy + (v + cv) * ux];
    // distance to each eaves line, as [ku, kv, k0]
    const E = type === 'gabled' ? [[0, -1, b], [0, 1, b]] : [[0, -1, b], [0, 1, b], [-1, 0, a], [1, 0, a]];
    const m = type === 'gabled' ? b : Math.min(a, b);
    const prof = type === 'mansard' ? [[0, 0], [Math.min(1.3, m * 0.32), H * 0.68], [m, H]] : [[0, 0], [m, H]];
    const hOfE = (e: number) => { e = clamp(e, 0, m); for (let i = 0; i + 1 < prof.length; i++) if (e <= prof[i + 1][0] + 1e-9) return lerp(prof[i][1], prof[i + 1][1], (e - prof[i][0]) / ((prof[i + 1][0] - prof[i][0]) || 1)); return H; };
    const hAt = (u: number, v: number) => { let e = Infinity; for (const f of E) e = Math.min(e, f[0] * u + f[1] * v + f[2]); return hOfE(e); };
    const folds: number[][] = [];
    for (let j = 0; j < E.length; j++) for (let k = j + 1; k < E.length; k++) folds.push([E[j][0] - E[k][0], E[j][1] - E[k][1], E[j][2] - E[k][2]]);
    for (const f of E) for (let i = 1; i + 1 < prof.length; i++) folds.push([f[0], f[1], f[2] - prof[i][0]]);
    return { E, prof, hAt, hOfE, toUV, toXY, folds, a, b, m, ux, uy };
  }
  function buildBuilding(C: Ctx, b: StationDetailBuilding, index: number) {
    const pal = C.pal, W = C.W.bld.world(), THREE = C.THREE;
    const ring = cleanRing(b.ring);
    const mesh = b.mesh && Array.isArray(b.mesh.positions) && b.mesh.positions.length >= 9 ? b.mesh : null;
    if (!ring && !mesh) { C.warn('building ' + index + ': neither ring nor mesh'); return; }
    const holes = ring ? (b.holes || []).map(cleanRing).filter(Boolean) as Ring[] : [];
    const seedP = ring ? ring[0] : [mesh!.positions[0], mesh!.positions[1]], R = rng(seedOf(seedP[0], seedP[1], 4));
    C.counts.buildings++;

    // the triangles of a given mesh, and what they tell about the heights
    const mt: MeshTri[] = [];
    let mz0 = Infinity, mz1 = -Infinity, mcx = 0, mcy = 0;
    if (mesh) {
      const P = mesh.positions, I = Array.isArray(mesh.indices) && mesh.indices.length ? mesh.indices : null, n = I ? I.length : P.length / 3;
      for (let i = 0; i + 2 < n; i += 3) {
        const ia = I ? I[i] : i, ib = I ? I[i + 1] : i + 1, ic = I ? I[i + 2] : i + 2;
        const A: V3 = [P[ia * 3], P[ia * 3 + 1], P[ia * 3 + 2]], B: V3 = [P[ib * 3], P[ib * 3 + 1], P[ib * 3 + 2]], D: V3 = [P[ic * 3], P[ic * 3 + 1], P[ic * 3 + 2]];
        if (!A.concat(B, D).every(isFinite)) continue;
        const nn = cross(sub(B, A), sub(D, A)), ar = Math.hypot(nn[0], nn[1], nn[2]) / 2;
        if (ar < 1e-6) continue;
        mt.push({ A, B, D, n: [nn[0] / ar / 2, nn[1] / ar / 2, nn[2] / ar / 2], ar });
        for (const q of [A, B, D]) { mz0 = Math.min(mz0, q[2]); mz1 = Math.max(mz1, q[2]); mcx += q[0]; mcy += q[1]; }
      }
      if (!mt.length) { C.warn('building ' + index + ': mesh has no usable triangles'); if (!ring) return; }
      else { mcx /= mt.length * 3; mcy /= mt.length * 3; }
    }
    const isMesh = mt.length > 0, hq = C.high, pathD = (x: number, y: number) => (C.path ? lineDist(C.path, x, y) : 0);
    C.high = hq && (ring ? Math.min(...ring.map((p) => pathD(p[0], p[1]))) : pathD(mcx, mcy)) < 70;
    const gz = ring ? ring.map((p) => C.ground.at(p[0], p[1])).filter((v) => v != null) : [];
    const base = num(b.base) != null ? b.base! : gz.length ? Math.min(...gz) : isMesh ? mz0 : C.z0;
    let eaves = num(b.eaves);
    if (eaves == null && isMesh) { // where most walls end
      const tops = mt.filter((t) => Math.abs(t.n[2]) < 0.3).map((t) => [Math.max(t.A[2], t.B[2], t.D[2]), t.ar]).sort((p, q) => p[0] - q[0]);
      let sum = 0, half = tops.reduce((s, t) => s + t[1], 0) * 0.5;
      eaves = mz1;
      for (const t of tops) { sum += t[1]; if (sum >= half) { eaves = t[0]; break; } }
    }
    if (eaves == null) eaves = base + (num(b.floors) || 4) * 3.1 + 0.6;
    if (eaves < base + 2.4) eaves = base + 2.4;
    let type = ['flat', 'gabled', 'hipped', 'mansard'].includes(b.roof!) ? b.roof! : num(b.ridge) != null && b.ridge! > eaves + 0.6 ? 'gabled' : 'flat';
    if (holes.length && type !== 'flat') type = 'flat';
    let ridge = num(b.ridge);
    const wallC = themed(C, b.color, pal.wall), trim = mix(wallC, pal.trim, 0.7);
    const roofC = themed(C, b.roofColor, type === 'flat' ? pal.roof : pal.roofTile);
    const zBot = Math.min(base, gz.length ? Math.min(...gz) : base) - 0.4;
    const parapet = type === 'flat' && !isMesh ? 0.45 : 0, wallTop = eaves + parapet;
    const wallAt = (col: RGB, z: number) => tone(col, lerp(0.93, 1.02, sat((z - base) / Math.max(1, eaves - base))));
    const cen = ring ? centroid(ring) : [mcx, mcy];
    const inOther = (x: number, y: number) => C.rings.some((r, i) => i !== index && r && x >= r.box[0] && x <= r.box[2] && y >= r.box[1] && y <= r.box[3] && inRing(r, x, y));

    // ----- runs: stretches of wall that are straight, each laid out as one front -----
    const runs: Runs = [];
    if (ring) {
      const n = ring.length, E: RingEdge[] = [];
      for (let i = 0; i < n; i++) {
        const a = ring[i], q = ring[(i + 1) % n], l = Math.hypot(q[0] - a[0], q[1] - a[1]);
        E.push({ i, a, b: q, len: l, t: [(q[0] - a[0]) / l, (q[1] - a[1]) / l], n: [(q[1] - a[1]) / l, -(q[0] - a[0]) / l], gaps: [] });
      }
      const corner = (i: number) => { const p = E[(i - 1 + n) % n].t, q = E[i].t; return Math.abs(p[0] * q[1] - p[1] * q[0]) > 0.1 || p[0] * q[0] + p[1] * q[1] < 0; };
      let start = 0;
      while (start < n && !corner(start)) start++;
      const all = start === n;
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n, e = E[i];
        if (all || corner(i) || !runs.length) runs.push({ edges: [e], A: e.a, B: e.b } as Run);
        else { const r = runs[runs.length - 1]; r.edges.push(e); r.B = e.b; }
      }
      for (const r of runs) {
        const dx = r.B[0] - r.A[0], dy = r.B[1] - r.A[1];
        r.len = Math.hypot(dx, dy) || 1e-6; r.t = [dx / r.len, dy / r.len]; r.n = [r.t[1], -r.t[0]];
      }
      runs.E = E;
    } else for (const f of b.faces || []) {
      if (!f || !f.a || !f.b) continue;
      const dx = f.b[0] - f.a[0], dy = f.b[1] - f.a[1], len = Math.hypot(dx, dy);
      if (len < 0.5) continue;
      const t: XY = [dx / len, dy / len];
      let n: XY = [t[1], -t[0]];
      // which side is outside: the heading of the face if given, else away from the middle of the house
      const out = num(f.heading) != null ? [Math.sin(f.heading! * RAD), Math.cos(f.heading! * RAD)] : [f.a[0] + dx / 2 - cen[0], f.a[1] + dy / 2 - cen[1]];
      if (out[0] * n[0] + out[1] * n[1] < 0) n = [-n[0], -n[1]];
      runs.push({ edges: [] as RingEdge[], A: f.a, B: f.b, len, t, n, spec: f } as Run);
    }
    for (const r of runs) {
      if (!r.spec) { // the entry of `faces` that describes this wall, if any
        let best: { f: StationDetailFace; ov: number } | null = null;
        for (const f of b.faces || []) {
          if (!f || !f.a || !f.b) continue;
          const pd = (p: XY) => Math.abs((p[0] - r.A[0]) * r.t[1] - (p[1] - r.A[1]) * r.t[0]);
          if (pd(f.a) > 0.8 || pd(f.b) > 0.8) continue;
          const sa = (f.a[0] - r.A[0]) * r.t[0] + (f.a[1] - r.A[1]) * r.t[1], sb = (f.b[0] - r.A[0]) * r.t[0] + (f.b[1] - r.A[1]) * r.t[1];
          const ov = Math.min(r.len, Math.max(sa, sb)) - Math.max(0, Math.min(sa, sb));
          if (ov < 0.5 * Math.min(r.len, Math.abs(sb - sa))) continue;
          if (!best || ov > best.ov) best = { f, ov };
        }
        r.spec = best ? best.f : {};
      }
      const s = r.spec, mx = (r.A[0] + r.B[0]) / 2 + r.n[0] * 0.35, my = (r.A[1] + r.B[1]) / 2 + r.n[1] * 0.35;
      r.party = inOther(mx, my);
      r.col = s.color ? themed(C, s.color, pal.wall) : wallC;
      const wn = s.windows && typeof s.windows === 'object' ? s.windows : {};
      r.floors = Math.max(1, Math.round(or(wn.floors, or(s.floors, or(b.floors, (eaves - base - 0.4) / 3.05)))));
      r.kind = s.groundFloor || b.groundFloor || 'plain';
      r.bays = Math.max(1, Math.round(or(wn.bays, or(s.bays, r.len / 3.1))));
      const nom = (eaves - base - 0.35) / r.floors;
      r.gf = r.floors === 1 ? eaves - base - 0.35 : r.kind === 'arcade' ? clamp(nom * 1.3, 3.4, 4.8) : r.kind === 'shop' ? clamp(nom * 1.2, 3.2, 4.4) : nom;
      if (r.floors > 1 && eaves - base - 0.35 - r.gf < 2.3 * (r.floors - 1)) r.gf = nom;
      r.fh = r.floors > 1 ? (eaves - base - 0.35 - r.gf) / (r.floors - 1) : 0;
      r.deco = !r.party && r.len >= 2;
      r.Q = (s2, out, z) => [r.A[0] + r.t[0] * s2 + r.n[0] * out, r.A[1] + r.t[1] * s2 + r.n[1] * out, z];
      r.zg = (s2) => { const q = r.Q(s2, 0.35, 0), g = C.ground.at(q[0], q[1]); return g == null ? base : clamp(g, base - 1.5, base + 1.2); };
      // a real arcade needs room behind the front: how deep is the house here?
      r.arcade = false;
      if (r.kind === 'arcade' && r.deco && !isMesh && ring && r.len >= 3) {
        const o = r.Q(r.len / 2, -0.05, 0);
        let depth = Infinity;
        for (const e of runs.E!) {
          const den = -r.n[0] * (e.b[1] - e.a[1]) + r.n[1] * (e.b[0] - e.a[0]);
          if (Math.abs(den) < 1e-9) continue;
          const tt = ((e.a[0] - o[0]) * (e.b[1] - e.a[1]) - (e.a[1] - o[1]) * (e.b[0] - e.a[0])) / den;
          const uu = ((e.a[0] - o[0]) * -r.n[1] - (e.a[1] - o[1]) * -r.n[0]) / den;
          if (tt > 0.01 && uu >= 0 && uu <= 1) depth = Math.min(depth, tt);
        }
        r.D = Math.min(or(b.arcadeDepth, 3.2), depth * 0.45);
        r.arcade = r.D >= 1.3;
        r.pd = 0.55;
      }
    }
    // an arcade passes through the side walls at both ends, so walkways of neighbours join up
    if (ring) for (const r of runs) {
      if (!r.arcade) continue;
      for (const e of r.edges) e.gaps.push({ s0: 0, s1: e.len, top: base + r.gf });
      const n = ring.length, first = r.edges[0], last = r.edges[r.edges.length - 1];
      const prev = runs.E![(first.i - 1 + n) % n], next = runs.E![(last.i + 1) % n];
      const side = (e: RingEdge) => Math.abs(e.t[0] * r.t[0] + e.t[1] * r.t[1]) < 0.5 && !runs.some((q) => q.arcade && q.edges.includes(e));
      r.openA = side(prev) && prev.t[0] * r.t[1] - prev.t[1] * r.t[0] > 0;
      r.openB = side(next) && r.t[0] * next.t[1] - r.t[1] * next.t[0] > 0;
      if (r.openA) prev.gaps.push({ s0: Math.max(0, prev.len - r.D), s1: prev.len - r.pd, top: base + r.gf - 0.35 });
      if (r.openB) next.gaps.push({ s0: r.pd, s1: Math.min(next.len, r.D), top: base + r.gf - 0.35 });
    }

    // ----- walls and roof of the plain prism -----
    if (ring && !isMesh) {
      const rm = type === 'flat' ? null : roofModel(type, ring, Math.max(0.6, (ridge != null ? ridge : eaves + Math.min(5, 0.4 * Math.sqrt(Math.abs(area2(ring))))) - eaves), b.ridgeDir);
      const hUV = (p: XY | V3) => (rm ? rm.hAt(...rm.toUV(p)) : 0);
      const wall = (e: Wall, col: RGB, out: number) => {
        const P = (s: number, z: number): V3 => [e.a[0] + e.t[0] * s, e.a[1] + e.t[1] * s, z], hint: V3 = [e.n[0] * out, e.n[1] * out, 0];
        const piece = (s0: number, s1: number, z0: number) => { if (s1 - s0 > 1e-4) W.quad(P(s0, z0), P(s1, z0), P(s1, wallTop), P(s0, wallTop), [wallAt(col, z0), wallAt(col, z0), wallAt(col, wallTop), wallAt(col, wallTop)], { n: hint }); };
        let s = 0;
        for (const g of e.gaps.slice().sort((p, q) => p.s0 - q.s0)) { piece(s, g.s0, zBot); piece(Math.max(s, g.s0), g.s1, g.top); s = Math.max(s, g.s1); }
        piece(s, e.len, zBot);
        if (rm) { // the gable: the wall above the eaves, up to the roof
          const pa = rm.toUV(e.a), pb = rm.toUV(e.b), ts = [0, 1];
          for (const f of rm.folds) { const fa = f[0] * pa[0] + f[1] * pa[1] + f[2], fb = f[0] * pb[0] + f[1] * pb[1] + f[2]; if (fa * fb < 0) ts.push(fa / (fa - fb)); }
          ts.sort((p, q) => p - q);
          for (let k = 0; k + 1 < ts.length; k++) {
            if (ts[k + 1] - ts[k] < 1e-6) continue;
            const s0 = ts[k] * e.len, s1 = ts[k + 1] * e.len, h0 = hUV(P(s0, 0)), h1 = hUV(P(s1, 0));
            if (Math.max(h0, h1) > 0.02) W.quad(P(s0, eaves), P(s1, eaves), P(s1, eaves + h1), P(s0, eaves + h0), wallAt(col, eaves), { n: hint });
          }
          e.gable = Math.max(hUV(e.a), hUV(e.b)) > 0.05;
        }
      };
      for (const r of runs) for (const e of r.edges) wall(e, r.col, 1);
      for (const h of holes) for (let i = 0; i < h.length; i++) { // courtyard walls look inwards
        const a = h[i], q = h[(i + 1) % h.length], l = Math.hypot(q[0] - a[0], q[1] - a[1]);
        if (l > 1e-4) wall({ a, b: q, len: l, t: [(q[0] - a[0]) / l, (q[1] - a[1]) / l], n: [(q[1] - a[1]) / l, -(q[0] - a[0]) / l], gaps: [] }, wallC, -1);
      }
      if (!rm) {
        const all = ring.concat(...holes);
        for (const t of triangulate(THREE, ring, holes)) W.tri([all[t[0]][0], all[t[0]][1], eaves], [all[t[1]][0], all[t[1]][1], eaves], [all[t[2]][0], all[t[2]][1], eaves], roofC, { n: [0, 0, 1] });
        // the parapet: a rim around the flat roof
        const fr = lineFrames(ring, true), top = mix(wallC, pal.trim, 0.6), inner = tone(wallC, 0.82);
        for (let i = 0; i < fr.length; i++) {
          const j = (i + 1) % fr.length, a = fr[i].p, q = fr[j].p, ia = offPt(fr[i], 0.3), iq = offPt(fr[j], 0.3), e = runs.E![i];
          W.quad([a[0], a[1], wallTop], [q[0], q[1], wallTop], [iq[0], iq[1], wallTop], [ia[0], ia[1], wallTop], top, { n: [0, 0, 1] });
          W.quad([ia[0], ia[1], eaves], [iq[0], iq[1], eaves], [iq[0], iq[1], wallTop], [ia[0], ia[1], wallTop], inner, { n: [-e.n[0], -e.n[1], 0] });
        }
        if (C.high && Math.abs(area2(ring)) > 90 && !holes.length && inRing(ring, cen[0], cen[1])) { // the lift overrun
          const ax = longAxis(ring)!, ux = ax.ux, uy = ax.uy, o = (R() - 0.5) * 0.3 * ax.len;
          W.obox([cen[0] + ux * o, cen[1] + uy * o, eaves + 0.75], [ux * 1.5, uy * 1.5, 0], [-uy * 1.1, ux * 1.1, 0], [0, 0, 0.75], tone(wallC, 0.97), { top: mix(roofC, WHITE, 0.15), skip: '-z' });
        }
      } else {
        const uv = ring.map(rm.toUV);
        for (let k = 0; k < rm.E.length; k++) for (let i = 0; i + 1 < rm.prof.length; i++) {
          let poly: XY[] | null = uv;
          for (let j = 0; j < rm.E.length && poly.length >= 3; j++) if (j !== k) poly = clipPoly(poly, rm.E[j][0] - rm.E[k][0], rm.E[j][1] - rm.E[k][1], rm.E[j][2] - rm.E[k][2]);
          if (poly.length >= 3) poly = clipPoly(poly, rm.E[k][0], rm.E[k][1], rm.E[k][2] - rm.prof[i][0]);
          if (poly.length >= 3 && i + 2 < rm.prof.length) poly = clipPoly(poly, -rm.E[k][0], -rm.E[k][1], rm.prof[i + 1][0] - rm.E[k][2]);
          poly = cleanRing(poly);
          if (!poly) continue;
          const P = (q: XY): V3 => { const xy = rm.toXY(q[0], q[1]); return [xy[0], xy[1], eaves + rm.hOfE(rm.E[k][0] * q[0] + rm.E[k][1] * q[1] + rm.E[k][2])]; };
          for (const t of triangulate(THREE, poly)) W.tri(P(poly[t[0]]), P(poly[t[1]]), P(poly[t[2]]), roofC, { n: [0, 0, 1] });
        }
        if (C.high) { // chimneys near the ridge
          const nc = 1 + (R() < 0.5 ? 1 : 0), span = type === 'gabled' ? rm.a : Math.max(0, rm.a - rm.b), cc = mix(wallC, roofC, 0.35);
          for (let i = 0; i < nc; i++) {
            const u = (nc === 1 ? (R() - 0.5) : (i ? 1 : -1) * (0.3 + R() * 0.4)) * span * 0.9, v = (R() < 0.5 ? -1 : 1) * Math.min(0.9, rm.m * 0.25), xy = rm.toXY(u, v);
            if (!inRing(ring, xy[0], xy[1])) continue;
            const zt = eaves + rm.hAt(u, 0) + 0.75, zb2 = eaves + rm.hAt(u, v) - 0.4;
            W.obox([xy[0], xy[1], (zt + zb2) / 2], [rm.ux * 0.42, rm.uy * 0.42, 0], [-rm.uy * 0.3, rm.ux * 0.3, 0], [0, 0, (zt - zb2) / 2], cc, { top: tone(cc, 0.7), skip: '-z' });
          }
        }
        if (C.high && type === 'mansard') { // dormers in the steep part
          const w1 = rm.prof[1][0], h1 = rm.prof[1][1], s1 = h1 / w1;
          for (const sg of [1, -1]) {
            const n = Math.max(1, Math.round(rm.a * 2 / 3.2) - 1);
            for (let i = 0; i < n; i++) {
              const u = (n === 1 ? 0 : -1 + (2 * i) / (n - 1)) * (rm.a - 2.2), e0 = 0.22, zb2 = eaves + s1 * e0, zt = Math.min(eaves + h1 + 0.25, zb2 + 1.35), e1 = Math.min(w1 + 0.6, (zt - eaves) / s1 + 0.1);
              const c = rm.toXY(u, sg * (rm.b - (e0 + e1) / 2)), fx = -rm.uy * sg, fy = rm.ux * sg;
              if (!inRing(ring, c[0], c[1])) continue;
              W.obox([c[0], c[1], (zb2 + zt) / 2], [rm.ux * 0.6, rm.uy * 0.6, 0], [fx * (e1 - e0) / 2, fy * (e1 - e0) / 2, 0], [0, 0, (zt - zb2) / 2], tone(wallC, 0.98), { top: tone(roofC, 0.92), skip: '-z-y' });
              const f = rm.toXY(u, sg * (rm.b - e0 + 0.012)), lit = C.dark && R() < 0.3;
              W.quad([f[0] - rm.ux * 0.4, f[1] - rm.uy * 0.4, zb2 + 0.25], [f[0] + rm.ux * 0.4, f[1] + rm.uy * 0.4, zb2 + 0.25], [f[0] + rm.ux * 0.4, f[1] + rm.uy * 0.4, zt - 0.2], [f[0] - rm.ux * 0.4, f[1] - rm.uy * 0.4, zt - 0.2], lit ? pal.glassLit : pal.glass, { n: [fx, fy, 0], mode: lit ? 1 : 0 });
            }
          }
        }
      }
    }
    // ----- a given mesh: real geometry, walls and roofs told apart by their slope -----
    if (isMesh) {
      C.meshBuildings = true;
      for (const t of mt) {
        let n = t.n, flip = false;
        const mid = [(t.A[0] + t.B[0] + t.D[0]) / 3, (t.A[1] + t.B[1] + t.D[1]) / 3];
        let col: Col;
        if (Math.abs(n[2]) < 0.3) {
          const inwards = ring ? inRing(ring, mid[0] + n[0] * 0.25, mid[1] + n[1] * 0.25) && !inRing(ring, mid[0] - n[0] * 0.25, mid[1] - n[1] * 0.25) : (mid[0] - cen[0]) * n[0] + (mid[1] - cen[1]) * n[1] < 0;
          flip = inwards;
          col = (P) => wallAt(wallC, P[2]);
        } else {
          flip = n[2] < 0 && (t.A[2] + t.B[2] + t.D[2]) / 3 > base + 2;
          col = n[2] < -0.3 && !flip ? tone(wallC, 0.7) : Math.abs(n[2]) > 0.985 ? (b.roofColor ? roofC : themed(C, null, pal.roof)) : (b.roofColor || type !== 'flat' ? roofC : pal.roofTile);
        }
        W.tri(t.A, t.B, t.D, col, { n: flip ? [-n[0], -n[1], -n[2]] : n });
      }
    }
    // the height of a mesh roof above a point (null beside the house)
    const roofTris = mt.filter((t) => Math.abs(t.n[2]) >= 0.3 && (t.A[2] + t.B[2] + t.D[2]) / 3 > base + 2);
    const roofZ = (x: number, y: number) => {
      let best: number | null = null;
      for (const t of roofTris) {
        const d = (t.B[0] - t.A[0]) * (t.D[1] - t.A[1]) - (t.B[1] - t.A[1]) * (t.D[0] - t.A[0]);
        if (Math.abs(d) < 1e-9) continue;
        const w1 = ((x - t.A[0]) * (t.D[1] - t.A[1]) - (y - t.A[1]) * (t.D[0] - t.A[0])) / d, w2 = ((t.B[0] - t.A[0]) * (y - t.A[1]) - (t.B[1] - t.A[1]) * (x - t.A[0])) / d;
        if (w1 < -1e-6 || w2 < -1e-6 || w1 + w2 > 1 + 1e-6) continue;
        const z = t.A[2] + (t.B[2] - t.A[2]) * w1 + (t.D[2] - t.A[2]) * w2;
        if (best == null || z > best) best = z;
      }
      return best;
    };
    // a dormer standing in a steep mesh roof, above the bay at s of a run
    const dormer = (r: Run, s: number, RW: Rng) => {
      const f = r.Q(s, -0.55, 0), zf = roofZ(f[0], f[1]);
      if (zf == null || zf < eaves - 1.2) return;
      const zt = zf + 1.5;
      let depth = 0, zb2 = zf;
      for (let d = 0.95; d <= 4.3; d += 0.4) { const q = r.Q(s, -d, 0), z = roofZ(q[0], q[1]); if (z == null) break; depth = d; zb2 = z; if (z >= zt) break; }
      if (depth < 1.3 || zb2 - zf < 0.9) return;
      W.obox(r.Q(s, -(0.55 + depth) / 2, (zf + zt) / 2 - 0.1), [r.t[0] * 0.62, r.t[1] * 0.62, 0], [r.n[0] * (depth - 0.55) / 2, r.n[1] * (depth - 0.55) / 2, 0], [0, 0, (zt - zf) / 2 + 0.1], tone(wallC, 0.98), { top: tone(roofC, 0.9), skip: '-z-y' });
      const lit = C.dark && RW() < 0.3, g = lit ? pal.glassLit : pal.glass;
      W.quad(r.Q(s - 0.4, -0.538, zf + 0.3), r.Q(s + 0.4, -0.538, zf + 0.3), r.Q(s + 0.4, -0.538, zt - 0.22), r.Q(s - 0.4, -0.538, zt - 0.22), lit ? g : [mix(g, pal.sky, C.dark ? 0 : 0.4), mix(g, pal.sky, C.dark ? 0 : 0.4), g, g], { n: [r.n[0], r.n[1], 0], mode: lit ? 1 : 0 });
    };

    // ----- what is on the walls -----
    let off0 = isMesh ? 0.07 : 0;
    const shut = C.high && b.shutters ? (hex(b.shutters) && !C.dark ? mix(hex(b.shutters)!, pal.shutters[0], 0.3) : pal.shutters[Math.floor(R() * pal.shutters.length) % pal.shutters.length]) : null; // only where the data says so
    let budget = C.windowBudget;
    for (const r of runs) {
      if (!r.deco) continue;
      const rd = pathD((r.A[0] + r.B[0]) / 2, (r.A[1] + r.B[1]) / 2);
      if (!hq && rd > 95) continue; // at low quality the far houses are plain blocks
      C.high = hq && rd < 48; // sills, glazing bars and lintels only where they can be seen
      const Q = r.Q, nrm: V3 = [r.n[0], r.n[1], 0], tdir: V3 = [r.t[0], r.t[1], 0], gfTop = base + r.gf, RW = rng(seedOf(r.A[0], r.A[1], 9));
      const rect = (s0: number, s1: number, z0: number, z1: number, out: number, col: Cols, opt?: QuadOpt) => W.quad(Q(s0, off0 + out, z0), Q(s1, off0 + out, z0), Q(s1, off0 + out, z1), Q(s0, off0 + out, z1), col, Object.assign({ n: nrm }, opt));
      const ledge = (s0: number, s1: number, z0: number, z1: number, out: number, col: RGB, topCol?: RGB, slim?: boolean) => { // a band that stands out from the wall (slim: front and top only)
        rect(s0, s1, z0, z1, out, col);
        W.quad(Q(s0, off0, z1), Q(s1, off0, z1), Q(s1, off0 + out, z1), Q(s0, off0 + out, z1), topCol || col, { n: [0, 0, 1] });
        W.quad(Q(s0, off0, z0), Q(s1, off0, z0), Q(s1, off0 + out, z0), Q(s0, off0 + out, z0), tone(col, 0.8), { n: [0, 0, -1] });
        if (slim) return;
        W.quad(Q(s0, off0, z0), Q(s0, off0 + out, z0), Q(s0, off0 + out, z1), Q(s0, off0, z1), col, { n: [-tdir[0], -tdir[1], 0] });
        W.quad(Q(s1, off0, z0), Q(s1, off0 + out, z0), Q(s1, off0 + out, z1), Q(s1, off0, z1), col, { n: tdir });
      };
      const rtrim = mix(r.col, pal.trim, 0.82), glassT = tone(pal.glass, C.dark ? 1 : 0.82), glassB = C.dark ? tone(pal.glass, 1.25) : mix(pal.glass, pal.sky, 0.3);
      const simple = !C.high || budget < 0;
      const glow = () => { const k = RW(); return mix(pal.glassLit, hex(k < 0.5 ? '#F3B56B' : '#FFF3D6')!, RW() * 0.45); };
      const win = (sc: number, z0: number, ww: number, wh: number, litP: number, door?: boolean) => {
        if (!simple) budget--; // only windows drawn in full count against the budget
        const lit = C.dark && RW() < litP, v = 0.94 + RW() * 0.12;
        rect(sc - ww / 2 - 0.1, sc + ww / 2 + 0.1, z0 - 0.05, z0 + wh + 0.12, 0.03, rtrim);
        if (lit) { const g = glow(); rect(sc - ww / 2, sc + ww / 2, z0, z0 + wh, 0.045, [g, g, tone(g, 0.86), tone(g, 0.86)], { mode: 1 }); }
        else rect(sc - ww / 2, sc + ww / 2, z0, z0 + wh, 0.045, [tone(glassB, v), tone(glassB, v), tone(glassT, v), tone(glassT, v)]);
        if (simple) return;
        const bar = lit ? tone(rtrim, C.dark ? 0.75 : 0.6) : rtrim;
        rect(sc - 0.022, sc + 0.022, z0, z0 + wh, 0.052, bar);
        rect(sc - ww / 2, sc + ww / 2, z0 + wh * 0.68 - 0.02, z0 + wh * 0.68 + 0.02, 0.052, bar);
        if (!door) ledge(sc - ww / 2 - 0.14, sc + ww / 2 + 0.14, z0 - 0.1, z0 - 0.04, 0.13, rtrim, mix(rtrim, WHITE, C.dark ? 0.05 : 0.3), true);
        if (shut && r.len / r.bays - ww > 1.15) for (const sd of [-1, 1]) rect(sc + sd * (ww / 2 + 0.12), sc + sd * (ww / 2 + 0.12 + ww * 0.46), z0 - 0.02, z0 + wh + 0.04, 0.06, shut);
      };
      const bw = r.len / r.bays, town = /town/i.test(String(r.spec.style || b.style || ''));
      // What stands out from this front, from the data: stone bay windows (Erker) and balconies.
      //   bayWindows | oriels: n  or  [{ bay: 2 | at: 0.5, floors: [1, 3], width: 2.6, depth: 0.8 }]   (floors: first and last upper floor, 1 = the one above the ground floor)
      //   balconies: n (that many per floor on the main floors)  or  [0, 2, 2, 1] (a count per upper floor)  or  [{ bay: 3, floor: 2, width: 2.4 }]
      const upper = r.floors - 1, taken = new Set<string>(); // "floor:bay" where something stands in front of the window
      const sAtBay = (q: { bay?: number; at?: number }) => (num(q.bay) != null ? (clamp(Math.round(q.bay!), 0, r.bays - 1) + 0.5) * bw : clamp(or(q.at, 0.5), 0, 1) * r.len);
      const spread = (n: number) => { const out: number[] = []; for (let i = 0; i < n; i++) out.push(clamp(Math.round((i + 0.5) * r.bays / n - 0.5), 0, r.bays - 1)); return out; };
      const oriels: Oriel[] = [];
      { const src = r.spec.bayWindows != null ? r.spec.bayWindows : r.spec.oriels;
        if (Array.isArray(src)) for (const q of src) { if (q && typeof q === 'object') oriels.push({ s: sAtBay(q), f0: clamp(Math.round(or(q.floors && q.floors[0], 1)), 1, Math.max(1, upper)), f1: clamp(Math.round(or(q.floors && q.floors[1], upper - 1)), 1, Math.max(1, upper)), w: or(q.width, Math.min(2.6, bw * 0.95)), d: or(q.depth, 0.8) }); }
        else if (num(src)! > 0) for (const bay of spread(Math.min(Math.round(src!), r.bays))) oriels.push({ s: (bay + 0.5) * bw, f0: 1, f1: Math.max(1, upper - 1), w: Math.min(2.6, bw * 0.95), d: 0.8 }); }
      const balc: Balcony[] = [];
      { const src = r.spec.balconies;
        if (Array.isArray(src) && src.length && typeof src[0] === 'object') { for (const q of src as StationDetailBalcony[]) if (q) balc.push({ s: sAtBay(q), floor: clamp(Math.round(or(q.floor, 1)), 1, Math.max(1, upper)), w: or(q.width, Math.min(2.4, bw * 0.92)) }); }
        else if (Array.isArray(src)) (src as number[]).forEach((n, i) => { if (i < upper) for (const bay of spread(Math.min(Math.round(n) || 0, r.bays))) balc.push({ s: (bay + 0.5) * bw, floor: i + 1, w: Math.min(2.4, bw * 0.92) }); });
        else if (num(src)! > 0) for (let fl = 1; fl <= Math.min(upper, Math.max(1, upper - 1)); fl++) for (const bay of spread(Math.min(Math.round(src!), r.bays))) balc.push({ s: (bay + 0.5) * bw, floor: fl, w: Math.min(2.4, bw * 0.92) }); }
      if (upper < 1 || r.fh < 2) { oriels.length = 0; balc.length = 0; }
      const stoneD = tone(r.col, 0.93), railC = tone(pal.metal, C.dark ? 0.9 : 0.75);
      for (const o of oriels) {
        // a bay window: a stone box on a corbel, a window per floor in its front and narrow ones in its cheeks, a small roof
        const z0 = gfTop + (o.f0 - 1) * r.fh - 0.1, z1 = gfTop + o.f1 * r.fh - 0.25, s0 = o.s - o.w / 2, s1 = o.s + o.w / 2, d = o.d;
        for (let fl = o.f0; fl <= o.f1; fl++) taken.add(fl + ':' + Math.floor(o.s / bw));
        W.fan([Q(s0 + 0.25, off0, z0 - 0.55), Q(s1 - 0.25, off0, z0 - 0.55), Q(s1, off0 + d, z0), Q(s0, off0 + d, z0)], tone(stoneD, 0.82), { n: [nrm[0], nrm[1], -1.2] });
        W.tri(Q(s0 + 0.25, off0, z0 - 0.55), Q(s0, off0 + d, z0), Q(s0, off0, z0), tone(stoneD, 0.86), { n: [-tdir[0], -tdir[1], 0] });
        W.tri(Q(s1 - 0.25, off0, z0 - 0.55), Q(s1, off0 + d, z0), Q(s1, off0, z0), tone(stoneD, 0.86), { n: tdir });
        W.quad(Q(s0, off0 + d, z0), Q(s1, off0 + d, z0), Q(s1, off0 + d, z1), Q(s0, off0 + d, z1), r.col, { n: nrm });
        W.quad(Q(s0, off0, z0), Q(s0, off0 + d, z0), Q(s0, off0 + d, z1), Q(s0, off0, z1), stoneD, { n: [-tdir[0], -tdir[1], 0] });
        W.quad(Q(s1, off0, z0), Q(s1, off0 + d, z0), Q(s1, off0 + d, z1), Q(s1, off0, z1), stoneD, { n: tdir });
        W.quad(Q(s0 - 0.08, off0, z1 + 0.45), Q(s1 + 0.08, off0, z1 + 0.45), Q(s1 + 0.08, off0 + d + 0.1, z1), Q(s0 - 0.08, off0 + d + 0.1, z1), mix(rtrim, WHITE, C.dark ? 0.05 : 0.3), { n: [nrm[0] * 0.4, nrm[1] * 0.4, 1] }); // a stone top
        for (const sd of [s0 - 0.08, s1 + 0.08]) W.tri(Q(sd, off0, z1 + 0.45), Q(sd, off0 + d + 0.1, z1), Q(sd, off0, z1), stoneD, { two: true });
        for (let fl = o.f0; fl <= o.f1; fl++) {
          const zf = gfTop + (fl - 1) * r.fh, wh = clamp(r.fh * 0.6, 1.0, 2.1), zw = zf + (r.fh - wh) * 0.45, ww = o.w - 0.7, lit = C.dark && RW() < 0.35, g = lit ? glow() : null;
          W.quad(Q(s0, off0 + d + 0.012, zf - 0.08), Q(s1, off0 + d + 0.012, zf - 0.08), Q(s1, off0 + d + 0.012, zf + 0.06), Q(s0, off0 + d + 0.012, zf + 0.06), rtrim, { n: nrm });
          W.quad(Q(o.s - ww / 2 - 0.08, off0 + d + 0.02, zw - 0.05), Q(o.s + ww / 2 + 0.08, off0 + d + 0.02, zw - 0.05), Q(o.s + ww / 2 + 0.08, off0 + d + 0.02, zw + wh + 0.1), Q(o.s - ww / 2 - 0.08, off0 + d + 0.02, zw + wh + 0.1), rtrim, { n: nrm });
          for (let p = 0; p < 2; p++) { const a0 = o.s - ww / 2 + p * (ww / 2 + 0.03), a1 = a0 + ww / 2 - 0.03; W.quad(Q(a0, off0 + d + 0.035, zw), Q(a1, off0 + d + 0.035, zw), Q(a1, off0 + d + 0.035, zw + wh), Q(a0, off0 + d + 0.035, zw + wh), lit ? [g!, g!, tone(g!, 0.86), tone(g!, 0.86)] : [glassB, glassB, glassT, glassT], { n: nrm, mode: lit ? 1 : 0 }); }
          if (d >= 0.6) for (const [sd, hn] of [[s0 - 0.012, [-tdir[0], -tdir[1], 0]], [s1 + 0.012, tdir]] as [number, V3][]) W.quad(Q(sd, off0 + 0.18, zw), Q(sd, off0 + d - 0.18, zw), Q(sd, off0 + d - 0.18, zw + wh), Q(sd, off0 + 0.18, zw + wh), lit ? g! : [glassB, glassB, glassT, glassT], { n: hn, mode: lit ? 1 : 0 });
        }
      }
      for (const q of balc) {
        // a balcony: a stone slab on two brackets, an iron railing
        if (taken.has(q.floor + ':' + Math.floor(q.s / bw))) continue;
        const zf = gfTop + (q.floor - 1) * r.fh + 0.1, s0 = q.s - q.w / 2, s1 = q.s + q.w / 2, d = 0.85, zr = zf + 0.95;
        W.obox(Q(q.s, off0 + d / 2, zf - 0.07), [tdir[0] * q.w / 2, tdir[1] * q.w / 2, 0], [nrm[0] * d / 2, nrm[1] * d / 2, 0], [0, 0, 0.07], stoneD, { top: mix(rtrim, WHITE, C.dark ? 0.05 : 0.3), skip: '-y' });
        for (const sb of [s0 + 0.25, s1 - 0.25]) W.tri(Q(sb, off0, zf - 0.14), Q(sb, off0 + d * 0.8, zf - 0.14), Q(sb, off0, zf - 0.6), tone(stoneD, 0.85), { two: true });
        const rail = (a: V3, c2: V3, z: number, th: number) => W.obox([(a[0] + c2[0]) / 2, (a[1] + c2[1]) / 2, z], [(c2[0] - a[0]) / 2, (c2[1] - a[1]) / 2, 0], (() => { const l = Math.hypot(c2[0] - a[0], c2[1] - a[1]) || 1; return [-(c2[1] - a[1]) / l * th, (c2[0] - a[0]) / l * th, 0]; })(), [0, 0, th], railC, { skip: '+x-x' });
        const c0 = Q(s0 + 0.03, off0 + 0.02, 0), c1 = Q(s0 + 0.03, off0 + d - 0.04, 0), c3 = Q(s1 - 0.03, off0 + d - 0.04, 0), c4 = Q(s1 - 0.03, off0 + 0.02, 0);
        for (const [a, c2] of [[c0, c1], [c1, c3], [c3, c4]]) {
          rail(a, c2, zr, 0.022); rail(a, c2, zf + 0.12, 0.014);
          const l = Math.hypot(c2[0] - a[0], c2[1] - a[1]), n = Math.max(1, Math.round(l / (C.high ? 0.14 : 0.3))), ux = (c2[0] - a[0]) / l * 0.011, uy = (c2[1] - a[1]) / l * 0.011;
          for (let i = 1; i < n; i++) { const x = lerp(a[0], c2[0], i / n), y = lerp(a[1], c2[1], i / n); W.quad([x - ux, y - uy, zf + 0.12], [x + ux, y + uy, zf + 0.12], [x + ux, y + uy, zr], [x - ux, y - uy, zr], railC, { two: true }); }
        }
        taken.add('b' + q.floor + ':' + Math.floor(q.s / bw)); // the window behind becomes a door to the floor
      }
      // a town house: the middle of a wide front stands a hand's breadth forward, with a lintel over its windows
      const mid0 = town && r.bays >= 5 ? Math.floor((r.bays - (r.bays % 2 ? 3 : 2)) / 2) : -1, mid1 = mid0 < 0 ? -1 : mid0 + (r.bays % 2 ? 3 : 2);
      if (mid0 >= 0 && upper >= 1) {
        const s0 = mid0 * bw + 0.12, s1 = mid1 * bw - 0.12, zt = (type === 'flat' ? wallTop : eaves) - 0.3;
        W.quad(Q(s0, off0 + 0.16, gfTop), Q(s1, off0 + 0.16, gfTop), Q(s1, off0 + 0.16, zt), Q(s0, off0 + 0.16, zt), [wallAt(r.col, gfTop), wallAt(r.col, gfTop), wallAt(r.col, zt), wallAt(r.col, zt)], { n: nrm });
        W.quad(Q(s0, off0, gfTop), Q(s0, off0 + 0.16, gfTop), Q(s0, off0 + 0.16, zt), Q(s0, off0, zt), stoneD, { n: [-tdir[0], -tdir[1], 0] });
        W.quad(Q(s1, off0, gfTop), Q(s1, off0 + 0.16, gfTop), Q(s1, off0 + 0.16, zt), Q(s1, off0, zt), stoneD, { n: tdir });
      }
      const fwd = (i: number) => (i >= mid0 && i < mid1 ? 0.16 : 0);
      // upper floors: a line under each, a window per bay
      for (let k = 0; k + 1 < r.floors; k++) {
        const zf = gfTop + k * r.fh;
        if (C.high) ledge(0, r.len, zf - 0.09, zf + 0.07, 0.09, rtrim, mix(rtrim, WHITE, C.dark ? 0.05 : 0.3)); else rect(0, r.len, zf - 0.09, zf + 0.07, 0.03, rtrim);
        if (mid0 >= 0 && C.high) { off0 += 0.16; ledge(mid0 * bw + 0.12, mid1 * bw - 0.12, zf - 0.09, zf + 0.07, 0.09, rtrim, mix(rtrim, WHITE, C.dark ? 0.05 : 0.3)); off0 -= 0.16; }
        if (bw < 1.3) continue;
        const ww = clamp(bw * 0.42, 0.7, 1.35), wh = clamp(r.fh * 0.6, 1.0, 2.1);
        for (let i = 0; i < r.bays; i++) {
          if (taken.has((k + 1) + ':' + i)) continue;
          const door = taken.has('b' + (k + 1) + ':' + i), z0 = zf + (door ? 0.14 : (r.fh - wh) * 0.45), h2 = door ? wh + (r.fh - wh) * 0.45 - 0.14 : wh;
          off0 += fwd(i);
          win((i + 0.5) * bw, z0, ww, h2, 0.3, door);
          if (town && C.high && !simple) ledge((i + 0.5) * bw - ww / 2 - 0.2, (i + 0.5) * bw + ww / 2 + 0.2, z0 + h2 + 0.16, z0 + h2 + 0.26, 0.12, rtrim, mix(rtrim, WHITE, C.dark ? 0.05 : 0.3), true);
          off0 -= fwd(i);
        }
      }
      // the line under the roof
      const eave = !r.edges.length || r.edges.every((e) => !e.gable);
      if (eave) {
        const o = type === 'flat' ? 0.12 : 0.38, zt = type === 'flat' ? wallTop : eaves;
        if (type !== 'flat' && C.high) ledge(-0.14, r.len + 0.14, zt - 0.5, zt - 0.34, 0.14, rtrim, mix(rtrim, WHITE, C.dark ? 0.05 : 0.3));
        ledge(-o, r.len + o, zt - (type === 'flat' ? 0.18 : 0.34), zt + 0.03, o, rtrim, type === 'flat' || isMesh ? mix(rtrim, WHITE, C.dark ? 0.05 : 0.3) : roofC);
      }
      if (isMesh && C.high && bw >= 2 && (or(b.roofFloors, 0) >= 1 || b.roof === 'mansard')) for (let i = 0; i < r.bays; i++) dormer(r, (i + 0.5) * bw, RW);
      // ground floor
      const zLo = (s0: number, s1: number) => Math.min(r.zg(s0), r.zg(s1), base) - 0.3;
      if (r.arcade) arcade(C, W, r, base, gfTop, zLo, b, RW, glow);
      else if (r.kind === 'arcade') { // no room for a walkway (or a given mesh): arches drawn on the wall
        const na = Math.max(1, Math.round(r.len / 3.4)), aw = r.len / na, pw = clamp(aw * 0.22, 0.45, 0.9), ow = aw - pw, zt = gfTop - 0.42, rise = Math.min(ow / 2, Math.max(0.35, zt - base - 2.25));
        for (let i = 0; i < na; i++) {
          const sl = i * aw + pw / 2, zg = r.zg(i * aw + aw / 2), pts = [Q(sl, off0 + 0.03, zg), Q(sl + ow, off0 + 0.03, zg)];
          for (let k = 0; k <= 8; k++) { const a = (k / 8) * Math.PI; pts.push(Q(sl + ow / 2 + Math.cos(a) * ow / 2, off0 + 0.03, zt - rise + Math.sin(a) * rise)); }
          W.fan(pts, mix(pal.wallShade, BLACK, C.dark ? 0.35 : 0.42), { n: nrm });
        }
      } else if (r.kind === 'shop') {
        const fascia = mix(pal.awnings[Math.floor(RW() * pal.awnings.length) % pal.awnings.length], r.col, 0.35), awn0 = pal.awnings[Math.floor(RW() * pal.awnings.length) % pal.awnings.length];
        // awnings from the data: true, or { color }: every shop window gets one, in that colour softened to the palette
        const aw = r.spec.awnings, awc = aw && typeof aw === 'object' ? hex(aw.color) : null, awn = awc ? (C.dark ? mix(awn0, tone(awc, 0.5), 0.5) : mix(awc, hex('#EFE9DC')!, 0.25)) : awn0;
        const doorEvery = 3, phase = Math.floor(RW() * doorEvery), frame = mix(r.col, BLACK, C.dark ? 0.3 : 0.45), hasAwn = aw ? true : aw === false ? false : RW() < 0.7;
        rect(0.12, r.len - 0.12, gfTop - 0.85, gfTop - 0.28, 0.05, fascia);
        for (let i = 0; i < r.bays; i++) {
          const s0 = i * bw, zg = r.zg(s0 + bw / 2), top = gfTop - 1.0, m = Math.min(0.3, bw * 0.12), lit = C.dark && RW() < 0.75;
          const g = lit ? glow() : null, gl = (a: number, c2: number, z0: number, z1: number) => (lit ? rect(a, c2, z0, z1, 0.05, [g!, g!, tone(g!, 0.85), tone(g!, 0.85)], { mode: 1 }) : rect(a, c2, z0, z1, 0.05, [glassB, glassB, glassT, glassT]));
          if (top - zg < 1.6) continue;
          if (i % doorEvery === phase && bw > 2.2) { // a door beside a narrower window
            rect(s0 + m, s0 + bw - m, zg - 0.1, top, 0.03, frame);
            rect(s0 + m + 0.06, s0 + m + 1.0, zg + 0.02, Math.min(top - 0.06, zg + 2.3), 0.045, pal.door);
            gl(s0 + m + 0.16, s0 + m + 0.9, zg + 0.9, Math.min(top - 0.16, zg + 2.2));
            rect(s0 + m + 1.1, s0 + bw - m - 0.06, zg - 0.1, zg + 0.5, 0.045, tone(r.col, 0.86));
            gl(s0 + m + 1.1, s0 + bw - m - 0.06, zg + 0.5, top - 0.06);
          } else {
            rect(s0 + m, s0 + bw - m, zg - 0.1, top, 0.03, frame);
            rect(s0 + m + 0.06, s0 + bw - m - 0.06, zg - 0.1, zg + 0.5, 0.045, tone(r.col, 0.86));
            gl(s0 + m + 0.06, s0 + bw - m - 0.06, zg + 0.5, top - 0.06);
          }
          if (lit && C.high) pool(C, Q(s0 + bw / 2, 1.1, 0)[0], Q(s0 + bw / 2, 1.1, 0)[1], 2.6, 0.2, zg);
          if (hasAwn && (aw || RW() < 0.75)) { // an awning: a sloping sheet with a hanging edge
            const z1 = top + 0.12, z2 = z1 - 0.45, o1 = 1.15, a0 = s0 + m - 0.05, a1 = s0 + bw - m + 0.05, dk = tone(awn, 0.82);
            W.quad(Q(a0, off0 + 0.05, z1), Q(a1, off0 + 0.05, z1), Q(a1, off0 + o1, z2), Q(a0, off0 + o1, z2), [awn, awn, mix(awn, WHITE, C.dark ? 0 : 0.12), mix(awn, WHITE, C.dark ? 0 : 0.12)], { n: [0, 0, 1], two: true });
            W.quad(Q(a0, off0 + o1, z2), Q(a1, off0 + o1, z2), Q(a1, off0 + o1, z2 - 0.17), Q(a0, off0 + o1, z2 - 0.17), dk, { n: nrm, two: true });
            for (const s of [a0, a1]) W.tri(Q(s, off0 + 0.05, z1), Q(s, off0 + o1, z2), Q(s, off0 + 0.05, z2), dk, { two: true });
          }
        }
      } else {
        // plain: a low plinth, windows, and a door on the longer fronts
        const door = r.len >= 5 ? Math.floor(RW() * r.bays) % r.bays : -1;
        rect(0, r.len, zLo(0, r.len), base + 0.5, 0.03, tone(r.col, C.dark ? 0.86 : 0.9));
        if (bw >= 1.3) for (let i = 0; i < r.bays; i++) {
          const sc = (i + 0.5) * bw, zg = r.zg(sc);
          if (i === door) {
            rect(sc - 0.68, sc + 0.68, zg, zg + 2.5, 0.03, rtrim);
            rect(sc - 0.55, sc + 0.55, zg, zg + 2.3, 0.045, pal.door);
            if (C.high) { rect(sc - 0.4, sc + 0.4, zg + 1.35, zg + 2.1, 0.052, C.dark && RW() < 0.6 ? glow() : glassT, { mode: C.dark ? 1 : 0 }); ledge(sc - 0.8, sc + 0.8, zg - 0.3, zg + 0.02, 0.35, pal.stone, mix(pal.stone, WHITE, C.dark ? 0.08 : 0.3)); }
          } else if (r.gf > 2.6) {
            const wh = clamp(r.gf * 0.5, 1.0, 1.9), z0 = Math.max(zg + 0.85, base + 0.75);
            if (z0 + wh < gfTop - 0.3) win(sc, z0, clamp(bw * 0.42, 0.7, 1.35), wh, 0.35);
          }
        }
      }
    }
    C.windowBudget = budget;

    // ----- its shadow on the ground: a soft band along the walls, wider on the side away from the sun -----
    if (ring) for (const e of runs.E!) {
      const r = runs.find((q) => q.edges.includes(e));
      if (r && r.party) continue;
      const P = (s: number, o: number): XY => [e.a[0] + e.t[0] * s + e.n[0] * o, e.a[1] + e.t[1] * s + e.n[1] * o];
      const steps2 = Math.max(1, Math.ceil(e.len / 4)), inner: XY[] = [], o1: XY[] = [], o2: XY[] = [], inBox = C.casts((e.a[0] + e.b[0]) / 2, (e.a[1] + e.b[1]) / 2), away = !C.dark && !inBox && e.n[0] * C.sun[0] + e.n[1] * C.sun[1] < -0.2;
      for (let k = 0; k <= steps2; k++) { const s = (k / steps2) * e.len; inner.push(P(s, 0.02)); o1.push(P(s, 1.5)); o2.push(P(s, 4.2)); }
      shadeStrip(C, inner, o1, inBox ? 0.7 : 1.05, base);
      if (away) shadeStrip(C, inner, o2, 0.6, base);
    }
  }
  // A real arcade: pillars and arches in the front, a walkway behind them with shop windows at its back
  function arcade(C: Ctx, W: Writer, r: Run, base: number, gfTop: number, zLo: (s0: number, s1: number) => number, b: StationDetailBuilding, RW: Rng, glow: () => RGB) {
    const pal = C.pal, Q = r.Q, nrm: V3 = [r.n[0], r.n[1], 0], t3: V3 = [r.t[0], r.t[1], 0], D = r.D, pd = r.pd, col = r.col;
    const arches = !/pillar|post|column|pfeiler/i.test(b.arcade || '');
    const want = r.len / r.bays >= 2.4 && r.len / r.bays <= 5.2 ? r.bays : Math.max(1, Math.round(r.len / 3.5));
    const na = want, aw = r.len / na, pw = clamp(aw * 0.22, 0.45, 0.9), ow = aw - pw, zt = gfTop - 0.42;
    const rise = arches ? Math.min(ow / 2, Math.max(0.35, zt - base - 2.25)) : 0, spring = zt - rise, N = arches ? (C.high ? 8 : 4) : 1;
    const inside = tone(col, C.dark ? 0.62 : 0.66), deep = mix(pal.wallShade, BLACK, C.dark ? 0.3 : 0.3), soff = tone(col, C.dark ? 0.72 : 0.8);
    const front = (out: number, hint: V3, c: RGB | RGB[]) => { // the wall with its openings, at this depth
      for (let i = 0; i < na; i++) {
        const s0 = i * aw, sl = s0 + pw / 2, sr = s0 + aw - pw / 2, zb = zLo(s0, s0 + aw);
        const cb = (Array.isArray(c[0]) ? c : [tone(c as RGB, 0.93), tone(c as RGB, 0.93), c, c]) as RGB[];
        W.quad(Q(s0, out, zb), Q(sl, out, zb), Q(sl, out, gfTop), Q(s0, out, gfTop), cb, { n: hint });
        W.quad(Q(sr, out, zb), Q(s0 + aw, out, zb), Q(s0 + aw, out, gfTop), Q(sr, out, gfTop), cb, { n: hint });
        for (let k = 0; k < N; k++) {
          const a0 = (k / N) * Math.PI, a1 = ((k + 1) / N) * Math.PI;
          const x0 = sl + ow * (1 - Math.cos(a0)) / 2, x1 = sl + ow * (1 - Math.cos(a1)) / 2, z0 = spring + rise * Math.sin(a0), z1 = spring + rise * Math.sin(a1);
          W.quad(Q(x0, out, arches ? z0 : zt), Q(x1, out, arches ? z1 : zt), Q(x1, out, gfTop), Q(x0, out, gfTop), cb[2], { n: hint });
        }
      }
    };
    front(0, nrm, col);
    front(-pd, [-nrm[0], -nrm[1], 0], [tone(inside, 0.9), tone(inside, 0.9), inside, inside]);
    for (let i = 0; i < na; i++) {
      const s0 = i * aw, sl = s0 + pw / 2, sr = s0 + aw - pw / 2, zb = zLo(s0, s0 + aw);
      // the sides of the pillars and the underside of the arch
      W.quad(Q(sl, 0, zb), Q(sl, -pd, zb), Q(sl, -pd, spring), Q(sl, 0, spring), [tone(soff, 0.9), tone(soff, 0.8), tone(soff, 0.9), soff], { n: t3 });
      W.quad(Q(sr, 0, zb), Q(sr, -pd, zb), Q(sr, -pd, spring), Q(sr, 0, spring), [tone(soff, 0.9), tone(soff, 0.8), tone(soff, 0.9), soff], { n: [-t3[0], -t3[1], 0] });
      for (let k = 0; k < N; k++) {
        const a0 = (k / N) * Math.PI, a1 = ((k + 1) / N) * Math.PI, am = (a0 + a1) / 2;
        const x0 = sl + ow * (1 - Math.cos(a0)) / 2, x1 = sl + ow * (1 - Math.cos(a1)) / 2, z0 = arches ? spring + rise * Math.sin(a0) : zt, z1 = arches ? spring + rise * Math.sin(a1) : zt;
        const hint: V3 = arches ? [t3[0] * Math.cos(am), t3[1] * Math.cos(am), -Math.sin(am) - 0.01] : [0, 0, -1];
        W.quad(Q(x0, 0, z0), Q(x1, 0, z1), Q(x1, -pd, z1), Q(x0, -pd, z0), [soff, soff, tone(soff, 0.82), tone(soff, 0.82)], { n: hint });
      }
      // the walkway: floor, back wall with a shop window, ceiling
      const z0 = r.zg(s0), z1 = r.zg(s0 + aw), fl = mix(pal.paving, BLACK, C.dark ? 0.2 : 0.16), fl2 = mix(pal.paving, BLACK, C.dark ? 0.32 : 0.3);
      const A = Q(s0, 0.02, z0 + 0.004), B = Q(s0 + aw, 0.02, z1 + 0.004), B2 = Q(s0 + aw, -D, z1 + 0.004), A2 = Q(s0, -D, z0 + 0.004);
      W.quad(A, B, B2, A2, [fl, fl, fl2, fl2], { n: [0, 0, 1] });
      C.ground.add(A, B, B2, 8); C.ground.add(A, B2, A2, 8);
      W.quad(Q(s0, -D, zb), Q(s0 + aw, -D, zb), Q(s0 + aw, -D, gfTop), Q(s0, -D, gfTop), [deep, deep, tone(deep, 0.8), tone(deep, 0.8)], { n: nrm });
      W.quad(Q(s0, -pd, gfTop - 0.3), Q(s0 + aw, -pd, gfTop - 0.3), Q(s0 + aw, -D, gfTop - 0.3), Q(s0, -D, gfTop - 0.3), [tone(deep, 0.92), tone(deep, 0.92), tone(deep, 0.75), tone(deep, 0.75)], { n: [0, 0, -1] });
      const zg = Math.max(z0, z1), lit = C.dark && RW() < 0.7, m = Math.min(0.45, aw * 0.14), top = Math.min(gfTop - 0.75, zg + 2.7);
      if (top - zg > 1.5) {
        W.quad(Q(s0 + m, -D + 0.03, zg), Q(s0 + aw - m, -D + 0.03, zg), Q(s0 + aw - m, -D + 0.03, top), Q(s0 + m, -D + 0.03, top), mix(deep, BLACK, 0.25), { n: nrm });
        const g = lit ? glow() : null, gd = mix(pal.glass, deep, C.dark ? 0.3 : 0.45);
        W.quad(Q(s0 + m + 0.07, -D + 0.045, zg + 0.45), Q(s0 + aw - m - 0.07, -D + 0.045, zg + 0.45), Q(s0 + aw - m - 0.07, -D + 0.045, top - 0.07), Q(s0 + m + 0.07, -D + 0.045, top - 0.07), lit ? [g!, g!, tone(g!, 0.8), tone(g!, 0.8)] : [mix(gd, WHITE, 0.08), mix(gd, WHITE, 0.08), gd, gd], { n: nrm, mode: lit ? 1 : 0 });
        if (lit) { const c = Q(s0 + aw / 2, -D * 0.5, 0); pool(C, c[0], c[1], Math.max(2.2, D * 0.9), 0.3, zg); }
      }
    }
    // where the walkway does not pass through a side wall, it ends in one
    for (const end of [0, 1]) {
      if (end ? r.openB : r.openA) continue;
      const s = end ? r.len : 0, zb = zLo(s, s);
      W.quad(Q(s, -pd, zb), Q(s, -D, zb), Q(s, -D, gfTop), Q(s, -pd, gfTop), deep, { n: end ? [-t3[0], -t3[1], 0] : t3 });
    }
  }

  // The centre line of every track on a tram-track surface (where rails() lays its pairs of rails)
  function trackCentres(s: Surf): XY[][] {
    const t = trackLine(s);
    if (!t || !t.line || t.line.length < 2) return [];
    const line = densify(t.line, 3), width = t.width || 2.6, tracks = clamp(Math.round(or(s.src.tracks, width / 3.3)), 1, 4), pitch = width / tracks, fr = lineFrames(line, false), out: XY[][] = [];
    for (let k = 0; k < tracks; k++) { const c = (k - (tracks - 1) / 2) * pitch; out.push(fr.map((f) => offPt(f, c))); }
    return out;
  }

  // The contact wire over the tracks, 5.4 m up, on the stretches that have a mast for it nearby. No masts in the
  // data: no wire (none are invented).
  function contactWires(C: Ctx, surfaces: Surf[]) {
    const masts = (C.detail.props || []).filter((p) => p && p.xy && isFinite(p.xy[0]) && isFinite(p.xy[1]) && (p.kind === 'mast' || ((ALIAS[p.kind] || p.kind) === 'pole' && /tram|fahrleit|catenary|span/i.test(p.variant || '')))).map((p) => p.xy);
    if (!masts.length) return;
    const W = C.W.solid.world(), col = tone(C.pal.metal, C.dark ? 0.85 : 0.6);
    for (const s of surfaces) {
      if (s.kind !== 'tram') continue;
      for (const line of trackCentres(s)) {
        let run: P4[] = [];
        const flush = () => { if (run.length > 1) W.tube(run, 3, col); run = []; };
        for (const q of line) {
          if (masts.some((m) => Math.hypot(m[0] - q[0], m[1] - q[1]) < 28)) run.push([q[0], q[1], groundZ(C, q[0], q[1], s.zMean) + 5.42, 0.014]);
          else flush();
        }
        flush();
      }
    }
  }

  // ---------- vehicles: a tram that drives along a path ----------
  // Not part of the merged scene: one group of three meshes (the body with what is inside it, the panes of its
  // windows, and what lies see-through on the ground).
  // The model is written once in the frame of each section (x to the right, y the way it drives, z up from the
  // rails); place() moves every vertex with its section, so the tram bends through curves in three draw calls.
  type VSlide = [from: number, to: number, dx: number, dy: number];
  interface VModel { body: Batch; glass: Batch; veil: Batch; secB: number[]; secG: number[]; secV: number[]; slides: VSlide[]; slidesG: VSlide[]; secs: [number, number][]; length: number }
  interface VPart { local: Float32Array; sec: Uint8Array; slide: Float32Array | null; mesh: THREE.Mesh; pos: THREE.BufferAttribute }
  interface VRun { from: number; to: number; ms: number; ease: string; t0: number | null; done: () => void }
  interface Veh extends Station3DDetailVehicle {
    _run: VRun | null; _door: number; _doorTo: number; _last: number | null; _shown: boolean;
    _parts: VPart[]; _group: THREE.Group | null; _res: Res[];
    _make(): void; _free(): void; _end(): void; _tick(now: number): boolean;
  }
  const SEG7: Record<string, string> = { 0: 'ABCDEF', 1: 'BC', 2: 'ABGED', 3: 'ABGCD', 4: 'FGBC', 5: 'AFGCD', 6: 'AFGECD', 7: 'ABC', 8: 'ABCDEFG', 9: 'ABCDFG' };
  function tramModel(dark: boolean, pal: Pal, spec: Station3DDetailVehicleSpec, high: boolean): VModel {
    const total = clamp(or(spec.length, 42), 12, 90), N = Math.max(3, Math.round(total / 6)), GAP = 0.5;
    const L = (total - GAP * (N - 1)) / N, hl = L / 2, HW = 1.15, RW = HW - 0.22, NOSE = Math.min(1.9, L * 0.4);
    // inside: the lining stands IW from the middle, the floor lies at FZ, the ceiling at CZ; the windows reach from WZ0 to WZ1
    const IW = HW - 0.07, FZ = 0.38, CZ = 2.52, WZ0 = 1.22, WZ1 = 2.4;
    const K = (h: string): RGB => { const c = hex(h)!; return dark ? mix(tone(c, 0.58), [0.07, 0.08, 0.12], 0.16) : c; };
    const red = K('#D6001C'), doorRed = K('#C60019'), skirt = K('#C6C9CE'), stripe = K('#F2F3F4'), under = K('#2B2D31'), roof = K('#B4B8BD'), roofLine = K('#3D4046'), gear = K('#8B8F95'), gear2 = K('#6C7178'), bellows = K('#3B3E44'), fold = K('#232529'), pillar = K('#191C20'), arm = K('#55595F'), wheel = K('#1D1F22'), hub = K('#50545A');
    // what is seen through the glass: plain by day, lit warm from the ceiling by night
    const IC = (h: string): RGB => { const c = hex(h)!; return dark ? [Math.min(1, c[0] * 1.08 + 0.08), Math.min(1, c[1] + 0.04), c[2] * 0.84] : c; };
    const gm: Mode = dark ? 1 : 0;
    const liner = IC('#A3A8AE'), floorC = IC('#5F6369'), ceil = IC('#C9CCD0'), endC = IC('#6E737A'), seat = IC('#3E6A80'), seatTop = IC('#5E8DA6');
    const strip = hex(dark ? '#FFF1CF' : '#F4F3EC')!, grab = hex(dark ? '#F2C94C' : '#E3B62B')!, step = hex(dark ? '#FFE27A' : '#F4D23C')!;
    // the panes, bottom and top: tinted with the sky in them by day, clear over the lit inside by night
    const g0 = hex(dark ? '#E8B66E' : '#1B242E')!, g1 = hex(dark ? '#FFE2A8' : '#8AA6C0')!, ga0 = dark ? 0.1 : 0.5, ga1 = dark ? 0.24 : 0.74, sky = hex('#EAF3FB')!;
    const dest = hex('#0D0F12')!, amber = hex('#FFB52E')!, head = hex(dark ? '#FFF4D2' : '#F3F1E4')!, tail = hex(dark ? '#FF3B3B' : '#9E1420')!, green = hex(dark ? '#5BE08A' : '#2FB866')!;
    // the same top and side light as the scene, but the same from every side: the tram turns
    const shade: Shade = (col, n, _p, mode) => {
      if (mode === 1) return col;
      const m = dark ? 0.9 + 0.1 * n[2] : 0.9 + 0.13 * Math.max(0, n[2]) + (n[2] < 0 ? 0.22 * n[2] : 0) + 0.02 * n[0];
      return [col[0] * m, col[1] * m, col[2] * m];
    };
    const body = new (Batch as BatchNew)(), glassB = new (Batch as BatchNew)(true), veil = new (Batch as BatchNew)(true);
    const W = new (Writer as WriterNew)(body, shade).world(), WG = new (Writer as WriterNew)(glassB, (c) => c).world();
    const secB: number[] = [], secG: number[] = [], secV: number[] = [], slides: VSlide[] = [], slidesG: VSlide[] = [], secs: [number, number][] = [];
    const Q = (a: V3, b: V3, c: V3, d: V3, col: RGB | RGB[], n: V3, mode?: Mode) => W.quad(a, b, c, d, col, mode ? { n, mode } : { n });
    const disc = (c: V3, r: number, col: RGB, n: V3, half?: boolean) => { // in a plane across x
      const pts: V3[] = [], k = half ? 7 : 10;
      for (let i = 0; i < k; i++) { const a = half ? (i / (k - 1)) * Math.PI : (i / k) * TAU; pts.push([c[0], c[1] + Math.cos(a) * r, c[2] + Math.sin(a) * r]); }
      W.fan(pts, col, { n, mode: half ? 0 : 1 });
    };
    // a piece of pane in the plane x, its corners [y, z]: coloured and see-through by its height between z0 and z1
    const gq = (x: number, sg: number, P: number[][], z0: number, z1: number, c0: RGB, c1: RGB, al0: number, al1: number) => {
      const t = (z: number) => (z - z0) / (z1 - z0);
      WG.quad([x, P[0][0], P[0][1]], [x, P[1][0], P[1][1]], [x, P[2][0], P[2][1]], [x, P[3][0], P[3][1]], P.map((q) => mix(c0, c1, t(q[1]))), { n: [sg, 0, 0], a: P.map((q) => lerp(al0, al1, t(q[1]))) });
    };
    // one window: a dark frame around a pane with cut corners, the sky as a slanted streak in it
    const win = (x: number, sg: number, A: number, B: number, Z0: number, Z1: number, fr: number, two?: boolean) => {
      const n: V3 = [sg, 0, 0], a = A + fr, b = B - fr, z0 = Z0 + fr, z1 = Z1 - fr, c = Math.min(0.1, (b - a) / 4), w = b - a;
      const p = (y: number, z: number): V3 => [x, y, z];
      const O = [p(A, Z0), p(B, Z0), p(B, Z1), p(A, Z1)];
      const In = [p(a + c, z0), p(b - c, z0), p(b, z0 + c), p(b, z1 - c), p(b - c, z1), p(a + c, z1), p(a, z1 - c), p(a, z0 + c)];
      for (let k = 0; k < 4; k++) {
        W.quad(O[k], O[(k + 1) % 4], In[2 * k + 1], In[2 * k], pillar, { n, two });
        W.tri(O[(k + 1) % 4], In[(2 * k + 2) % 8], In[2 * k + 1], pillar, { n, two });
      }
      gq(x, sg, [[a + c, z0], [b - c, z0], [b - c, z1], [a + c, z1]], z0, z1, g0, g1, ga0, ga1);
      gq(x, sg, [[a, z0 + c], [a + c, z0], [a + c, z1], [a, z1 - c]], z0, z1, g0, g1, ga0, ga1);
      gq(x, sg, [[b - c, z0], [b, z0 + c], [b, z1 - c], [b - c, z1]], z0, z1, g0, g1, ga0, ga1);
      if (high && !dark && w > 0.45) gq(x, sg, [[a + w * 0.22, z0], [a + w * 0.42, z0], [a + w * 0.8, z1], [a + w * 0.6, z1]], z0, z1, sky, sky, 0.02, 0.2);
    };
    // a stretch of side wall (sg 1: the right side): skirt, body with its stripe, windows between posts, the band
    // above and the roof edge; behind it the lining, seat backs and a pole
    const wall = (sg: number, y0: number, y1: number, opening?: boolean) => {
      const x = sg * HW, xi = sg * IW, n: V3 = [sg, 0, 0], ni: V3 = [-sg, 0, 0], zs = opening ? 0.36 : 0.5;
      Q([x, y0, 0.16], [x, y1, 0.16], [x, y1, zs], [x, y0, zs], skirt, n);
      Q([sg * (HW - 0.12), y0, 0.05], [sg * (HW - 0.12), y1, 0.05], [sg * (HW - 0.12), y1, 0.16], [sg * (HW - 0.12), y0, 0.16], under, n);
      if (!opening) {
        Q([x, y0, 0.5], [x, y1, 0.5], [x, y1, 1.07], [x, y0, 1.07], red, n);
        Q([x, y0, 1.07], [x, y1, 1.07], [x, y1, 1.14], [x, y0, 1.14], stripe, n);
        Q([x, y0, 1.14], [x, y1, 1.14], [x, y1, WZ0], [x, y0, WZ0], red, n);
        Q([xi, y0, FZ], [xi, y1, FZ], [xi, y1, WZ0], [xi, y0, WZ0], liner, ni, gm);
        Q([xi, y0, WZ1], [xi, y1, WZ1], [xi, y1, CZ], [xi, y0, CZ], liner, ni, gm);
        const k = Math.max(1, Math.round((y1 - y0) / 1.4)), w = (y1 - y0) / k, po = 0.07;
        for (let j = 0; j < k; j++) {
          const a = y0 + j * w, b = a + w;
          Q([x, a, WZ0], [x, a + po, WZ0], [x, a + po, WZ1], [x, a, WZ1], red, n);
          Q([x, b - po, WZ0], [x, b, WZ0], [x, b, WZ1], [x, b - po, WZ1], red, n);
          Q([xi, a, WZ0], [xi, a + po + 0.05, WZ0], [xi, a + po + 0.05, WZ1], [xi, a, WZ1], liner, ni, gm);
          Q([xi, b - po - 0.05, WZ0], [xi, b, WZ0], [xi, b, WZ1], [xi, b - po - 0.05, WZ1], liner, ni, gm);
          win(x, sg, a + po, b - po, WZ0, WZ1, 0.05);
          if (high && w > 0.9) {
            const xa = sg * (IW - 0.01), xb = sg * (IW - 0.46), px = sg * (IW - 0.52), py = a + w * 0.51;
            for (const f of [0.26, 0.76]) W.box(Math.min(xa, xb), a + w * f - 0.045, FZ, Math.max(xa, xb), a + w * f + 0.045, 1.4, seat, { top: seatTop, mode: gm });
            W.box(px - 0.018, py - 0.018, FZ, px + 0.018, py + 0.018, CZ, grab, { mode: gm });
          }
        }
      }
      Q([x, y0, WZ1], [x, y1, WZ1], [x, y1, 2.84], [x, y0, 2.84], red, n);
      Q([x, y0, 2.84], [x, y1, 2.84], [x, y1, 2.9], [x, y0, 2.9], roofLine, n);
      Q([x, y0, 2.9], [x, y1, 2.9], [sg * RW, y1, 3.15], [sg * RW, y0, 3.15], roofLine, [sg, 0, 1]);
    };
    // lit strokes of the line number: P(a, b) is the point a to the reader's right and b up from the middle
    const digits = (P: (a: number, b: number) => V3, nn: V3, hh: number) => {
      const txt = String(spec.line == null ? '' : spec.line).split('').filter((ch) => SEG7[ch]).slice(0, 3);
      const w = hh * 0.53, th = hh * 0.13, sp = hh * 0.23, tw = txt.length * w + (txt.length - 1) * sp;
      const R: Record<string, number[]> = { A: [0, hh - th, w, hh], B: [w - th, hh / 2, w, hh], C: [w - th, 0, w, hh / 2], D: [0, 0, w, th], E: [0, 0, th, hh / 2], F: [0, hh / 2, th, hh], G: [0, hh / 2 - th / 2, w, hh / 2 + th / 2] };
      txt.forEach((ch, i) => {
        const a0 = -tw / 2 + i * (w + sp), b0 = -hh / 2;
        for (const s of SEG7[ch]) { const r = R[s]; Q(P(a0 + r[0], b0 + r[1]), P(a0 + r[2], b0 + r[1]), P(a0 + r[2], b0 + r[3]), P(a0 + r[0], b0 + r[3]), amber, nn, 1); }
      });
    };
    // a doorway with two leaves that slide apart: a lit step, the pole in the middle, the button beside it
    const door = (y0: number, y1: number) => {
      const x = HW, n: V3 = [1, 0, 0], ym = (y0 + y1) / 2;
      wall(1, y0, y1, true);
      Q([x, y0, 0.36], [x, y1, 0.36], [x, y1, 0.415], [x, y0, 0.415], step, n, 1);
      Q([x - 0.14, y0, FZ + 0.005], [x, y0, FZ + 0.005], [x, y1, FZ + 0.005], [x - 0.14, y1, FZ + 0.005], step, [0, 0, 1], 1);
      W.box(x - 0.42, ym - 0.02, FZ, x - 0.38, ym + 0.02, CZ, grab, { mode: gm });
      for (const lf of [[y0, ym, -1], [ym, y1, 1]]) {
        const n0 = body.n, m0 = glassB.n, xl = x - 0.03, a = lf[0] + 0.02, b = lf[1] - 0.02;
        W.quad([xl, a, 0.42], [xl, b, 0.42], [xl, b, 0.62], [xl, a, 0.62], doorRed, { n, two: true }); // a leaf is seen from inside too
        win(xl, 1, a, b, 0.62, 2.32, 0.05, true);
        W.quad([xl, a, 2.32], [xl, b, 2.32], [xl, b, 2.38], [xl, a, 2.38], doorRed, { n, two: true });
        slides.push([n0, body.n, 0.075, lf[2] * (b - a + 0.01)]);
        slidesG.push([m0, glassB.n, 0.075, lf[2] * (b - a + 0.01)]);
      }
      disc([x + 0.012, y1 + 0.13, 0.9], 0.062, green, n);
      disc([x + 0.02, y1 + 0.13, 0.9], 0.036, pillar, n);
    };
    // where two sections meet: the end wall and half of the bellows, in folds
    const joint = (sg: number) => {
      const y = sg * hl, np = high ? 3 : 1, d = (GAP / 2 + 0.04) / np;
      W.fan([[-HW, y, 0.16], [HW, y, 0.16], [HW, y, 2.9], [RW, y, 3.15], [-RW, y, 3.15], [-HW, y, 2.9]], pillar, { n: [0, sg, 0] });
      Q([-IW, y - sg * 0.01, FZ], [IW, y - sg * 0.01, FZ], [IW, y - sg * 0.01, CZ], [-IW, y - sg * 0.01, CZ], endC, [0, -sg, 0], gm);
      for (let k = 0; k < np; k++) {
        const ya = y + sg * d * k, yb = y + sg * d * (k + 1), inn = k % 2 ? 0.21 : 0.11;
        W.box(-(HW - inn), Math.min(ya, yb), 0.3, HW - inn, Math.max(ya, yb), k % 2 ? 2.97 : 3.05, k % 2 ? fold : bellows);
      }
    };
    // the cab end: the body narrows and the windscreen leans back. dir 1: the front, -1: the rear
    const nose = (dir: number) => {
      const KN = 4, yB = hl - NOSE;
      // [height, how far the tip stands back, how far it is drawn in at the tip]
      const LV = [[0.16, 0.12, 0.03], [0.5, 0, 0], [1.2, 0.04, 0], [2.4, 0.6, 0.05], [2.9, 0.74, 0.1], [3.15, 0.95, 0.3]];
      const pt = (k: number, lv: number, sg: number): V3 => {
        const t = k / KN, l = LV[lv], w = HW * (1 - 0.32 * Math.pow(t, 2.2)) - lerp(lv === 5 ? 0.22 : 0, l[2], t);
        return [sg * w, dir * (yB + NOSE * t - l[1] * t * t), l[0]];
      };
      const c0 = hex(dark ? '#1B222B' : '#27323E')!, c1 = hex(dark ? '#2C3744' : '#7D97AE')!, cab: RGB[] = [c0, c0, c1, c1]; // the driver sits in the dark
      const side: (RGB | RGB[])[] = [skirt, red, cab, red, roofLine], face: (RGB | RGB[])[] = [skirt, red, cab, dir > 0 ? dest : red, roofLine];
      for (let lv = 0; lv < 5; lv++) {
        for (let k = 0; k < KN; k++) for (const sg of [-1, 1]) Q(pt(k, lv, sg), pt(k + 1, lv, sg), pt(k + 1, lv + 1, sg), pt(k, lv + 1, sg), side[lv], [sg, dir * 0.5, lv === 4 ? 1 : 0.1]);
        Q(pt(KN, lv, -1), pt(KN, lv, 1), pt(KN, lv + 1, 1), pt(KN, lv + 1, -1), face[lv], [0, dir, lv === 4 ? 1 : 0.2]);
      }
      for (let k = 0; k < KN; k++) Q(pt(k, 5, -1), pt(k, 5, 1), pt(k + 1, 5, 1), pt(k + 1, 5, -1), roof, [0, 0, 1]);
      Q(pt(0, 0, -1), pt(0, 0, 1), pt(KN, 0, 1), pt(KN, 0, -1), under, [0, 0, -1]);
      // the stripe runs on around the cab, and a bumper stands out below
      for (let k = 0; k < KN; k++) for (const sg of [-1, 1]) {
        const a = pt(k, 2, sg), b = pt(k + 1, 2, sg), o = 0.012;
        Q([a[0] + sg * o, a[1], 1.07], [b[0] + sg * o, b[1] + dir * o, 1.07], [b[0] + sg * o, b[1] + dir * o, 1.14], [a[0] + sg * o, a[1], 1.14], stripe, [sg, dir * 0.5, 0.1]);
      }
      const yt = hl - 0.04, bw = HW * 0.68 + 0.03;
      Q([-bw, dir * (yt + 0.05), 1.07], [bw, dir * (yt + 0.05), 1.07], [bw, dir * (yt + 0.05), 1.14], [-bw, dir * (yt + 0.05), 1.14], stripe, [0, dir, 0]);
      W.box(-bw, Math.min(dir * (hl - 0.1), dir * (hl + 0.06)), 0.4, bw, Math.max(dir * (hl - 0.1), dir * (hl + 0.06)), 0.56, under);
      // lamps: white ahead, red behind
      const yF = dir * (hl + 0.014);
      for (const sx of [-0.5, 0.5]) {
        const pts: V3[] = [];
        for (let i = 0; i < 10; i++) { const a = (i / 10) * TAU; pts.push([sx + Math.cos(a) * 0.11, yF, 0.86 + Math.sin(a) * 0.11]); }
        W.fan(pts, dir > 0 ? head : tail, { n: [0, dir, 0], mode: 1 });
      }
      if (dir < 0) return;
      // the wiper, at rest across the windscreen
      const wn = norm([0, 1.2, 0.56]), wp = (xx: number, z: number): V3 => [xx, yt - ((z - 1.2) * 0.56) / 1.2 + wn[1] * 0.014, z + wn[2] * 0.014];
      Q(wp(-0.08, 1.26), wp(-0.035, 1.26), wp(0.4, 2.02), wp(0.355, 2.02), dest, wn);
      Q(wp(-0.14, 1.22), wp(0.02, 1.22), wp(0.02, 1.27), wp(-0.14, 1.27), dest, wn);
      // the line number on the dark band above the windscreen
      const u = norm([0, -0.14, 0.5]), nn = norm([0, 0.5, 0.14]), c: V3 = [0, hl - 0.67 + nn[1] * 0.014, 2.65 + nn[2] * 0.014];
      digits((a, b) => [c[0] - a, c[1] + u[1] * b, c[2] + u[2] * b], nn, 0.32);
    };
    for (let i = 0; i < N; i++) {
      const front = i === 0, rear = i === N - 1, y0 = rear ? -(hl - NOSE) : -hl, y1 = front ? hl - NOSE : hl, yc = (y0 + y1) / 2;
      wall(-1, y0, y1);
      if (!front && !rear && i % 2 === 1) {
        const dw = 0.66, dc = Math.min(1.4, hl - dw - 0.45);
        wall(1, y0, -dc - dw); door(-dc - dw, -dc + dw); wall(1, -dc + dw, dc - dw); door(dc - dw, dc + dw); wall(1, dc + dw, y1);
        if (i === 1 && y1 - dc - dw > 0.62) { // the line number again, beside the first door
          const ym = (dc + dw + y1) / 2 + 0.05;
          Q([HW + 0.01, ym - 0.27, 2.47], [HW + 0.01, ym + 0.27, 2.47], [HW + 0.01, ym + 0.27, 2.79], [HW + 0.01, ym - 0.27, 2.79], dest, [1, 0, 0], 1);
          digits((a, b) => [HW + 0.02, ym + a, 2.63 + b], [1, 0, 0], 0.22);
        }
      } else wall(1, y0, y1);
      // the room inside: floor, ceiling with its strip of light, the wall to the cab
      Q([-IW, y0, FZ], [HW - 0.04, y0, FZ], [HW - 0.04, y1, FZ], [-IW, y1, FZ], floorC, [0, 0, 1], gm);
      Q([-IW, y0, CZ], [-0.28, y0, CZ], [-0.28, y1, CZ], [-IW, y1, CZ], ceil, [0, 0, -1], gm);
      Q([0.28, y0, CZ], [HW - 0.04, y0, CZ], [HW - 0.04, y1, CZ], [0.28, y1, CZ], ceil, [0, 0, -1], gm);
      Q([-0.28, y0, CZ], [0.28, y0, CZ], [0.28, y1, CZ], [-0.28, y1, CZ], strip, [0, 0, -1], 1);
      if (front) Q([-IW, y1, FZ], [IW, y1, FZ], [IW, y1, CZ], [-IW, y1, CZ], endC, [0, -1, 0], gm);
      if (rear) Q([-IW, y0, FZ], [IW, y0, FZ], [IW, y0, CZ], [-IW, y0, CZ], endC, [0, 1, 0], gm);
      for (const sg of [-1, 1]) {
        // a small turn light near the front of every section; on the sections that stand on bogies, the wheels in their arches
        Q([sg * (HW + 0.012), y1 - 0.3, 0.92], [sg * (HW + 0.012), y1 - 0.14, 0.92], [sg * (HW + 0.012), y1 - 0.14, 0.99], [sg * (HW + 0.012), y1 - 0.3, 0.99], amber, [sg, 0, 0], 1);
        if (i % 2 === 0) for (const wy of [yc - 0.95, yc + 0.95]) {
          disc([sg * (HW + 0.012), wy, 0.16], 0.33, wheel, [sg, 0, 0], true);
          disc([sg * (HW + 0.02), wy, 0.16], 0.2, hub, [sg, 0, 0], true);
        }
      }
      Q([-RW, y0, 3.15], [RW, y0, 3.15], [RW, y1, 3.15], [-RW, y1, 3.15], roof, [0, 0, 1]);
      if (front) nose(1); else joint(1);
      if (rear) nose(-1); else joint(-1);
      // what stands on the roof: two units on the sections with bogies, a low cover on the others
      if (i % 2 === 0) {
        W.box(-0.7, yc - 1.45, 3.15, 0.7, yc - 0.15, 3.43, gear, { top: roof });
        W.box(-0.55, yc + 0.3, 3.15, 0.55, yc + 1.35, 3.33, gear2, { top: gear });
      } else W.box(-0.6, y0 + 0.9, 3.15, 0.6, y1 - 0.9, 3.3, gear, { top: roof });
      if (i === (N >> 1)) { // the pantograph: two arms and the bar that touches the wire
        const bar = (a: V3, b: V3) => { const d = norm(sub(b, a)); W.obox(mul3(add3(a, b), 0.5), mul3(sub(b, a), 0.5), [0.035, 0, 0], [0, -d[2] * 0.035, d[1] * 0.035], arm); };
        for (const sx of [-0.28, 0.28]) { bar([sx, -0.9, 3.4], [sx, 0.35, 4.38]); bar([sx * 0.6, 0.35, 4.38], [sx * 0.2, -0.45, 5.32]); }
        W.box(-0.6, -0.56, 5.3, 0.6, -0.34, 5.36, arm, { bottom: true });
      }
      while (secB.length < body.n) secB.push(i);
      while (secG.length < glassB.n) secG.push(i);
      // the shadow it stands on: dark under the body, gone 0.75 m beside it
      const sc = pal.shadow, sa = dark ? 0.36 : 0.3, ex = 0.75, xi = HW - 0.15, ya = -hl - (rear ? 0 : GAP / 2), yb = hl + (front ? 0 : GAP / 2), oa = rear ? ex : 0, ob = front ? ex : 0;
      const b0 = veil.n;
      for (const p of [[-xi, ya], [xi, ya], [xi, yb], [-xi, yb]]) veil.vert([p[0], p[1], 0.03], sc, sa);
      for (const p of [[-xi - ex, ya - oa], [xi + ex, ya - oa], [xi + ex, yb + ob], [-xi - ex, yb + ob]]) veil.vert([p[0], p[1], 0.03], sc, 0);
      veil.i.push(b0, b0 + 1, b0 + 2, b0, b0 + 2, b0 + 3);
      for (let k = 0; k < 4; k++) { const k1 = (k + 1) % 4; veil.i.push(b0 + k, b0 + 4 + k, b0 + 4 + k1, b0 + k, b0 + 4 + k1, b0 + k1); }
      if (dark && front) { // the light of the headlamps on the ground ahead
        const c0 = veil.vert([0, hl + 2.6, 0.04], pal.lamp, 0.3), n = 12;
        for (let k = 0; k < n; k++) { const a = (k / n) * TAU; veil.vert([Math.cos(a) * 1.9, hl + 3 + Math.sin(a) * 3.4, 0.04], pal.lamp, 0); }
        for (let k = 0; k < n; k++) veil.i.push(c0, c0 + 1 + k, c0 + 1 + ((k + 1) % n));
      }
      while (secV.length < veil.n) secV.push(i);
      secs.push([i * (L + GAP), i * (L + GAP) + L]);
    }
    return { body, glass: glassB, veil, secB, secG, secV, slides, slidesG, secs, length: total };
  }
  function vehiclePart(THREE: ThreeModule, b: Batch, sec: number[], slides: VSlide[] | null, flip: boolean, mat: THREE.Material): VPart {
    const n = b.n, g = new THREE.BufferGeometry(), k = b.alpha ? 4 : 3, col = new Float32Array(n * k);
    for (let i = 0; i < n; i++) { for (let j = 0; j < 3; j++) col[i * k + j] = toLin(sat(b.c[i * k + j])); if (b.alpha) col[i * k + 3] = b.c[i * k + 3]; }
    const pos = new THREE.BufferAttribute(new Float32Array(n * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos); g.setAttribute('color', new THREE.BufferAttribute(col, k));
    const idx = n > 65535 ? new Uint32Array(b.i) : new Uint16Array(b.i);
    if (flip) for (let i = 0; i + 2 < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    const mesh = new THREE.Mesh(g, mat);
    mesh.frustumCulled = false; mesh.matrixAutoUpdate = false; // it moves: no bounds to keep up to date
    let sl: Float32Array | null = null;
    if (slides && slides.length) { sl = new Float32Array(n * 2); for (const s of slides) for (let i = s[0]; i < s[1]; i++) { sl[i * 2] = s[2]; sl[i * 2 + 1] = s[3]; } }
    return { local: new Float32Array(b.p), sec: Uint8Array.from(sec), slide: sl, mesh, pos };
  }
  function addVehicle(h: Handle, spec: Station3DDetailVehicleSpec): Station3DDetailVehicle {
    const pts = cleanLine(spec && spec.path);
    if (!pts) throw new Error('addVehicle: the path needs at least two points');
    const THREE = h._THREE, cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    const along = (a: XY, b: XY, f: number): XY => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    const at = (s: number): XY => { // the point s metres along the path; straight on before its start and after its end
      const n = pts.length, T = cum[n - 1];
      if (s <= 0) return along(pts[0], pts[1], s / cum[1]);
      if (s >= T) return along(pts[n - 2], pts[n - 1], (s - cum[n - 2]) / (T - cum[n - 2]));
      let lo = 1, hi = n - 1;
      while (lo < hi) { const m = (lo + hi) >> 1; if (cum[m] < s) lo = m + 1; else hi = m; }
      return along(pts[lo - 1], pts[lo], (s - cum[lo - 1]) / (cum[lo] - cum[lo - 1]));
    };
    let secs: [number, number][] = [], M = new Float32Array(0), zLast: number | null = null;
    const gz = (p: XY) => { const z = groundAt(h, p[0], p[1]); if (z == null) return zLast == null ? h.zShift || 0 : zLast; zLast = z; return z; };
    // every section stands on two points of the path, its two ends: where it is, which way it looks, how it tilts
    const skin = () => {
      if (!v._group) return;
      const map = h._map, open = smooth(0, 1, v._door), out = sat(open * 4);
      for (let i = 0; i < secs.length; i++) {
        const A = at(v.at - secs[i][0]), B = at(v.at - secs[i][1]);
        let fx = A[0] - B[0], fy = A[1] - B[1];
        const len = Math.hypot(fx, fy) || 1, zA = gz(A), zB = gz(B), cx = (A[0] + B[0]) / 2, cy = (A[1] + B[1]) / 2, cz = (zA + zB) / 2, tilt = (zA - zB) / len;
        fx /= len; fy /= len;
        const O = map(cx, cy, cz), X = map(cx + fy, cy - fx, cz), Y = map(cx + fx, cy + fy, cz + tilt), Z = map(cx, cy, cz + 1), m = i * 12;
        for (let j = 0; j < 3; j++) { M[m + j] = O[j]; M[m + 3 + j] = X[j] - O[j]; M[m + 6 + j] = Y[j] - O[j]; M[m + 9 + j] = Z[j] - O[j]; }
      }
      for (const p of v._parts) {
        const arr = p.pos.array as Float32Array, L = p.local, S = open > 0 ? p.slide : null, n = p.sec.length;
        for (let j = 0; j < n; j++) {
          const m = p.sec[j] * 12, z = L[j * 3 + 2];
          let x = L[j * 3], y = L[j * 3 + 1];
          if (S) { x += S[j * 2] * out; y += S[j * 2 + 1] * open; }
          arr[j * 3] = M[m] + M[m + 3] * x + M[m + 6] * y + M[m + 9] * z;
          arr[j * 3 + 1] = M[m + 1] + M[m + 4] * x + M[m + 7] * y + M[m + 10] * z;
          arr[j * 3 + 2] = M[m + 2] + M[m + 5] * x + M[m + 8] * y + M[m + 11] * z;
        }
        p.pos.needsUpdate = true;
      }
    };
    const v: Veh = {
      length: 0, at: 0, stats: { triangles: 0, drawCalls: 0 },
      _run: null, _door: 0, _doorTo: 0, _last: null, _shown: true, _parts: [], _group: null, _res: [],
      place(s) { v._end(); v.at = +s || 0; skin(); },
      run(o) {
        v._end();
        v.at = +o.from || 0; skin();
        return new Promise<void>((done) => { v._run = { from: +o.from || 0, to: +o.to || 0, ms: Math.max(0, or(o.seconds, 0)) * 1000, ease: o.ease || 'linear', t0: null, done }; });
      },
      doors(open) { v._doorTo = open ? 1 : 0; v._last = null; },
      show(visible) { v._shown = !!visible; if (v._group) v._group.visible = v._shown; },
      remove() { v._end(); v._free(); const i = h._vehicles.indexOf(v); if (i >= 0) h._vehicles.splice(i, 1); },
      _end() { const r = v._run; v._run = null; if (r) r.done(); },
      _free() {
        for (const r of v._res) { try { r.dispose(); } catch (e) { /* already gone */ } }
        v._res = []; v._parts = [];
        if (v._group && v._group.parent) v._group.parent.remove(v._group);
        v._group = null;
      },
      // drawn in the look the scene has now (again after every update())
      _make() {
        v._free();
        const dark = h.theme === 'dark', md = tramModel(dark, paletteOf(h.theme, h.opts.palette), spec, h.quality !== 'low');
        const g = v._group = new THREE.Group(), Basic = THREE.MeshBasicMaterial;
        g.name = 'detail-vehicle'; g.visible = v._shown;
        const bodyMat = new Basic({ vertexColors: true }), veilMat = new Basic({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -7, polygonOffsetUnits: -14 });
        const glassMat = new Basic({ vertexColors: true, transparent: true, depthWrite: false });
        const bp = vehiclePart(THREE, md.body, md.secB, md.slides, h._flip, bodyMat), vp = vehiclePart(THREE, md.veil, md.secV, null, h._flip, veilMat), gp = vehiclePart(THREE, md.glass, md.secG, md.slidesG, h._flip, glassMat);
        bp.mesh.name = 'detail-vehicle-body'; vp.mesh.name = 'detail-vehicle-ground'; vp.mesh.renderOrder = 2.5; gp.mesh.name = 'detail-vehicle-glass'; gp.mesh.renderOrder = 3;
        g.add(vp.mesh, bp.mesh, gp.mesh);
        v._parts = [bp, vp, gp]; v._res = [bp.mesh.geometry, vp.mesh.geometry, gp.mesh.geometry, bodyMat, veilMat, glassMat];
        secs = md.secs; M = new Float32Array(secs.length * 12);
        v.length = md.length;
        v.stats = { triangles: Math.round((md.body.i.length + md.glass.i.length + md.veil.i.length) / 3), drawCalls: 3 };
        h.group.add(g);
        skin();
      },
      _tick(now) {
        let moved = false;
        const r = v._run;
        if (r) {
          if (r.t0 == null) r.t0 = now;
          const u = r.ms > 0 ? sat((now - r.t0) / r.ms) : 1;
          // braking and pulling away: the speed falls to nothing (or rises from it) without a jolt
          const e = r.ease === 'arrive' ? 1 - Math.pow(1 - u, 2.4) : r.ease === 'depart' ? Math.pow(u, 2.4) : u;
          v.at = r.from + (r.to - r.from) * e;
          moved = true;
          if (u >= 1) { v.at = r.to; v._run = null; r.done(); }
        }
        if (v._door !== v._doorTo) {
          const step = (v._last == null ? 0 : clamp(now - v._last, 0, 100)) / 800;
          v._door = v._doorTo > v._door ? Math.min(v._doorTo, v._door + step) : Math.max(v._doorTo, v._door - step);
          moved = true;
        }
        v._last = now;
        if (moved) skin();
        return moved;
      },
    };
    h._vehicles.push(v);
    v._make();
    return v;
  }

  // ---------- putting it together ----------
  const GLOW_VERT = [
    'attribute vec2 corner; attribute float gsize; attribute vec4 gcol;',
    'varying vec2 vC; varying vec4 vCol;',
    '#include <fog_pars_vertex>',
    '#include <clipping_planes_pars_vertex>',
    'void main() {',
    '  vC = corner; vCol = gcol;',
    '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
    '  mvPosition.xy += corner * gsize;', // always faces the eye
    '  gl_Position = projectionMatrix * mvPosition;',
    '  #include <clipping_planes_vertex>',
    '  #include <fog_vertex>',
    '}'].join('\n');
  const GLOW_FRAG = [
    'varying vec2 vC; varying vec4 vCol;',
    '#include <fog_pars_fragment>',
    '#include <clipping_planes_pars_fragment>',
    'void main() {',
    '  #include <clipping_planes_fragment>',
    '  float d = length(vC);',
    '  float a = pow(max(0.0, 1.0 - d), 2.4) * vCol.a;',
    '  #ifdef USE_FOG',
    '    #ifdef FOG_EXP2',
    '      a *= exp(-fogDensity * fogDensity * vFogDepth * vFogDepth);',
    '    #else',
    '      a *= 1.0 - smoothstep(fogNear, fogFar, vFogDepth);',
    '    #endif',
    '  #endif',
    '  gl_FragColor = vec4(vCol.rgb, a);',
    '  #include <colorspace_fragment>',
    '}'].join('\n');

  // A batch becomes a geometry: positions go through toScene, colours become linear
  function finish(THREE: ThreeModule, b: Batch, toScene: ToScene, flip: boolean, plain?: boolean) {
    const n = b.n, pos = new Float32Array(n * 3), g = new THREE.BufferGeometry();
    for (let i = 0; i < n; i++) { const s = toScene(b.p[i * 3], b.p[i * 3 + 1], b.p[i * 3 + 2]); pos[i * 3] = s[0]; pos[i * 3 + 1] = s[1]; pos[i * 3 + 2] = s[2]; }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    if (!plain) {
      const k = b.alpha ? 4 : 3, col = new Float32Array(n * k);
      for (let i = 0; i < n; i++) { for (let j = 0; j < 3; j++) col[i * k + j] = toLin(sat(b.c[i * k + j])); if (b.alpha) col[i * k + 3] = b.c[i * k + 3]; }
      g.setAttribute('color', new THREE.BufferAttribute(col, k));
    }
    if (b.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(b.uv), 2));
    const idx = n > 65535 ? new Uint32Array(b.i) : new Uint16Array(b.i);
    if (flip) for (let i = 0; i + 2 < idx.length; i += 3) { const t = idx[i + 1]; idx[i + 1] = idx[i + 2]; idx[i + 2] = t; }
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeBoundingSphere();
    return g;
  }
  function sky(THREE: ThreeModule, o?: Station3DDetailSkyOptions) {
    o = o || {};
    const pal = paletteOf(o.theme, o.palette), r = o.radius || 480, g = new THREE.SphereGeometry(r, 24, 14);
    const p = g.attributes.position, col = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const c = mix(pal.horizon, pal.sky, smooth(-0.02, 0.42, p.getY(i) / r));
      col[i * 3] = toLin(c[0]); col[i * 3 + 1] = toLin(c[1]); col[i * 3 + 2] = toLin(c[2]);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
    m.name = 'detail-sky'; m.renderOrder = -1000; m.frustumCulled = false;
    return m;
  }
  function clear(h: Handle) {
    for (const r of h._res || []) { try { r.dispose(); } catch (e) { /* already gone */ } }
    h._res = [];
    for (const v of h._vehicles || []) v._free(); // update() draws them again
    while (h.group.children.length) h.group.remove(h.group.children[0]);
    h.parts = {} as Station3DDetailParts;
  }
  function fill(THREE: ThreeModule, h: Handle) {
    const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now()), t0 = now();
    const detail = h.detail || {}, opts = h.opts, dark = opts.theme === 'dark', high = opts.quality !== 'low';
    const pal = paletteOf(dark ? 'dark' : 'light', opts.palette);
    const az = or(opts.sun && opts.sun.azimuth, 227.7) * RAD, el = clamp(or(opts.sun && opts.sun.elevation, 63.6), 5, 90) * RAD;
    const sun: V3 = [Math.sin(az) * Math.cos(el), Math.cos(az) * Math.cos(el), Math.sin(el)];
    const lamps: LampLight[] = [], shade = makeShade(dark, sun, lamps, pal.lamp), warnings: string[] = [];
    const B = { solid: new (Batch as BatchNew)(), bld: new (Batch as BatchNew)(), crown: new (Batch as BatchNew)(), glass: new (Batch as BatchNew)(true), decal: new (Batch as BatchNew)() };
    const nTrees = (detail.trees || []).length;
    const C = {
      THREE, detail, opts, pal, dark, high, far: false, castBox: null, sun, ground: new (Ground as GroundNew)(), z0: 0, plane: null,
      season: opts.season === 'summer' || opts.season === 'winter' ? opts.season : null,
      counts: { surfaces: 0, edges: 0, trees: 0, props: 0, buildings: 0 }, warn: (m) => { if (warnings.length < 40) warnings.push(m); },
      walk: [], base: new (Ground as GroundNew)(), gtris: [], cast: !dark && opts.shadows !== false, fit: { a: 0, b: 0, c: 0 }, groundBatches: new Map(), shadow: new (Batch as BatchNew)(true), pool: new (Batch as BatchNew)(true), feather: new (Batch as BatchNew)(true), glows: [],
      W: { solid: new (Writer as WriterNew)(B.solid, shade), bld: new (Writer as WriterNew)(B.bld, shade), crown: new (Writer as WriterNew)(B.crown, shade), glass: new (Writer as WriterNew)(B.glass, shade), decal: new (Writer as WriterNew)(B.decal, shade) },
      path: cleanLine(detail.path || []), clearance: or(opts.clearance, 2.7),
      lobeF: high ? (nTrees > 44 ? 2 : 3) : (nTrees > 90 ? 1 : 2), windowBudget: high ? 1100 : -1,
      rings: (detail.buildings || []).map((b) => { const r = b && cleanRing(b.ring) as BoxedRing | null; if (r) r.box = boxOf(r); return r; }),
    } satisfies CtxDraft as unknown as Ctx;
    if (C.cast && C.path) {
      const bx = boxOf(C.path), m = 45;
      C.castBox = [bx[0] - m, bx[1] - m, bx[2] + m, bx[3] + m];
    }
    C.casts = (x, y) => C.cast && (!C.castBox || (x >= C.castBox[0] + 4 && x <= C.castBox[2] - 4 && y >= C.castBox[1] + 4 && y <= C.castBox[3] - 4));
    const each = <T>(list: T[] | undefined, name: string, fn: (item: T, i: number) => void) => (list || []).forEach((item, i) => {
      if (!item) return;
      try { fn(item, i); } catch (e) { C.warn(name + ' ' + i + ': ' + (e && (e as Error).message)); }
    });
    const timing: Record<string, number> = {}, lap = (name: string, t: number) => { timing[name] = Math.round(now() - t); };
    let tl = now();
    const surfaces = readSurfaces(C);
    buildSurfaces(C, surfaces);
    basePlate(C, surfaces);
    lap('ground', tl); tl = now();
    // the lamps first: at night everything built after this is lit by them
    h.lamps = [];
    each(detail.props, 'prop', (p) => {
      if (!p.xy || !isFinite(p.xy[0]) || !isFinite(p.xy[1])) return;
      const kind = ALIAS[p.kind] || p.kind, z = num(p.z) != null ? p.z! : groundZ(C, p.xy[0], p.xy[1]);
      const ls = lightsOf(Object.assign({}, p, { kind }));
      if (kind === 'lamp') h.lamps.push({ xy: [p.xy[0], p.xy[1]], z, height: ls.length ? ls[0].at[2] : or(p.height, 4.5) });
      if (dark) for (const l of ls) { const P = new (Writer as WriterNew)(null!, null!).frame(p.xy[0], p.xy[1], z, or(p.heading, 0)).P(l.at); lamps.push({ x: P[0], y: P[1], z: P[2], r2: l.reach * l.reach, k: l.power }); }
    });
    each(detail.edges, 'edge', (e) => buildEdge(C, e));
    for (const t of C.walk) C.ground.add(t[0], t[1], t[2], 9); // kerb tops, once all edges have measured the ground beside them
    // Detail by distance from the walk: what stands along it is drawn in full, what is further away coarser
    // (limbs, shoots, crowns, window frames), and beyond 95 m in its simplest form. Without a path all is near.
    const tier = (x: number, y: number, near: number, far: number) => { const d = C.path ? lineDist(C.path, x, y) : 0; C.high = high && d < near; C.far = d >= far; };
    each(detail.buildings, 'building', (b, i) => { C.high = high; C.far = false; buildBuilding(C, b, i); });
    each(detail.trees, 'tree', (t) => { if (t.xy) tier(t.xy[0], t.xy[1], 45, high ? 95 : 60); buildTree(C, t); });
    each(detail.props, 'prop', (p) => { if (p.xy) tier(p.xy[0], p.xy[1], 60, 95); buildProp(C, p); });
    C.high = high; C.far = false;
    try { contactWires(C, surfaces); } catch (e) { C.warn('contact wire: ' + (e && (e as Error).message)); }
    each(detail.markings, 'marking', (m) => buildMarking(C, m));
    each(detail.surfaces, 'marking', (m) => { if (m.kind === 'marking') buildMarking(C, Object.assign({}, m, { kind: m.marking || m.variant || (m.line ? 'lane-line' : m.ring ? 'crossing' : 'bike-symbol') })); });
    lap('objects', tl); tl = now();
    const cast = C.cast ? castShadows(C, [B.solid, B.bld, B.crown]) : null;
    lap('shadows', tl); tl = now();

    // ----- meshes -----
    const map = typeof opts.toScene === 'function' ? opts.toScene : (x: number, y: number, z: number): V3 => [x, z, -y];
    // zShift: the whole scene moves up or down by this much (true: by the zOffset the data asks for)
    const shift = h.zShift = opts.zShift === true ? or(detail.zOffset, 0) : or(opts.zShift, 0);
    // flatten: the plane that fits the street is taken out of all heights (a shear: what stands upright stays
    // upright, kerbs keep their steps), so the ground lies level at height 0 (+ zShift) like the floor of the model
    const fit = h.plane = { a: C.fit.a, b: C.fit.b, c: C.fit.c, given: !!C.fit.given }, flat = h.flattened = !!opts.flatten;
    const toScene = flat ? (x: number, y: number, z: number) => map(x, y, z - (fit.c + fit.a * x + fit.b * y) + shift) : shift ? (x: number, y: number, z: number) => map(x, y, z + shift) : map;
    for (const l of h.lamps) l.z += shift - (flat ? fit.c + fit.a * l.xy[0] + fit.b * l.xy[1] : 0);
    const o = toScene(0, 0, 0), ex = sub(toScene(1, 0, 0), o), ey = sub(toScene(0, 1, 0), o), ez = sub(toScene(0, 0, 1), o);
    const flip = dot(ex, cross(ey, ez)) < 0; // a mirrored mapping turns every triangle over
    const res: Res[] = h._res = [], group = h.group, parts = h.parts = { ground: [] as Station3DDetailMesh[] } as Station3DDetailParts;
    const mesh = (name: string, batch: Batch, mat: THREE.MeshBasicMaterial, order: number, plain?: boolean) => {
      if (!batch.i.length) { mat.dispose(); return null; }
      const geo = finish(THREE, batch, toScene, flip, plain), m = new THREE.Mesh(geo, mat);
      m.name = 'detail-' + name; m.renderOrder = order; m.matrixAutoUpdate = false;
      group.add(m); res.push(geo, mat);
      return m;
    };
    const Basic = THREE.MeshBasicMaterial, texes: Partial<Record<GroundKind, THREE.CanvasTexture>> = {};
    let nTex = 0;
    [...C.groundBatches.values()].sort((p, q) => p.layer - q.layer).forEach((g) => {
      let tex = texes[g.kind];
      if (!tex) {
        const big = g.kind === 'paving' || g.kind === 'cobble';
        tex = texes[g.kind] = new THREE.CanvasTexture(paint(g.kind, pal, high ? (big ? 1024 : 512) : (big ? 512 : 256), dark));
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = big ? 4 : 1; // joints stay sharp at a flat angle; plain grain needs none (and can show ridges with it)
        res.push(tex); nTex++;
      }
      const m = mesh('ground-' + g.kind + '-' + g.layer, g, new Basic({ map: tex, vertexColors: true, polygonOffset: g.layer > 0, polygonOffsetFactor: -g.layer, polygonOffsetUnits: -2 * g.layer }), -20 + g.layer);
      if (m) parts.ground.push(m);
    });
    if (cast) { // the shadow picture, laid over each layer of the ground
      const tex = new THREE.CanvasTexture(cast.canvas), by = new Map<number, Batch>();
      tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
      res.push(tex); nTex++;
      for (const t of C.gtris) {
        if (Math.max(t[0][0], t[1][0], t[2][0]) < cast.x0 || Math.min(t[0][0], t[1][0], t[2][0]) > cast.x0 + cast.w || Math.max(t[0][1], t[1][1], t[2][1]) < cast.y0 || Math.min(t[0][1], t[1][1], t[2][1]) > cast.y0 + cast.h) continue;
        let b = by.get(t[3]);
        if (!b) { b = new (Batch as BatchNew)(); b.uv = []; by.set(t[3], b); }
        for (let j = 0 as 0 | 1 | 2; j < 3; j++) { b.i.push(b.vert([t[j][0], t[j][1], t[j][2] + 0.002], WHITE)); b.uv!.push((t[j][0] - cast.x0) / cast.w, (t[j][1] - cast.y0) / cast.h); }
      }
      parts.cast = [];
      [...by.keys()].sort((p, q) => p - q).forEach((layer) => {
        const l = Math.max(0, layer);
        const m = mesh('cast-' + layer, by.get(layer)!, new Basic({ map: tex, transparent: true, depthWrite: false, opacity: pal.castAlpha, polygonOffset: true, polygonOffsetFactor: -(l + 0.5), polygonOffsetUnits: -(2 * l + 1) }), 1.5, true);
        if (m) parts.cast!.push(m);
      });
    }
    parts.decals = mesh('decals', B.decal, new Basic({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -5, polygonOffsetUnits: -10 }), -10);
    parts.solid = mesh('solid', B.solid, new Basic({ vertexColors: true }), 0);
    parts.buildings = mesh('buildings', B.bld, new Basic({ vertexColors: true, side: C.meshBuildings ? THREE.DoubleSide : THREE.FrontSide }), 0);
    parts.crowns = mesh('crowns', B.crown, new Basic({ vertexColors: true }), 0);
    const veil = (extra?: THREE.MeshBasicMaterialParameters) => new Basic(Object.assign({ vertexColors: true, transparent: true, depthWrite: false }, extra));
    parts.feather = mesh('feather', C.feather, veil({ polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -8 }), 1);
    parts.shadows = mesh('shadows', C.shadow, veil({ polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12 }), 2);
    parts.pools = mesh('pools', C.pool, veil({ polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -12, blending: THREE.AdditiveBlending, fog: false }), 3);
    parts.glass = mesh('glass', B.glass, veil({ side: THREE.DoubleSide }), 4);
    if (C.glows.length) {
      const n = C.glows.length, pos = new Float32Array(n * 12), cor = new Float32Array(n * 8), siz = new Float32Array(n * 4), col = new Float32Array(n * 16), idx = new Uint16Array(n * 6);
      const lc = [toLin(pal.lamp[0]), toLin(pal.lamp[1]), toLin(pal.lamp[2])], Q = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      C.glows.forEach((gl, i) => {
        const s = toScene(gl.p[0], gl.p[1], gl.p[2]);
        for (let k = 0; k < 4; k++) {
          pos.set(s, i * 12 + k * 3); cor.set(Q[k], i * 8 + k * 2); siz[i * 4 + k] = gl.size;
          col.set([lc[0], lc[1], lc[2], gl.a], i * 16 + k * 4);
        }
        idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
      });
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('corner', new THREE.BufferAttribute(cor, 2));
      geo.setAttribute('gsize', new THREE.BufferAttribute(siz, 1)); geo.setAttribute('gcol', new THREE.BufferAttribute(col, 4));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
      const mat = new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog]), vertexShader: GLOW_VERT, fragmentShader: GLOW_FRAG,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true, clipping: true,
      });
      const m = new THREE.Mesh(geo, mat);
      m.name = 'detail-glows'; m.renderOrder = 5; m.frustumCulled = false; m.matrixAutoUpdate = false;
      group.add(m); res.push(geo, mat);
      parts.glows = m;
    }
    if (opts.sky) {
      const s = sky(THREE, { theme: opts.theme, palette: opts.palette }), c = C.path && C.path.length ? C.path[Math.floor(C.path.length / 2)] : [0, 0];
      s.position.fromArray(toScene(c[0], c[1], 0));
      group.add(s); res.push(s.geometry, s.material);
      parts.sky = s;
    }
    let tris = 0, verts = 0, calls = 0;
    const per: Record<string, number> = {};
    for (const m of group.children as THREE.Mesh[]) {
      const t = m.geometry.index ? m.geometry.index.count / 3 : m.geometry.attributes.position.count / 3;
      tris += t; verts += m.geometry.attributes.position.count; calls++;
      per[m.name.replace('detail-', '')] = Math.round(t);
    }
    h._ground = C.ground; h._base = C.base;
    h._map = map; h._flip = flip;
    h._tracks = ([] as XY[][]).concat(...surfaces.filter((s) => s.kind === 'tram').map(trackCentres));
    h.theme = dark ? 'dark' : 'light'; h.quality = high ? 'high' : 'low';
    h.stats = { triangles: Math.round(tris), drawCalls: calls, vertices: verts, textures: nTex, buildMs: Math.round(now() - t0), timing, counts: C.counts, parts: per, warnings };
  }
  function build(THREE: ThreeModule, detail: StationDetailModel | null | undefined, opts?: Station3DDetailOptions) {
    if (!THREE || !THREE.BufferGeometry) throw new Error('Station3DDetail.build: pass the THREE module object first');
    const h = { group: new THREE.Group(), detail: detail || {}, opts: Object.assign({}, opts), stats: null, parts: {}, lamps: [], _res: [], _THREE: THREE } satisfies HandleDraft as unknown as Handle;
    h.group.name = 'detail:' + ((detail && detail.key) || '');
    fill(THREE, h);
    h.groundAt = (x, y) => groundAt(h, x, y);
    h._vehicles = [];
    h.addVehicle = (spec) => addVehicle(h, spec);
    h.tick = (now) => { let moved = false; for (const v of h._vehicles) if (v._tick(now)) moved = true; return moved; };
    h.tracks = () => h._tracks.map((l) => l.map((p): XY => [p[0], p[1]]));
    h.dispose = () => { for (const v of h._vehicles) v._end(); clear(h); h._vehicles = []; if (h.group.parent) h.group.parent.remove(h.group); h._ground = h._base = null; };
    return h;
  }
  function update(h: Handle, change?: Station3DDetailOptions) {
    if (!h || !h._THREE) return h;
    const o = Object.assign({}, h.opts, change);
    const same = (['theme', 'quality', 'season', 'pollard', 'zShift', 'flatten', 'shadows', 'featherColor', 'featherInside', 'sun', 'palette', 'sky', 'feather', 'clearance'] as const).every((k) => JSON.stringify(o[k]) === JSON.stringify(h.opts[k]));
    if (same && h.group.children.length) return h;
    h.opts = o;
    clear(h);
    fill(h._THREE, h);
    for (const v of h._vehicles) v._make();
    return h;
  }
  function groundAt(h: Handle | null | undefined, x: number, y: number) {
    if (!h || !h._ground) return null;
    let z = h._ground.at(x, y);
    if (z == null && h._base) z = h._base.at(x, y);
    if (z == null) return null;
    if (h.flattened && h.plane) z -= h.plane.c + h.plane.a * x + h.plane.b * y;
    return z + (h.zShift || 0);
  }

  window.Station3DDetail = { build, update, groundAt, sky, palette: (theme) => JSON.parse(JSON.stringify(PALETTE[theme === 'dark' ? 'dark' : 'light'])), version: 1 };
})();
