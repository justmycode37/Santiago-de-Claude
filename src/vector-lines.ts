// The lines of one layer of a Mapbox vector tile (the swisstopo base map's `transportation`: rails, tram tracks and
// roads), decoded without the map: the live vehicles are laid onto the lines the map draws (src/live-snap.ts), from
// the tiles themselves, so what they are laid onto does not depend on which tiles the map happens to hold, or on its
// view (the satellite view draws none). Pure: Node tests and tools use it as the page does.
//
// The format: https://github.com/mapbox/vector-tile-spec (protocol buffers). Only what lines need is read.

/** A line of a tile: its class, whether it runs in a tunnel, whether it is one way (a road), its points [lon, lat]. */
export interface TileLine { cls: string; tunnel: boolean; oneway: boolean; pts: LngLat[] }

// ---- protocol buffers: varints, lengths, skipping ----
class Pbf {
  buf: Uint8Array; pos: number; end: number;
  constructor(buf: Uint8Array, start = 0, end = buf.length) { this.buf = buf; this.pos = start; this.end = end; }
  varint(): number {
    const b = this.buf;
    let r = 0, s = 1, x;
    do { x = b[this.pos++]; r += (x & 0x7f) * s; s *= 128; } while (x >= 0x80);
    return r;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) { const n = this.varint(); this.pos += n; }
    else if (wire === 5) this.pos += 4;
    else throw new Error('pbf: wire type ' + wire);
  }
  string(): string {
    const n = this.varint(), s = this.pos;
    this.pos += n;
    return utf8(this.buf, s, s + n);
  }
}
const decoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
function utf8(b: Uint8Array, s: number, e: number): string {
  if (decoder) return decoder.decode(b.subarray(s, e));
  let out = '';
  for (let i = s; i < e; i++) out += String.fromCharCode(b[i]);
  return out;
}
const zigzag = (n: number) => (n >>> 1) ^ -(n & 1);

/** A value of a layer: only strings and numbers matter here. */
function readValue(p: Pbf): string | number | boolean | null {
  const end = p.varint() + p.pos;
  let v: string | number | boolean | null = null;
  while (p.pos < end) {
    const tag = p.varint(), f = tag >> 3, w = tag & 7;
    if (f === 1) v = p.string();
    else if (f === 4 || f === 5) v = p.varint();
    else if (f === 6) v = zigzag(p.varint());
    else if (f === 7) v = !!p.varint();
    else if (f === 2) { v = new DataView(p.buf.buffer, p.buf.byteOffset + p.pos, 4).getFloat32(0, true); p.pos += 4; }
    else if (f === 3) { v = new DataView(p.buf.buffer, p.buf.byteOffset + p.pos, 8).getFloat64(0, true); p.pos += 8; }
    else p.skip(w);
  }
  p.pos = end;
  return v;
}

/**
 * The lines of layer `layer` in tile z/x/y (its bytes, as fetched: not gzipped) whose `class` is one of `classes`, cut
 * to the tile's own square (a tile repeats a little of its neighbours' lines around its edge: cut, two neighbouring
 * tiles' lines meet without overlapping; `cut` false: as the tile has them, as the map's querySourceFeatures gives them).
 */
