// The one way the page loads a part it needs only now and then (the 3D view, Scan, the fare suggestions…):
//
//   const { StationView } = await load(import.meta.url, () => import('./station-view.ts'));
//
// It can be asked again after a failure. A browser remembers a module that failed to download until the page is
// reloaded: a second import() of it fails at once, without asking the server. So before import() runs, the part's
// files (its own and every file it imports: the build writes that list into the page, `bundle-files`) are
// downloaded with fetch(), which the browser does not remember that way. Only when all of them have come does
// import() run, and it takes them from the browser's cache. A part whose files did not all come (no connection,
// also in a background preload) is downloaded again at the next call. However many callers ask for a part at once,
// it is loaded once.
//
// A file that is not there (404) means the site has been updated since this page was loaded: the bundle's files
// are named by their content, and each deploy replaces them all. The part is then not loaded (code of two versions
// must not mix), and the error says so. If import() fails although the files had come (the connection dropped in
// between, or a file went missing since), the browser now keeps that failure: the files are checked once more, to
// tell an update from a stuck download, and either way only a reload helps.
//
// Which part a call is: esbuild writes the path of the bundled file into the import() of the function, relative to
// the file the call is in (import.meta.url). The build fails if a call is not in this shape (scripts/build.mts).
// Where nothing is bundled (Node runs the sources for the tests), import() just runs.

/** Why a part could not be loaded: no connection (try again), the site was updated, or the browser keeps a failure. */
export type LoadFailure = 'offline' | 'updated' | 'stuck';
export class LoadError extends Error {
  failure: LoadFailure;
  constructor(message: string, failure: LoadFailure) {
    super(message);
    this.failure = failure;
  }
}
/**
 * What to tell the traveller when only a reload helps (`action`: "to open the 3D view"); null when trying again
 * may (no connection, or not a failure to load).
 */
export function reloadNote(e: unknown, action: string): string | null {
  if (!(e instanceof LoadError) || e.failure === 'offline') return null;
  return e.failure === 'updated' ? `The app has been updated. Reload the page ${action}.` : `It could not be loaded. Reload the page ${action}.`;
}

// The bundle's files as the build wrote them into the page: each file (relative to the page) → the files it imports
const graph = new Map<string, string[]>();
// files loaded as modules: what the page loaded as it started, then the files of every part that has loaded
const loaded = new Set<string>();
if (typeof document !== 'undefined') {
  const at = (file: string) => new URL(file, document.baseURI).href;
  const data = document.getElementById('bundle-files');
  if (data) for (const [file, imports] of Object.entries(JSON.parse(data.textContent!) as Record<string, string[]>)) graph.set(at(file), imports.map(at));
  for (const el of document.querySelectorAll<HTMLLinkElement | HTMLScriptElement>('link[rel="modulepreload"], script[type="module"][src]')) {
    loaded.add(at(el.getAttribute('href') || el.getAttribute('src')!));
  }
}
/** A part's own file and every file it imports, by the build's graph. */
function filesOf(url: string): string[] {
  const out = new Set<string>();
  const add = (f: string) => { if (out.has(f)) return; out.add(f); for (const g of graph.get(f) || []) add(g); };
  add(url);
  return [...out];
}
/** Downloads the files (fresh: from the server); throws a LoadError if one did not come. */
async function check(files: string[], fresh: boolean): Promise<void> {
  const answers = await Promise.all(files.map((f) => fetch(f, fresh ? { cache: 'no-store' } : {}).then((r) => r.status, () => 0)));
  const bad = files.filter((_, i) => answers[i] < 200 || answers[i] > 299);
  if (!bad.length) return;
  const gone = bad.some((f) => answers[files.indexOf(f)] === 404 || answers[files.indexOf(f)] === 410);
  throw new LoadError('Could not load ' + bad.join(', '), gone ? 'updated' : 'offline');
}

const parts = new Map<string, Promise<unknown>>();
const stuck = new Set<string>();
export function load<T>(base: string, part: () => Promise<T>): Promise<T> {
  if (!/^https?:/.test(base)) return part();
  const spec = /^\(\)\s*=>\s*import\("([^"]+)"\)$/.exec(String(part).trim());
  const url = spec && new URL(spec[1], base).href;
  if (!url || !graph.has(url)) return Promise.reject(new LoadError('Not a part of the bundle: ' + String(part), 'stuck'));
  if (!parts.has(url)) {
    const p = (async () => {
      if (stuck.has(url)) throw new LoadError('A failed download of ' + url + ' is kept by the browser', 'stuck');
      const files = filesOf(url).filter((f) => !loaded.has(f));
      await check(files, false);
      try {
        const mod = await part();
        for (const f of files) loaded.add(f);
        return mod;
      } catch (e) {
        stuck.add(url);
        await check(files, true); // gone (updated) or there (the download broke off)
        throw new LoadError('Could not load ' + url, 'stuck');
      }
    })();
    parts.set(url, p);
    p.catch(() => parts.delete(url)); // the next call tries again (or says that only a reload helps)
  }
  return parts.get(url) as Promise<T>;
}
