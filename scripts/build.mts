// Builds the site into dist/: the folder GitHub Pages publishes and `npm run dev` serves.
//
//   node scripts/build.mts             everything, for local use
//   node scripts/build.mts --release   only what is published (no *-dev.html pages, no local config.js)
//
// What goes into dist/ (esbuild does the TypeScript and the bundling):
//   ENTRIES            → the pages' modules: each bundled with what it imports into dist/<its path under src/>.js
//                        (src/main.ts → main.js). What they load with import() is a file of its own in
//                        dist/chunks/, fetched only when it is first needed, as is code they share. Source maps.
//   SCRIPTS            → plain scripts outside the bundle, each its own file (src/translate.ts → translate.js)
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
/** Loaded by the pages from the CDN, through their import map: left as imports. */
const EXTERNAL = ['three', 'three/addons/*'];
/**
 * A line in a page that a script from src/ replaces: "<!-- build: src/inline/early.ts -->". Attributes after the
 * path go onto the <script> tag: "<!-- build: src/main.ts type="module" -->".
 */
const MARKER = /^([ \t]*)<!-- build: (src\/[\w./-]+)((?: [a-z]+="[^"]*")*) -->[ \t]*$/gm;
/** Folders the page loads files from. */
export const STATIC_DIRS = ['event-images', 'stop-images', 'stations3d', 'demo-media', 'walkgraph']; // walkgraph: the pedestrian network (walkroute.ts)
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

/** What the last bundle wrote: the file of each entry, and the files it imports (for <link rel="modulepreload">). */
let bundled = new Map<string, { file: string; imports: string[] }>();

/** The modules of ENTRIES → dist/, with their source maps. */
export function bundle(): void {
  fs.rmSync(path.join(DIST, 'chunks'), { recursive: true, force: true });
  const result = buildSync({
    ...OUTPUT, entryPoints: ENTRIES.map((e) => path.join(ROOT, e)), bundle: true, splitting: true, format: 'esm',
    outdir: DIST, outbase: SRC, entryNames: '[dir]/[name]', chunkNames: 'chunks/[name]-[hash]', sourcemap: true,
    external: EXTERNAL, metafile: true,
  });
  bundled = new Map();
  const outputs = result.metafile.outputs;
  const served = (file: string) => web(path.relative(DIST, path.join(ROOT, file)));
  for (const [file, out] of Object.entries(outputs)) {
    if (!out.entryPoint) continue;
    // every file it imports, and what those import in turn: all of them are needed before it can run
    const imports: string[] = [], seen = new Set<string>();
    const walk = (f: string) => {
      for (const i of outputs[f].imports) if (i.kind === 'import-statement' && !i.external && !seen.has(i.path)) { seen.add(i.path); imports.push(served(i.path)); walk(i.path); }
    };
    walk(file);
    bundled.set(out.entryPoint, { file: served(file), imports });
  }
}

/** A plain script (no import or export at run time), with what it imports written into it. */
function classicScript(source: string, write?: string): string {
  const result = buildSync({
    ...OUTPUT, entryPoints: [path.join(ROOT, source)], bundle: true, format: 'iife', external: EXTERNAL,
    ...(write ? { outfile: write, sourcemap: true } : { write: false }),
  });
  return write ? '' : result.outputFiles![0].text;
}

/** The scripts of SCRIPTS → dist/<name>.js */
function buildClassic(): void {
  for (const source of SCRIPTS) {
    const out = path.basename(source).replace(/\.ts$/, '.js');
    if (fs.existsSync(path.join(ROOT, out))) throw new Error(`${out} exists next to ${source}: both would become dist/${out}. Remove one of them.`);
    classicScript(source, path.join(DIST, out));
  }
}

/** A module of ENTRIES as a page loads it: the file, and the files it imports fetched alongside. */
function moduleTags(source: string, indent: string, page: string): string {
  const b = bundled.get(source);
  if (!b) throw new Error(`${page}: ${source} is not a module of ENTRIES (scripts/build.mts)`);
  const up = '../'.repeat(page.split('/').length - 1); // pages in folders (demo/index.html)
  return [...b.imports.map((f) => `${indent}<link rel="modulepreload" href="${up}${f}" />`), `${indent}<script type="module" src="${up}${b.file}"></script>`].join('\n');
}

/** A build marker's script written into the page. */
function inlineScript(source: string): string {
  const code = classicScript(source);
  const end = code.search(/<\/script/i);
  if (end >= 0) {
    const line = code.slice(0, end).split('\n').length;
    throw new Error(`${source}: "</script" (line ${line} of the script) would end the <script> in the page. Write it as '<\\/script'.`);
  }
  return code.endsWith('\n') ? code : code + '\n';
}

/** A page with the scripts its build markers name written into it → dist/ */
export function buildPage(page: string): void {
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  const out = path.join(DIST, page);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, html.replace(MARKER, (_line, indent: string, source: string, attributes: string) =>
    (ENTRIES.includes(source) ? moduleTags(source, indent, page) : `${indent}<script${attributes}>\n${inlineScript(source)}${indent}</script>`)));
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

/** Everything made from src/: the bundle, the plain scripts and the pages that load them. */
export function buildScripts(release = false): void {
  bundle();
  buildClassic();
  for (const page of pages(release)) buildPage(page);
}

export function build({ release = false, clean = release }: { release?: boolean; clean?: boolean } = {}): void {
  if (clean) fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  copyStatic(release);
  buildScripts(release);
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
