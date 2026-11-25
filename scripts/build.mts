// Builds the site into dist/: the folder GitHub Pages publishes and `npm run dev` serves.
//
//   node scripts/build.mts             everything, for local use
//   node scripts/build.mts --release   only what is published (no *-dev.html pages, no local config.js)
//
// What goes into dist/ (esbuild does the TypeScript and the bundling):
//   ENTRIES            → the pages' modules: each bundled with what it imports into dist/<its path under src/>-<hash>.js
//                        (src/main.ts → main-<hash>.js). What they load with import() is a file of its own in
//                        dist/chunks/, fetched only when it is first needed, as is code they share. Source maps.
//                        Every file is named by its content: see "Files and deploys" in docs/development.md.
//   SCRIPTS            → plain scripts outside the bundle, each its own file (src/translate.ts → translate-<hash>.js)
//   *.html             → copied, with every line "<!-- build: src/… -->" replaced by that script: a module of
//                        ENTRIES as <script type="module" src="…"> (with <link rel="modulepreload"> for the files it
//                        imports, so they download alongside it), anything else written into the page as a plain
//                        <script> (src/inline: theme, first visit, early location and map style; src/pages)
//   *.css *.js         → copied (the .js files in the repository root are generated data and config.js)
//   STATIC_DIRS, DEMO  → copied
//
// Types are not checked here (`npm run check` does that), so a type error never blocks a build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DIST = path.join(ROOT, 'dist');
export const SRC = path.join(ROOT, 'src');

/** The pages' modules. A page loads one with the marker "<!-- build: src/main.ts type="module" -->". */
export const ENTRIES = ['src/main.ts', 'src/pages/scan-bench.ts', 'src/pages/station3d-solid.page.ts'];
/** Plain scripts beside the bundle, loaded with their own <script src>: translate.js runs before maplibre has downloaded. */
export const SCRIPTS = ['src/translate.ts'];
/** The service worker (src/app/map-cache.ts registers it): dist/sw.js, under a name that stays the same. */
const SERVICE_WORKER = 'src/sw/sw.ts';
/**
 * MapLibre, the version installed (package.json), from the CDN. The modules import 'maplibre-gl'; the bundle names
 * its full address instead, so the page needs no import map for it (Safari has import maps only from 16.4).
 */
