// Builds the site into dist/: the folder GitHub Pages publishes and `npm run dev` serves.
//
//   node scripts/build.mts             everything, for local use
//   node scripts/build.mts --release   only what is published (no *-dev.html pages, no local config.js)
//
// What goes into dist/ (esbuild does the TypeScript):
//   src/<name>.ts      → <name>.js, the script as it is with its types taken out
//   *.html             → copied, with every line "<!-- build: src/… -->" replaced by a <script> holding that
//                        file, or that folder's files joined in file name order. src/app is the page's own
//                        script: its files share one scope, as one script would. src/inline and src/pages
//                        hold the small scripts written into index.html and into the other pages.
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

/**
 * A line in a page that a script from src/ replaces: "<!-- build: src/app -->", "<!-- build: src/inline/early.ts -->".
 * Attributes after the path go onto the <script> tag: "<!-- build: src/pages/x.ts type="module" -->".
 */
const MARKER = /^([ \t]*)<!-- build: (src\/[\w./-]+)((?: [a-z]+="[^"]*")*) -->[ \t]*$/gm;
/** Folders the page loads files from. */
export const STATIC_DIRS = ['event-images', 'stop-images', 'stations3d', 'demo-media', 'walkgraph']; // walkgraph: the pedestrian network (walkroute.js)
/** The demo page and the two files it plays, not the raw screen recordings next to them. */
const DEMO_PAGE = 'demo/index.html';
const DEMO = ['demo/opening.jpg', 'demo/santiago.mp4'];
/** In the repository root, but not published: the development pages, the config template and a local config. */
const notReleased = (file: string) => /-dev\.html$/.test(file) || file === 'config.example.js' || file === 'config.js';

const rel = (file: string) => path.relative(ROOT, file);

/** What esbuild writes: today's syntax as it is (nothing lowered), and the text as written (no \u escapes). */
const OUTPUT = { target: 'esnext', charset: 'utf8', logLevel: 'silent' } as const;

/** esbuild's errors as one message: "src/x.ts:12:3: Expected ";" but found "}"". */
function failed(e: unknown): Error {
  const errors = (e as esbuild.BuildFailure).errors;
  if (!errors) return e instanceof Error ? e : new Error(String(e));
  return new Error(errors.map((m) => (m.location ? `${m.location.file}:${m.location.line}:${m.location.column}: ` : '') + m.text).join('\n'), { cause: e });
}

/** TypeScript → JavaScript: the types taken out, the script otherwise as it is. */
export function stripTypes(file: string): string {
  try {
    return esbuild.transformSync(fs.readFileSync(file, 'utf8'), { ...OUTPUT, loader: 'ts', sourcefile: rel(file) }).code;
  } catch (e) {
    throw failed(e);
  }
}

const tsFiles = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts')).sort();

/** src/<name>.ts → dist/<name>.js */
export function buildScript(name: string): void {
  const out = name.replace(/\.ts$/, '.js');
  if (fs.existsSync(path.join(ROOT, out))) {
    throw new Error(`${out} exists next to src/${name}: both would become dist/${out}. Remove one of them.`);
  }
  fs.writeFileSync(path.join(DIST, out), stripTypes(path.join(SRC, name)));
}

/** What a build marker names, as one script: a file, or a folder's files in file name order. */
function inlineScript(source: string): string {
  const at = path.join(ROOT, source);
  const code = fs.statSync(at).isDirectory() ? tsFiles(at).map((f) => stripTypes(path.join(at, f))).join('\n') : stripTypes(at);
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
  fs.writeFileSync(out, html.replace(MARKER, (_line, indent: string, source: string, attributes: string) => `${indent}<script${attributes}>\n${inlineScript(source)}${indent}</script>`));
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

export function buildScripts(release = false): void {
  for (const f of tsFiles(SRC)) buildScript(f);
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
