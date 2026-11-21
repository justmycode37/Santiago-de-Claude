// Local development: builds dist/, serves it, and rebuilds when a file changes.
//
//   npm run dev                      http://localhost:8000
//   npm run dev -- 8000 0.0.0.0      also reachable from other devices on the network
//
// For a phone, `python3 tools/serve.py` serves the same dist/ gzipped and cached; keep this running next to
// it (on another port) and it stays up to date.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { DIST, ROOT, SRC, STATIC_DIRS, build, buildScripts, copyStatic } from './build.mts';

const port = Number(process.argv[2] ?? process.env.PORT ?? 8000);
const host = process.argv[3] ?? process.env.HOST ?? '127.0.0.1';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.geojson': 'application/geo+json', '.md': 'text/markdown; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
  '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
};

const time = () => new Date().toTimeString().slice(0, 8);
function attempt(what: string, run: () => void): void {
  const started = Date.now();
  try {
    run();
    console.log(`${time()}  ${what} (${Date.now() - started} ms)`);
  } catch (e) {
    console.error(`${time()}  ${what} failed: ${e instanceof Error ? e.message : e}`);
  }
}

attempt('built dist/', () => build({ clean: true }));

// ---- rebuild on change: scripts are quick to redo as a whole; everything else is copied when it changed
let scripts = false, files = false, timer: NodeJS.Timeout | undefined;
function changed(kind: 'scripts' | 'files'): void {
  if (kind === 'scripts') scripts = true; else files = true;
  clearTimeout(timer);
  timer = setTimeout(() => {
    const what = [files && 'files', (scripts || files) && 'scripts'].filter(Boolean).join(' and ');
    const copy = files;
    scripts = files = false;
    attempt(`rebuilt ${what}`, () => { if (copy) copyStatic(false); buildScripts(); });
  }, 60);
}
fs.watch(SRC, { recursive: true }, () => changed('scripts'));
fs.watch(ROOT, (_event, name) => { if (name && /\.(html|css|js)$/.test(name)) changed('files'); });
for (const dir of [...STATIC_DIRS, 'demo']) fs.watch(path.join(ROOT, dir), { recursive: true }, () => changed('files'));

// ---- serve dist/
http.createServer((req, res) => {
  let file: string;
  try {
    file = path.join(DIST, path.normalize(decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname)));
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (!file.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (fs.statSync(file, { throwIfNoEntry: false })?.isDirectory()) file = path.join(file, 'index.html');
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat?.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
}).listen(port, host, () => {
  console.log(`Serving dist/ at http://${host === '127.0.0.1' || host === '0.0.0.0' ? 'localhost' : host}:${port}/  (sources: ${path.relative(ROOT, SRC)}/)`);
});