export function tileLines(buf: Uint8Array, z: number, x: number, y: number, layer: string, classes: Set<string>, cut = true): TileLine[] {
  const p = new Pbf(buf);
  const out: TileLine[] = [];
  while (p.pos < p.end) {
    const tag = p.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) { p.skip(tag & 7); continue; }
    const end = p.varint() + p.pos;
    // a layer: its name first (in practice); its keys and values after its features, so features are remembered
    let name = '', extent = 4096;
    const keys: string[] = [], values: (string | number | boolean | null)[] = [], feats: [number, number, number, number][] = [];
    const lp = new Pbf(buf, p.pos, end);
    while (lp.pos < end) {
      const t = lp.varint(), f = t >> 3, w = t & 7;
      if (f === 1) { name = lp.string(); if (name !== layer) break; }
      else if (f === 2) { const n = lp.varint(); feats.push([lp.pos, lp.pos + n, 0, 0]); lp.pos += n; }
      else if (f === 3) keys.push(lp.string());
      else if (f === 4) values.push(readValue(lp));
      else if (f === 5) extent = lp.varint();
      else lp.skip(w);
    }
    p.pos = end;
    if (name !== layer) continue;
    const kClass = keys.indexOf('class'), kBrunnel = keys.indexOf('brunnel'), kOneway = keys.indexOf('oneway');
    const n = 2 ** z;
    const lon = (px: number) => ((x + px / extent) / n) * 360 - 180;
    const lat = (py: number) => { const t = Math.PI * (1 - (2 * (y + py / extent)) / n); return (Math.atan(Math.sinh(t)) * 180) / Math.PI; };
    for (const [s, e] of feats) {
      const fp = new Pbf(buf, s, e);
      let type = 0, cls = '', tunnel = false, oneway = false, gs = -1, ge = -1;
      while (fp.pos < e) {
        const t = fp.varint(), f = t >> 3, w = t & 7;
        if (f === 2 && w === 2) {
          const te = fp.varint() + fp.pos;
          while (fp.pos < te) {
            const k = fp.varint(), v = values[fp.varint()];
            if (k === kClass) cls = String(v);
            else if (k === kBrunnel) tunnel = v === 'tunnel';
            else if (k === kOneway) oneway = v === 1;
          }
        } else if (f === 3) type = fp.varint();
        else if (f === 4 && w === 2) { const n2 = fp.varint(); gs = fp.pos; ge = fp.pos + n2; fp.pos = ge; }
        else fp.skip(w);
      }
      if (type !== 2 || gs < 0 || !classes.has(cls)) continue;
      // the geometry: MoveTo / LineTo commands, zigzag deltas in tile units
      const gp = new Pbf(buf, gs, ge);
      let cx = 0, cy = 0, cmd = 0, cnt = 0;
      let line: [number, number][] = [];
      const flush = () => { if (line.length > 1) for (const part of cut ? clipToTile(line, extent) : [line]) out.push({ cls, tunnel, oneway, pts: part.map(([a, b]) => [lon(a), lat(b)] as LngLat) }); line = []; };
      while (gp.pos < ge) {
        if (!cnt) { const c = gp.varint(); cmd = c & 7; cnt = c >> 3; if (cmd === 7) { cnt = 0; continue; } }
        cnt--;
        cx += zigzag(gp.varint()); cy += zigzag(gp.varint());
        if (cmd === 1) flush();
        line.push([cx, cy]);
      }
      flush();
    }
  }
  return out;
}

/** A line in tile units cut to the square [0, extent]²: the parts of it inside. */
function clipToTile(line: [number, number][], extent: number): [number, number][][] {
  const parts: [number, number][][] = [];
  let cur: [number, number][] = [];
  for (let k = 1; k < line.length; k++) {
    const seg = clipSeg(line[k - 1], line[k], extent);
    if (!seg) { if (cur.length > 1) parts.push(cur); cur = []; continue; }
    const [a, b] = seg;
    const last = cur[cur.length - 1];
    if (!last || last[0] !== a[0] || last[1] !== a[1]) { if (cur.length > 1) parts.push(cur); cur = [a]; }
    cur.push(b);
  }
  if (cur.length > 1) parts.push(cur);
  return parts;
}
// Liang–Barsky
function clipSeg(a: [number, number], b: [number, number], e: number): [[number, number], [number, number]] | null {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  let t0 = 0, t1 = 1;
  for (const [p, q] of [[-dx, a[0]], [dx, e - a[0]], [-dy, a[1]], [dy, e - a[1]]]) {
    if (p === 0) { if (q < 0) return null; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return null; if (r > t0) t0 = r; } else { if (r < t0) return null; if (r < t1) t1 = r; }
  }
  if (t1 - t0 <= 0) return null;
  return [[a[0] + dx * t0, a[1] + dy * t0], [a[0] + dx * t1, a[1] + dy * t1]];
}

/** The tile (x, y) at zoom z a point is in. */
export function tileOf(p: LngLat, z: number): [number, number] {
  const n = 2 ** z, s = Math.sin((p[1] * Math.PI) / 180);
  const x = Math.floor(((p[0] + 180) / 360) * n), y = Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n);
  return [Math.min(n - 1, Math.max(0, x)), Math.min(n - 1, Math.max(0, y))];
}
