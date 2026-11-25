// A swisstopo base map style with its vector tile sets written in: the style's sources name a TileJSON file
// (one more round trip before the first tile) that lists tiles on five numbered hosts (vectortiles0–4).
// Written in, every tile comes from the style's own host instead: one HTTP/2 connection for style, fonts, icons and
// tiles, not six. The normal and the satellite view then also ask for the base map's tiles at the same addresses,
// so the browser's cache and the map's own serve both (src/inline/early.ts, src/app/map-events.ts).

/** TileJSON: what of it is written into the style's source. */
type TileJson = Pick<maplibregl.VectorSourceSpecification, 'tiles' | 'minzoom' | 'maxzoom' | 'bounds' | 'scheme' | 'attribution'>;

const json = <T>(u: string): Promise<T> => fetch(u).then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.json() as Promise<T>; });

/** Fetches the style at `url` and writes its vector sources' TileJSON into it (a source whose TileJSON fails keeps its url). */
export function fetchStyleWithTiles(url: string): Promise<maplibregl.StyleSpecification> {
  return json<maplibregl.StyleSpecification>(url).then((style) =>
    Promise.all(Object.values(style.sources).map((src) => (src.type !== 'vector' || !src.url ? null
      : json<TileJson>(src.url).then((tj) => {
        if (!tj.tiles || !tj.tiles.length) return;
        src.tiles = [tj.tiles[0].replace(/^https:\/\/vectortiles\d+\./, 'https://vectortiles.')];
        for (const k of ['minzoom', 'maxzoom', 'bounds', 'scheme', 'attribution'] as const) if (tj[k] != null) (src as Record<typeof k, unknown>)[k] = tj[k];
        delete src.url;
      }).catch(() => {})))).then(() => style));
}
