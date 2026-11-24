// One command for an AR field test on a phone (docs/ar-field-test.md): this branch's site and Kante engine, on this
// computer, reachable from the phone over HTTPS through Tailscale (camera and motion need HTTPS).
//
//   npm run ar-test -- [--data DIR] [--port 8097] [--engine-port 8096] [--https-port 10002] [--no-tailscale]
//
// It builds the engine (kante/engine, cargo) and the site (dist/), starts the engine on 127.0.0.1, serves dist/ with
// the engine's /api/* behind the same address, and prints the link to open on the phone. The page it serves uses
// that engine (not the hosted one, which runs main) and has the AR debug line on. "Save last 10 s" on the phone then
// sends the capture here, into tools/ar-replays/ (docs/ar-field-test.md: "After the session"). Ctrl+C stops the
// engine and the Tailscale address.
//
// DIR: the engine's data (kante/README.md: raw/, built/, secrets/otd.json for live data). Default: $KANTE_DATA, else
// kante/data. Without the live-data key the engine has no live board and the camera never shows green.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] ? args[i + 1] : d; };
const DATA = path.resolve(opt('--data', process.env.KANTE_DATA || path.join(ROOT, 'kante', 'data')));
const PORT = Number(opt('--port', '8097'));
const ENGINE_PORT = Number(opt('--engine-port', '8096'));
const HTTPS_PORT = Number(opt('--https-port', '10002'));
const TAILSCALE = !args.includes('--no-tailscale');
const DIST = path.join(ROOT, 'dist');
const REPLAYS = path.join(ROOT, 'tools', 'ar-replays');
const EXE = path.join(ROOT, 'kante', 'engine', 'target', 'release', process.platform === 'win32' ? 'kante.exe' : 'kante');

const step = (s: string) => console.log(`\n== ${s}`);
const run = (cmd: string, a: string[], cwd = ROOT) => {
  const r = spawnSync(cmd, a, { cwd, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`failed: ${cmd} ${a.join(' ')}`); process.exit(1); }
};

if (!fs.existsSync(path.join(DATA, 'built'))) {
  console.error(`No engine data in ${DATA} (needs built/). Pass --data DIR or set KANTE_DATA; kante/README.md says how to make it.`);
  process.exit(1);
}
const liveKey = fs.existsSync(path.join(DATA, 'secrets', 'otd.json'));

step('Building the engine (kante/engine)');
run('cargo', ['build', '--release', '-p', 'kante-server'], path.join(ROOT, 'kante', 'engine'));
step('Building the site (dist/)');
run(process.execPath, ['scripts/build.mts']);

step(`Starting the engine on 127.0.0.1:${ENGINE_PORT}`);
const engine: ChildProcess = spawn(EXE, ['serve', '--data', DATA, '--port', String(ENGINE_PORT), '--bind', '127.0.0.1', '--app', 'none'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
const engineLog = fs.createWriteStream(path.join(ROOT, 'tools', 'ar-test-engine.log'));
engine.stdout!.pipe(engineLog); engine.stderr!.pipe(engineLog);
engine.on('exit', (code) => { if (!stopping) { console.error(`The engine stopped (${code}); see tools/ar-test-engine.log`); stop(1); } });

let stopping = false;
const stop = (code = 0) => {
  stopping = true;
  engine.kill();
  if (TAILSCALE) spawnSync('tailscale', ['serve', `--https=${HTTPS_PORT}`, 'off'], { stdio: 'ignore' });
  process.exit(code);
};
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());

const meta = async () => {
  for (let i = 0; i < 300; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${ENGINE_PORT}/api/meta`);
      if (r.ok) return await r.json() as { realtime?: { feeds?: unknown } };
    } catch { /* not up yet */ }
    await new Promise((res) => setTimeout(res, 1000));
  }
  console.error('The engine did not answer within 5 minutes; see tools/ar-test-engine.log'); stop(1);
};
await meta();
console.log('engine up');

// The page reads config.js (optional, not committed) for its settings: keep the local one, then point the engine at
// this address and turn the capture upload on.
const CONFIG_JS = () => {
  const own = fs.existsSync(path.join(DIST, 'config.js')) ? fs.readFileSync(path.join(DIST, 'config.js'), 'utf8') : '';
  return `${own}\nwindow.APP_CONFIG = Object.assign(window.APP_CONFIG || {}, { kanteUrl: location.origin, arCaptureUrl: location.origin + '/ar-capture' });\n`;
};
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.geojson': 'application/geo+json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.onnx': 'application/octet-stream', '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://x');
  if (url.pathname.startsWith('/api/')) { // the engine, behind the same address
    const up = http.request({ host: '127.0.0.1', port: ENGINE_PORT, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${ENGINE_PORT}` } },
      (r) => { res.writeHead(r.statusCode || 502, r.headers); r.pipe(res); });
    up.on('error', () => { res.writeHead(502); res.end('engine down'); });
    req.pipe(up);
    return;
  }
  if (url.pathname === '/ar-capture' && req.method === 'POST') { // "Save last 10 s" on the phone
    const parts: Buffer[] = []; let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size < 64e6) parts.push(c); });
    req.on('end', () => {
      try {
        const body = Buffer.concat(parts).toString('utf8');
        const j = JSON.parse(body) as { format?: string };
        if (j.format !== 'ar-capture/1') throw new Error('not a capture');
        const name = String(url.searchParams.get('name') || `ar-capture-${Date.now()}.json`).replace(/[^\w.-]/g, '_');
        fs.mkdirSync(REPLAYS, { recursive: true });
        fs.writeFileSync(path.join(REPLAYS, name), body);
        console.log(`capture saved: tools/ar-replays/${name}`);
        res.writeHead(200, { 'content-type': 'text/plain' }); res.end('saved');
      } catch (e) { res.writeHead(400); res.end(String(e)); }
    });
    return;
  }
  if (url.pathname === '/config.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-cache' }); res.end(CONFIG_JS());
    return;
  }
  let file = path.join(DIST, decodeURIComponent(url.pathname));
  if (!file.startsWith(DIST)) { res.writeHead(403); res.end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});
server.listen(PORT, '127.0.0.1');

let base = `http://127.0.0.1:${PORT}`;
if (TAILSCALE) {
  const r = spawnSync('tailscale', ['serve', '--bg', `--https=${HTTPS_PORT}`, `http://127.0.0.1:${PORT}`], { encoding: 'utf8' });
  const st = spawnSync('tailscale', ['status', '--json'], { encoding: 'utf8' });
  const dns = r.status === 0 && st.status === 0 ? String((JSON.parse(st.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName || '').replace(/\.$/, '') : '';
  if (dns) base = `https://${dns}:${HTTPS_PORT}`;
  else console.error(`tailscale serve failed (${(r.stderr || r.stdout || '').trim()}); the phone cannot reach this computer over HTTPS`);
}

console.log(`
Open on the phone (Tailscale on, same account):

  ${base}/?ardebug=1

Live data: ${liveKey ? 'yes' : `NO - no ${path.join(DATA, 'secrets', 'otd.json')}: the camera will never show green`}
Captures ("Save last 10 s") land in tools/ar-replays/. Engine log: tools/ar-test-engine.log. Ctrl+C stops everything.`);
