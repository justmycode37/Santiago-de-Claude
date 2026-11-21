// Builds the site into dist/: the folder GitHub Pages publishes and `npm run dev` serves.
//
//   node scripts/build.mts             everything, for local use
//   node scripts/build.mts --release   only what is published (no *-dev.html pages, no local config.js)
//
// What goes into dist/:
//   src/<name>.ts      → <name>.js. The types are replaced by spaces and nothing else is touched, so the
//                        script the browser runs is the source, line for line (no source maps needed).
//   src/app/*.ts       → the page's own script, joined in file name order and put into index.html where
//                        APP_MARKER stands. The files share one scope, as one script would.
//   *.html *.css *.js  → copied (the .js files in the repository root are generated data and config.js)
//   STATIC_DIRS, DEMO  → copied
//
// Types are not checked here (`npm run check` does that), so a type error never blocks a build.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { transformSync } from 'amaro';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DIST = path.join(ROOT, 'dist');
export const SRC = path.join(ROOT, 'src');
export const APP = path.join(SRC, 'app');

/** The line in index.html that the page's own script replaces. */
const APP_MARKER = /^[ \t]*<!-- build: src\/app -->[ \t]*$/m;
/** Folders the page loads files from. */
export const STATIC_DIRS = ['event-images', 'stop-images', 'stations3d', 'demo-media'];
/** The demo page and the two files it plays, not the raw screen recordings next to them. */
const DEMO = ['demo/index.html', 'demo/opening.jpg', 'demo/santiago.mp4'];
/** In the repository root, but not published: the development pages, the config template and a local config. */
const notReleased = (file: string) => /-dev\.html$/.test(file) || file === 'config.example.js' || file === 'config.js';

const rel = (file: string) => path.relative(ROOT, file);

/** TypeScript → JavaScript: every type becomes spaces, so line and column numbers stay the same. */
export function stripTypes(file: string): string {
  try {
    return transformSync(fs.readFileSync(file, 'utf8'), { mode: 'strip-only' }).code;
  } catch (e) {
    throw new Error(`${rel(file)}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
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

/** The page's own script: src/app/*.ts in file name order, as one script. */
export function appScript(): string {
  const code = tsFiles(APP).map((f) => stripTypes(path.join(APP, f))).join('\n');
  const at = code.search(/<\/script/i);
  if (at >= 0) {
    const line = code.slice(0, at).split('\n').length;
    throw new Error(`src/app: "</script" (line ${line} of the joined script) would end the script in index.html. Write it as '<\\/script'.`);
  }
  return code;
}

/** index.html with the page's own script in it → dist/index.html */
export function buildIndex(): void {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  if (!APP_MARKER.test(html)) throw new Error('index.html: the line "<!-- build: src/app -->" is missing');
  fs.writeFileSync(path.join(DIST, 'index.html'), html.replace(APP_MARKER, () => `  <script>\n${appScript()}  </script>`));
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

/** The pages, stylesheets and scripts in the repository root that are served as they are. */
export function rootFiles(release: boolean): string[] {
  return fs.readdirSync(ROOT).filter((f) => /\.(html|css|js)$/.test(f) && f !== 'index.html' && !(release && notReleased(f)));
}

export function copyStatic(release: boolean): void {
  for (const f of rootFiles(release)) copy(path.join(ROOT, f), path.join(DIST, f));
  for (const d of STATIC_DIRS) copyDir(path.join(ROOT, d), path.join(DIST, d));
  for (const f of DEMO) copy(path.join(ROOT, f), path.join(DIST, f));
}

export function buildScripts(): void {
  for (const f of tsFiles(SRC)) buildScript(f);
  buildIndex();
}

export function build({ release = false, clean = release }: { release?: boolean; clean?: boolean } = {}): void {
  if (clean) fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  copyStatic(release);
  buildScripts();
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