export const MAPLIBRE_VERSION = (JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/maplibre-gl/package.json'), 'utf8')) as { version: string }).version;
const MAPLIBRE_URL = `https://unpkg.com/maplibre-gl@${MAPLIBRE_VERSION}/dist/maplibre-gl.mjs`;
/** Loaded by the pages from the CDN, through their import map (three.js) or by their address (maplibre): left as imports. */
const EXTERNAL = ['three', 'three/addons/*', MAPLIBRE_URL];
const ALIAS = { 'maplibre-gl': MAPLIBRE_URL };
/**
 * A line in a page that a script from src/ replaces: "<!-- build: src/inline/early.ts -->". Attributes after the
 * path go onto the <script> tag: "<!-- build: src/main.ts type="module" -->".
 */
const MARKER = /^([ \t]*)<!-- build: (src\/[\w./-]+)((?: [a-z]+="[^"]*")*) -->[ \t]*$/gm;
/** Folders the page loads files from. */
export const STATIC_DIRS = ['event-images', 'stop-images', 'stations3d', 'demo-media'];
/** The demo page and the two files it plays, not the raw screen recordings next to them. */
const DEMO_PAGE = 'demo/index.html';
const DEMO = ['demo/opening.jpg', 'demo/santiago.mp4'];
/** In the repository root, but not published: the development pages, the config template and a local config. */
const notReleased = (file: string) => /-dev\.html$/.test(file) || file === 'config.example.js' || file === 'config.js';

const rel = (file: string) => path.relative(ROOT, file);
const web = (file: string) => file.split(path.sep).join('/');

/** What esbuild writes: today's syntax as it is (nothing lowered), and the text as written (no \u escapes). */
const OUTPUT = { target: 'esnext', charset: 'utf8', logLevel: 'silent' } as const;

/** esbuild's errors as one message: "src/x.ts:12:3: Expected ";" but found "}"". */
function failed(e: unknown): Error {
  const errors = (e as esbuild.BuildFailure).errors;
  if (!errors) return e instanceof Error ? e : new Error(String(e));
  return new Error(errors.map((m) => (m.location ? `${m.location.file}:${m.location.line}:${m.location.column}: ` : '') + m.text).join('\n'), { cause: e });
}
function buildSync<T extends esbuild.BuildOptions>(options: esbuild.SameShape<esbuild.BuildOptions, T>): esbuild.BuildResult<T> {
  try {
    return esbuild.buildSync(options);
  } catch (e) {
    throw failed(e);
  }
}

/** A file of dist/ the build makes: its path under dist/ and its content. */
interface Made { file: string; content: string | Uint8Array }
/**
 * Each entry of ENTRIES and each script of SCRIPTS: the file it became, the files it imports (modulepreload), and
 * for an entry every file it can load, each with the files it imports (what src/lazy.ts reads, `bundle-files`).
 */
type Built = Map<string, { file: string; imports: string[]; graph?: Record<string, string[]> }>;
/** What the last build of the scripts wrote: removed when the next one has written its own (npm run dev). */
let written = new Set<string>();

const served = (file: string) => web(path.relative(DIST, file));
const outputs = (files: esbuild.OutputFile[]): Made[] => files.map((f) => ({ file: served(f.path), content: f.contents }));

/**
 * The modules of ENTRIES, bundled: every file is named by its content (main-<hash>.js, chunks/<name>-<hash>.js),
 * so a page and the files it loads are always of one build. See "Files and deploys" in docs/development.md.
 */
function bundle(built: Built): Made[] {
  const result = buildSync({
    ...OUTPUT, absWorkingDir: ROOT, entryPoints: ENTRIES, bundle: true, splitting: true, format: 'esm',
    outdir: DIST, outbase: SRC, entryNames: '[dir]/[name]-[hash]', chunkNames: 'chunks/[name]-[hash]', sourcemap: true,
    external: EXTERNAL, alias: ALIAS, metafile: true, write: false,
  });
  const meta = result.metafile.outputs;
  const name = (f: string) => served(path.join(ROOT, f));
  const statics = (f: string) => meta[f].imports.filter((i) => i.kind === 'import-statement' && !i.external).map((i) => i.path);
  for (const [file, out] of Object.entries(meta)) {
    if (!out.entryPoint) continue;
    // every file it imports, and what those import in turn: all of them are needed before it can run
    const imports: string[] = [], seen = new Set<string>();
    const walk = (f: string) => { for (const i of statics(f)) if (!seen.has(i)) { seen.add(i); imports.push(name(i)); walk(i); } };
    walk(file);
    // every file it can load (with import() too), and the files each imports
    const graph: Record<string, string[]> = {};
    const reach = (f: string) => {
      if (graph[name(f)]) return;
      graph[name(f)] = statics(f).map(name);
      for (const i of meta[f].imports) if (!i.external && (i.kind === 'import-statement' || i.kind === 'dynamic-import')) reach(i.path);
    };
    reach(file);
    built.set(out.entryPoint, { file: name(file), imports, graph });
  }
  checkLoads(result.outputFiles, new Set(Object.keys(meta).map(name)));
  return outputs(result.outputFiles);
}

/**
 * Every import() of a file of the bundle goes through load() (src/lazy.ts), in the shape it reads:
 * `load(import.meta.url, () => import("./chunks/x-<hash>.js"))`. Anything else would load without it (and stay
 * broken after one failed download), so the build stops.
 */
function checkLoads(files: esbuild.OutputFile[], made: Set<string>): void {
  for (const f of files) {
    if (!f.path.endsWith('.js')) continue;
    for (const m of f.text.matchAll(/\bimport\(\s*(["'])([^"']+)\1\s*\)/g)) {
      const target = served(path.resolve(path.dirname(f.path), m[2]));
      const before = f.text.slice(Math.max(0, m.index! - 60), m.index);
      if (!made.has(target)) continue; // not a file of the bundle (the import map's three.js)
      if (!/\bload\d*\(import\.meta\.url, \(\) => $/.test(before) || f.text[m.index! + m[0].length] !== ')') {
        throw new Error(`${served(f.path)}: import("${m[2]}") is not loaded through load(import.meta.url, () => import(…)) (src/lazy.ts)`);
      }
    }
  }
}

/** A plain script (no import or export at run time), with what it imports written into it. */
function classicScript(source: string, outdir?: string) {
  return buildSync({
    ...OUTPUT, absWorkingDir: ROOT, entryPoints: [source], bundle: true, format: 'iife', external: EXTERNAL, alias: ALIAS, write: false,
    // as they have always run: not in strict mode (esbuild would add "use strict", tsconfig.json being strict)
    tsconfigRaw: { compilerOptions: { alwaysStrict: false } },
    ...(outdir ? { outdir, entryNames: '[name]-[hash]', sourcemap: true, metafile: true } : {}),
  });
}

/** The service worker as dist/sw.js: the browser knows it by its address, so the name has no hash. */
function serviceWorker(): Made {
  return { file: 'sw.js', content: classicScript(SERVICE_WORKER).outputFiles![0].contents };
}

/** The scripts of SCRIPTS: dist/<name>-<hash>.js */
function classicScripts(built: Built): Made[] {
  return SCRIPTS.flatMap((source) => {
    const result = classicScript(source, DIST);
    const [file] = Object.keys(result.metafile!.outputs).filter((f) => f.endsWith('.js'));
    built.set(source, { file: served(path.join(ROOT, file)), imports: [] });
    return outputs(result.outputFiles!);
  });
}

/**
 * The scripts a page from before the modules (index.html of #61 and earlier, cached or still open) loads: as it
 * starts, and on first use (Scan, the 3D view and what it loads, the fare suggestions). Each is published once more
 * as a file that reloads the page: the reload brings the new index.html (a browser asks for the page itself again
 * on a reload). Only for the first deploy of the modules; they can go with any later one.
 */
const RETIRED = ['translate', 'events', 'map-layers', 'pricing-history', 'settings', 'walk-pace', 'onboarding', 'engine',
  'engine-departures', 'engine-journey', 'live', 'arcore', 'places', 'walkroute',
  'stopvision', 'station-view', 'station-route', 'station3d-solid', 'indoorloc', 'signloc', 'indoornav', 'pricing-panel', 'pricing-engine'];
const reloadFor = (name: string) => `// ${name}.js is no longer part of the site: the page that asked for it is from before an update. Reload it, once.
try { if (!sessionStorage.getItem('reloaded-for ${name}.js')) { sessionStorage.setItem('reloaded-for ${name}.js', '1'); location.reload(); } } catch (e) {}
`;

/**
 * A module of ENTRIES as a page loads it: the file, the files it imports fetched alongside, and the files it can
 * load later with what each imports (for src/lazy.ts and src/inline/updated.ts), all relative to the page.
 */
function moduleTags(b: { file: string; imports: string[]; graph?: Record<string, string[]> }, indent: string, page: string, attributes: string): string {
  const up = '../'.repeat(page.split('/').length - 1); // pages in folders (demo/index.html)
  const graph = Object.fromEntries(Object.entries(b.graph || {}).map(([f, i]) => [up + f, i.map((x) => up + x)]));
  return [`${indent}<script type="application/json" id="bundle-files">${JSON.stringify(graph)}</script>`,
    ...b.imports.map((f) => `${indent}<link rel="modulepreload" href="${up}${f}" />`), `${indent}<script${attributes} src="${up}${b.file}"></script>`].join('\n');
}

/** A build marker's script written into the page. */
function inlineScript(source: string): string {
  const code = classicScript(source).outputFiles![0].text;
  const end = code.search(/<\/script/i);
  if (end >= 0) {
    const line = code.slice(0, end).split('\n').length;
    throw new Error(`${source}: "</script" (line ${line} of the script) would end the <script> in the page. Write it as '<\\/script'.`);
  }
  return code.endsWith('\n') ? code : code + '\n';
}

/** A page with the scripts its build markers name: a module or plain script by its file, anything else written in. */
function buildPage(page: string, built: Built): Made {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  // the stylesheet and the preload of MapLibre must be of the version the bundle imports
  for (const [, v] of html.matchAll(/maplibre-gl@([\w.-]+)\/dist\/maplibre-gl\.(?:css|mjs)/g)) {
    if (v !== MAPLIBRE_VERSION) throw new Error(`${page}: maplibre-gl@${v}, but ${MAPLIBRE_VERSION} is installed (package.json)`);
  }
  return { file: page, content: html.replace(MARKER, (_line, indent: string, source: string, attributes: string) => {
    const b = built.get(source);
    if (ENTRIES.includes(source)) return moduleTags(b!, indent, page, attributes);
    if (SCRIPTS.includes(source)) return `${indent}<script${attributes} src="${'../'.repeat(page.split('/').length - 1)}${b!.file}"></script>`;
    return `${indent}<script${attributes}>\n${inlineScript(source)}${indent}</script>`;
  }) };
}

/** The pages in the repository root (and the demo page). */
export function pages(release: boolean): string[] {
  return [...fs.readdirSync(ROOT).filter((f) => f.endsWith('.html') && !(release && notReleased(f))), DEMO_PAGE];
}

/** Copy a file unless dist/ already has it unchanged (same size, not older). */
function copy(from: string, to: string): void {
  const a = fs.statSync(from);
  const b = fs.statSync(to, { throwIfNoEntry: false });
  if (b && b.size === a.size && b.mtimeMs >= a.mtimeMs) return;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from: string, to: string): void {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name), b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else copy(a, b);
  }
}

/** The stylesheets and scripts in the repository root that are served as they are. */
export function rootFiles(release: boolean): string[] {
  return fs.readdirSync(ROOT).filter((f) => /\.(css|js)$/.test(f) && !(release && notReleased(f)));
}

export function copyStatic(release: boolean): void {
  for (const f of rootFiles(release)) copy(path.join(ROOT, f), path.join(DIST, f));
  for (const d of STATIC_DIRS) copyDir(path.join(ROOT, d), path.join(DIST, d));
  for (const f of DEMO) copy(path.join(ROOT, f), path.join(DIST, f));
}

/**
 * Everything made from src/: the bundle, the plain scripts and the pages that load them. All of it is made first and
 * only then written, so a build that fails (a syntax error while `npm run dev` runs) leaves the last one as it was.
 */
export function buildScripts(release = false): void {
  writeScripts(makeScripts(release));
}
function makeScripts(release: boolean): Made[] {
  const built: Built = new Map();
  const made = [...bundle(built), ...classicScripts(built), serviceWorker(), ...pages(release).map((p) => buildPage(p, built)),
    ...RETIRED.filter((n) => !fs.existsSync(path.join(ROOT, n + '.js'))).map((n) => ({ file: n + '.js', content: reloadFor(n) }))];
  return made;
}

/** Writes what makeScripts() made, and removes the files of the build before that are not among them. */
function writeScripts(made: Made[]): void {
  for (const { file, content } of made) {
    const out = path.join(DIST, file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, content);
  }
  const now = new Set(made.map((m) => m.file));
  for (const file of written) if (!now.has(file)) fs.rmSync(path.join(DIST, file), { force: true });
  written = now;
}

export function build({ release = false, clean = release }: { release?: boolean; clean?: boolean } = {}): void {
  const made = makeScripts(release); // first: a build that fails leaves dist/ as it was, also when it would clean
  if (clean) { fs.rmSync(DIST, { recursive: true, force: true }); written = new Set(); }
  fs.mkdirSync(DIST, { recursive: true });
  copyStatic(release);
  writeScripts(made);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const release = process.argv.includes('--release');
  const started = Date.now();
  try {
    build({ release, clean: true });
    console.log(`dist/ built in ${Date.now() - started} ms${release ? ' (release)' : ''}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
