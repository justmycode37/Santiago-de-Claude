// Start the two slow things before the map library and the event data (about 1.5 MB) have downloaded:
// finding the user's location and fetching the base map style. On a phone each takes a second or more.
(function () {
  // Location: fixes that come in early wait here until the main script attaches to them
  const geo = window.EARLY_GEO = {
    fixes: [], errors: [], on: null,
    attach(onFix, onError) {
      this.on = { onFix, onError };
      this.fixes.splice(0).forEach(onFix);
      this.errors.splice(0).forEach(onError);
    },
  } as Omit<EarlyGeo, 'start'> as EarlyGeo;
  geo.start = () => {
    if (geo.started || !window.isSecureContext || !navigator.geolocation) return;
    geo.started = true;
    const fix = (p: GeolocationPosition) => (geo.on ? geo.on.onFix(p) : geo.fixes.push(p));
    const fail = (e: GeolocationPositionError) => (geo.on ? geo.on.onError(e) : geo.errors.push(e));
    try {
      // A position the phone already has (up to 10 min old) comes back at once; the precise one follows
      navigator.geolocation.getCurrentPosition(fix, () => {}, { enableHighAccuracy: false, maximumAge: 600000, timeout: 4000 });
      navigator.geolocation.watchPosition(fix, fail, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
    } catch (e) {}
  };
  // On a first visit the introduction asks first; it calls EARLY_GEO.start() when it ends (onboarding.ts)
  if (!document.documentElement.dataset.onboarding) geo.start();

  // Base map style with its two tile sets written in (saves two round trips before the first tile), and every
  // tile fetched from the style's own host: one HTTP/2 connection for style, fonts, icons and tiles, not six
  const HOST = 'https://vectortiles.geo.admin.ch';
  /** TileJSON: what of it is written into the style's source. */
  type EarlyTileJson = Pick<maplibregl.VectorSourceSpecification, 'tiles' | 'minzoom' | 'maxzoom' | 'bounds' | 'scheme' | 'attribution'>;
  const json = <T>(u: string): Promise<T> => fetch(u).then((r) => { if (!r.ok) throw new Error(r.status as unknown as string); return r.json(); });
  window.EARLY_STYLE = json<maplibregl.StyleSpecification>(HOST + '/styles/ch.swisstopo.lightbasemap.vt/style.json').then((style) =>
    Promise.all(Object.values(style.sources).map((src) => (src.type !== 'vector' || !src.url ? null
      : json<EarlyTileJson>(src.url).then((tj) => {
        if (!tj.tiles || !tj.tiles.length) return;
        src.tiles = [tj.tiles[0].replace(/^https:\/\/vectortiles\d+\./, 'https://vectortiles.')];
        for (const k of ['minzoom', 'maxzoom', 'bounds', 'scheme', 'attribution'] as const) if (tj[k] != null) (src as Record<typeof k, unknown>)[k] = tj[k];
        delete src.url;
      }).catch(() => {})))).then(() => style));
  window.EARLY_STYLE.catch(() => {}); // handled where it is used
})();
