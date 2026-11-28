// ---- A small pull towards what is near you, on top of the search's own order (search-places.ts combineResults()).
//      Each result keeps its place, plus up to NEAR_PULL places for how far it is from where you are (log scale, from
//      0 here to the full pull at FAR_KM and beyond); the list is then sorted by that, stably. The pull is between one
//      and two places, so a result passes the one just before it only when that one is far (over about 30 km) and it is
//      much nearer, and nothing moves more than one place: the sources' own ranking (the
//      engine's, which already prefers nearer stops among equals; places before addresses; …) stays what decides.
//      Only from your real position (GPS), never the middle of the map; a result named exactly what was typed keeps its
//      place; and a list of a kind of place ("pharmacy") is nearest first already, so it is left as it is.
//      No imports: the caller gives where you are (tools/test_search_rank.mts runs it in Node). ----

/** What it needs of a result (search.ts SearchResult). */
interface Ranked { title: string; lngLat?: LngLat | [number, number] | null }

/** At most this many places down for being far away: over one, so a much nearer neighbour can pass a far result;
 *  under two, so it never passes more than one. */
export const NEAR_PULL = 1.5;
/** From this far on, the whole pull, km. */
const FAR_KM = 200;
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/\s+/g, ' ').trim();

/** How far down a result `km` from you is pulled, in places (0 … NEAR_PULL). */
export function nearPull(km: number): number {
  if (!(km > 0)) return 0;
  return NEAR_PULL * Math.min(1, Math.log10(1 + km) / Math.log10(1 + FAR_KM));
}

// Great-circle km (as routing.ts distKm)
function km(a: readonly number[], b: readonly number[]) {
  const r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLng = (b[0] - a[0]) * r;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(x)));
}

/**
 * The list with the pull applied. `here`: where you are by GPS (null: as it is); `nearestFirst`: the list is ordered
 * by distance already (a kind of place), then it is returned as it is.
 */
export function nudgeNearYou<T extends Ranked>(text: string, list: T[], nearestFirst: boolean, here: LngLat | null): T[] {
  if (nearestFirst || !here || list.length < 2) return list;
  const typed = fold(text);
  const scored = list.map((r, i) => {
    const exact = !!typed && fold(r.title || '') === typed;
    const ll = r.lngLat;
    const d = ll && Number.isFinite(ll[0]) && Number.isFinite(ll[1]) ? km(here, ll) : NaN;
    return { r, i, s: i + (exact || Number.isNaN(d) ? 0 : nearPull(d)) };
  });
  scored.sort((a, b) => a.s - b.s || a.i - b.i);
  return scored.map((x) => x.r);
}
