// The one way the page loads a part it needs only now and then (the 3D view, Scan, the fare suggestions…):
//
//   const { StationView } = await load(import.meta.url, () => import('./station-view.ts'));
//
// It can be asked again after a failure. A browser remembers a module that failed to download until the page is
// reloaded: a second import() of it fails at once, without asking the server. So before import() runs, the part's
// files (its own and every file it imports) are downloaded with fetch(), which the browser does not remember that
// way. Only when all of them have come does import() run, and it takes them from the browser's cache. A part that
// failed (no connection) is downloaded again at the next call, also after a background preload that failed.
//
// A file that is not there (404) means the site has been updated since this page was loaded: the bundle's files
// are named by their content, and each deploy replaces them all. The part is then not loaded (code of two versions
// must not mix), and the error says so (LoadError.updated): the caller tells the traveller to reload.
//
// Which file the part is: esbuild writes the path of the bundled file into import(), relative to the file the call
// is in (import.meta.url). Where nothing is bundled (Node runs the sources for the tests), import() just runs.

export class LoadError extends Error {
  /** The file is gone: the site has been updated since this page was loaded, and a reload brings the new one. */
  updated: boolean;
  constructor(message: string, updated: boolean) {
    super(message);
    this.updated = updated;
  }
}
/** What the traveller is told when a part cannot be loaded because the site has been updated. */
export const UPDATED = 'The app has been updated. Reload the page to use this.';
export const isUpdate = (e: unknown) => e instanceof LoadError && e.updated;

// files known to be there: the ones the page itself loaded, then every one fetched once
const there = new Set<string>();
if (typeof document !== 'undefined') {
  for (const el of document.querySelectorAll<HTMLLinkElement | HTMLScriptElement>('link[rel="modulepreload"], script[type="module"][src]')) {
    there.add(new URL(el.getAttribute('href') || el.getAttribute('src')!, document.baseURI).href);
  }
}
// what a bundled file imports: esbuild writes `import { a } from "./chunk-X.js";`, `import "./x.js";`, `export … from`
const IMPORTS = /(?:^|[;\n])\s*(?:import|export)\s*(?:[\w$*{}\s,]*\sfrom\s*)?["'](\.{1,2}\/[^"']+)["']/g;
const checking = new Map<string, Promise<void>>();

function reachable(url: string): Promise<void> {
  if (there.has(url)) return Promise.resolve();
  if (!checking.has(url)) {
    checking.set(url, (async () => {
      let res: Response;
      try {
        res = await fetch(url);
      } catch (e) {
        throw new LoadError('Could not load ' + url, false);
      }
      if (!res.ok) throw new LoadError(`Could not load ${url} (${res.status})`, res.status === 404 || res.status === 410);
      const text = await res.text();
      await Promise.all([...text.matchAll(IMPORTS)].map((m) => reachable(new URL(m[1], url).href)));
      there.add(url);
    })().finally(() => checking.delete(url)));
  }
  return checking.get(url)!;
}

let retries = 0;
export async function load<T>(base: string, part: () => Promise<T>): Promise<T> {
  const spec = /\bimport\(\s*["']([^"']+)["']\s*\)/.exec(String(part));
  if (!spec || !/^https?:/.test(base)) return part();
  const url = new URL(spec[1], base).href;
  await reachable(url);
  try {
    return await part();
  } catch (e) {
    // its files were all there a moment ago: the connection dropped between the two (the browser now remembers
    // the failure for this address, so the part's own file is asked for under another one)
    await reachable(url);
    return import(url + (url.includes('?') ? '&' : '?') + 'retry=' + ++retries) as Promise<T>;
  }
}
