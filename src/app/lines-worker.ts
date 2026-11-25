// ---- The base map's lines for the live vehicles, off the page's own thread (src/app/live-vehicles.ts starts it; the
//      build makes it dist/lines-worker-<hash>.js): it fetches the base map's tiles, reads their rails and roads
//      (src/vector-lines.ts), and lays ways onto them (src/live-lines.ts: a bus's way onto the drawn roads, where a way on
//      rails runs in a tunnel). None of that holds up the map's frames. ----
import { tileLines } from '../vector-lines.ts';
import { DrawnLines, layRoad, railTunnels, RAIL_CLASSES, ROAD_CLASSES } from '../live-lines.ts';
import { KANTE_LIVE } from '../live.ts';

/** What the page asks: tiles to take in ("x/y" at zoom 14, from `url` with {x} {y}), to start again, a way to lay. */
export type LinesAsk =
  | { type: 'tiles'; url: string; tiles: string[]; gen: number }
  | { type: 'reset' }
  | { type: 'lay'; kind: 'road' | 'rail'; path: string; gen: number };
/** What it answers: tiles taken in (or that failed), a way laid (its points and km, [lon, lat] pairs flat; tunnel flags). */
export type LinesAnswer =
  | { type: 'tiles'; done: string[]; failed: string[]; gen: number }
  | { type: 'laid'; kind: 'road' | 'rail'; path: string; pts: Float64Array | null; cum: Float64Array; tunnel: Uint8Array | null; complete: boolean; gen: number };

const CLASSES = new Set([...ROAD_CLASSES, ...RAIL_CLASSES]);
let roads = new DrawnLines(), rails = new DrawnLines();
const scope = self as unknown as { postMessage(m: LinesAnswer, transfer?: Transferable[]): void; onmessage: ((e: MessageEvent<LinesAsk>) => void) | null };

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'reset') { roads = new DrawnLines(); rails = new DrawnLines(); return; }
  if (m.type === 'tiles') { void takeTiles(m.url, m.tiles, m.gen); return; }
  if (m.type === 'lay') {
    const raw = KANTE_LIVE.decodePolyline(m.path);
    if (raw.length < 2) { scope.postMessage({ type: 'laid', kind: m.kind, path: m.path, pts: null, cum: new Float64Array(0), tunnel: null, complete: true, gen: m.gen }); return; }
    if (m.kind === 'road') {
      const l = layRoad(raw, roads), pts = new Float64Array(l.pts.length * 2);
      l.pts.forEach((p, k) => { pts[2 * k] = p[0]; pts[2 * k + 1] = p[1]; });
      const cum = Float64Array.from(l.cum), tunnel = l.tunnel ? Uint8Array.from(l.tunnel) : null;
      scope.postMessage({ type: 'laid', kind: 'road', path: m.path, pts, cum, tunnel, complete: l.complete, gen: m.gen }, tunnel ? [pts.buffer, cum.buffer, tunnel.buffer] : [pts.buffer, cum.buffer]);
    } else {
      const t = railTunnels(raw, rails), cum = Float64Array.from(t.cum);
      scope.postMessage({ type: 'laid', kind: 'rail', path: m.path, pts: null, cum, tunnel: t.tunnel, complete: t.complete, gen: m.gen }, [cum.buffer, t.tunnel.buffer]);
    }
  }
};

// a few at a time; each answered as it is taken in
// (`gen`: the page's count of starting again; its answer tells which tiles it is about)
async function takeTiles(url: string, tiles: string[], gen: number) {
  const done: string[] = [], failed: string[] = [];
  let next = 0;
  const one = async (): Promise<void> => {
    const t = tiles[next++];
    if (!t) return;
    if (!roads.tiles.has(t)) {
      const [x, y] = t.split('/').map(Number), mine = roads;
      try {
        const r = await fetch(url.replace('{z}', '14').replace('{x}', String(x)).replace('{y}', String(y)));
        if (!r.ok) throw new Error(String(r.status));
        const all = tileLines(new Uint8Array(await r.arrayBuffer()), 14, x, y, 'transportation', CLASSES);
        if (mine !== roads) return one(); // started again meanwhile: not for these
        roads.add(t, all.filter((l) => ROAD_CLASSES.has(l.cls)));
        rails.add(t, all.filter((l) => RAIL_CLASSES.has(l.cls)));
        done.push(t);
      } catch { failed.push(t); }
    } else done.push(t);
    return one();
  };
  await Promise.all([one(), one(), one(), one()]);
  scope.postMessage({ type: 'tiles', done, failed, gen });
}
