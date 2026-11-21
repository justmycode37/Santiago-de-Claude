// ---- For blind and low-vision travellers (Settings › Blind or low vision): tactile guidance and sound, in words.
//      Stops: ATLAS accessibility data per stop edge (stop-access.js, built by tools/build-stop-access.mjs; Bern
//      so far). Crossings with a sound signal: Stadt Bern (map-places.js). Only what is mapped is said: where
//      nothing is known, nothing is claimed either way. Both are loaded when the setting is on. ----
const lowVision = () => !!SETTINGS.prefs().lowVision;
let stopAccessData: Record<string, StopAccessEdge[]> | null = null;
let stopAccessLoading = false;
function loadAccessData() {
  if (!lowVision()) return;
  if (!PLACES) loadPlaces().then((ok) => { if (ok && journeyConn) queueSheet(); });
  if (stopAccessData || stopAccessLoading) return;
  stopAccessLoading = true;
  const el = document.createElement('script');
  el.src = 'stop-access.js';
  el.async = true;
  el.onload = () => { stopAccessData = (window.STOP_ACCESS && window.STOP_ACCESS.stops) || {}; if (journeyConn) queueSheet(); };
  el.onerror = () => { stopAccessLoading = false; el.remove(); };
  document.head.appendChild(el);
}
const ACCESS_WORDS: Record<string, string> = { t: 'Tactile guide lines', f: 'Tactile field at the boarding point', a: 'Spoken announcements', s: 'Departure display with speech' };
// What is known at the edge a ride leaves from → ['Tactile field at the boarding point', …]
function stopAccess(st: JourneyRideStep): string[] {
  const rows = lowVision() && stopAccessData ? stopAccessData[String(st.s.departure.station!.id)] : null;
  if (!rows) return [];
  // (without the edge itself there is only the station's middle, which may happen to lie on one of its bays)
  const q = quayOf(st, 'dep'), ll = q.edge ? q.edge.ll : null;
  // The edge itself: the row nearest to it, within 5 m (the same official points as ours, so it is at 0 m; bays
  // stand 6 m apart and less). Else the row with its label, when that is unambiguous.
  let row: StopAccessEdge | undefined;
  if (ll) {
    let best = 0.005;
    for (const r of rows) { const d = r[0] ? distKm([r[0] / 1e5, r[1] / 1e5], ll) : Infinity; if (d < best) { best = d; row = r; } }
  }
  if (!row && q.label) {
    const same = rows.filter((r) => r[2] === String(q.label).toUpperCase());
    if (same.length && same.every((r) => r[3] === same[0][3])) row = same[0];
  }
  return row ? [...row[3]].map((f) => ACCESS_WORDS[f]).filter(Boolean) : [];
}
// The way a walk really goes: its lines once they have been routed (a line not routed yet, one no router found
// a way for, or a short one drawn straight is no path, and says nothing about the crossings on the way)
function walkPaths(st: JourneyStep): LngLat[][] {
  const lines = st.lines || [], walks = st.walks || [];
  return lines.filter((l, k) => l.length > 1 && !!walks[k] && walks[k].dist != null && !walks[k].approx);
}
// Crossings with a sound signal along a walk: the signal posts within 12 m of one of its lines, posts of one
// crossing counted once. The lines are taken one by one: the end of one is not joined to the start of the next.
let soundPosts: LngLat[] | null = null;
function soundCrossings(paths: LngLat[][]): number {
  const coords = paths.flat();
  if (!lowVision() || !PLACES || coords.length < 2) return 0;
  if (!soundPosts) {
    const cat = PLACES.cats.findIndex((c) => c[3] === 'Acoustic crossing signal');
    soundPosts = PLACES.items.filter((r) => r[2] === cat).map((r): LngLat => [r[0], r[1]]);
  }
  const [w, s0, e, n] = coords.reduce((b, c) => [Math.min(b[0], c[0]), Math.min(b[1], c[1]), Math.max(b[2], c[0]), Math.max(b[3], c[1])], [180, 90, -180, -90]);
  const near = soundPosts.filter((p) => p[0] > w - 0.0003 && p[0] < e + 0.0003 && p[1] > s0 - 0.0002 && p[1] < n + 0.0002
    && paths.some((line) => line.some((c, k) => k < line.length - 1 && projectSeg(p, c, line[k + 1]).d < 12)));
  const groups: LngLat[] = [];
  near.forEach((p) => { if (!groups.some((g) => distKm(g, p) < 0.03)) groups.push(p); });
  return groups.length;
}
const soundWords = (n: number) => (n === 1 ? '1 crossing with a sound signal' : `${n} crossings with sound signals`);
