// What a screen reader gets from the app, checked in a real browser: the app is opened in headless Chrome at
// phone size and driven through search, events, a journey, guidance (with a simulated GPS position), the
// blind or low-vision mode and Scan. Each check reads the page the way VoiceOver or TalkBack would: roles,
// names, focus, and what is put into the live regions.
//
//   node tools/test_screen_reader.mjs                 everything
//   node tools/test_screen_reader.mjs search,journey  some parts: search, events, journey, guide, access, scan, language, intro
//   SHOTS=/some/dir node tools/test_screen_reader.mjs shots   screenshots of the screens that changed
//
// Builds the site into dist/ first (scripts/build.mts) and serves that. Needs Chrome or Chromium
// (CHROME=/path/to/chrome when it is not on the PATH) and python3 for the local server.
// The app talks to its real services (search, timetable), so it needs the internet and takes a few minutes.
// This does not replace trying it with VoiceOver and TalkBack on a phone: it checks what the app hands to them.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ONLY = process.argv[2] || '';
// ?intro=0: without the first-visit introduction (docs/onboarding.md)
const WEB = 8765, PORT = 9333, URL_ = `http://127.0.0.1:${WEB}/index.html?intro=0`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = process.env.CHROME || ['google-chrome', 'chromium', 'chromium-browser', 'chrome'].find((c) => spawnSync('which', [c]).status === 0);
if (!chrome) { console.error('No Chrome or Chromium found. Set CHROME=/path/to/chrome.'); process.exit(2); }
const built = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build.mts')], { cwd: ROOT, encoding: 'utf8' });
if (built.status !== 0) { console.error('The build failed:\n' + built.stdout + built.stderr); process.exit(2); }
const profile = mkdtempSync(join(tmpdir(), 'sr-test-'));
const server = spawn('python3', ['-m', 'http.server', String(WEB), '--bind', '127.0.0.1'], { cwd: join(ROOT, 'dist'), stdio: 'ignore' });
const browser = spawn(chrome, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--no-first-run', '--disable-gpu',
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
  '--window-size=390,844', 'about:blank'], { stdio: 'ignore' });
const cleanup = () => { server.kill(); browser.kill(); try { rmSync(profile, { recursive: true, force: true }); } catch { /* still in use */ } };
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

let targets;
for (let i = 0; i < 60 && !targets; i++) { try { targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json(); } catch { await sleep(250); } }
if (!targets) { console.error('Chrome did not start.'); process.exit(2); }
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0; const pending = new Map(); const errors = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception ? d.params.exceptionDetails.exception.description : d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') errors.push('console.error: ' + d.params.args.map((a) => a.value || a.description).join(' '));
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, (d) => res(d.result || d)); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) return 'EVAL-ERROR: ' + (r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text); return r.result ? r.result.value : r; };
const key = async (k, code, vk, text) => { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: code || k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, text }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: code || k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); };
const active = () => ev(`(() => { const e = document.activeElement; if (!e) return 'none'; return e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (typeof e.className === 'string' && e.className ? '.' + e.className.trim().split(/\\s+/).join('.') : '') + ' "' + (e.getAttribute('aria-label') || (e.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 60)) + '"'; })()`);
const geo = (ll, acc = 8) => send('Emulation.setGeolocationOverride', { longitude: ll[0], latitude: ll[1], accuracy: acc });
let pass = 0, fail = 0;
const check = (name, ok, detail = '') => { if (ok) pass++; else fail++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== '' ? '  → ' + String(detail).slice(0, 400) : ''}`); };
const said = () => ev(`[document.getElementById('srStatus').textContent, document.getElementById('srAlert').textContent].filter(Boolean).join(' || ')`);
// everything announced, in order (the live regions are watched)
const hear = `window.__heard = []; for (const id of ['srStatus', 'srAlert']) new MutationObserver(() => { const t = document.getElementById(id).textContent; if (t) window.__heard.push((id === 'srAlert' ? '! ' : '') + t); }).observe(document.getElementById(id), { childList: true, characterData: true, subtree: true });`;
const heard = () => ev(`(window.__heard || []).join('\\n')`);
const section = (t) => console.log(`\n=== ${t} ===`);
const shot = async (name) => { const r = await send('Page.captureScreenshot', { format: 'png' }); writeFileSync(join(process.env.SHOTS || tmpdir(), `screen-${name}.png`), Buffer.from(r.data, 'base64')); };
const want = (n) => (ONLY ? ONLY.split(',').includes(n) : n !== 'shots');

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setTouchEmulationEnabled', { enabled: false });
await send('Emulation.setFocusEmulationEnabled', { enabled: true }); // a headless page is not focused: focus events would not fire
await send('Browser.grantPermissions', { permissions: ['geolocation', 'videoCapture'] });
const BERN = [7.4474, 46.9480]; // Zytglogge
await geo(BERN);
await send('Page.navigate', { url: URL_ });
await sleep(9000);
await ev(hear);

section('load');
check('title names the app', /journey planner/i.test(await ev('document.title')), await ev('document.title'));
check('zoom is allowed', !/user-scalable|maximum-scale/.test(await ev(`document.querySelector('meta[name=viewport]').content`)));
check('live regions are in the page', await ev(`!!document.querySelector('#srStatus[aria-live=polite]') && !!document.querySelector('#srAlert[aria-live=assertive]')`));
check('closed time picker and event page are out of reach', await ev(`document.getElementById('tSheet').inert && document.getElementById('evPage').inert`));
check('results list follows the search fields in the page', await ev(`(() => { const f = document.getElementById('searchForm'), l = document.getElementById('results'); return !!(f.compareDocumentPosition(l) & Node.DOCUMENT_POSITION_FOLLOWING) && !l.hasAttribute('role'); })()`));

if (want('search')) {
  section('search');
  await ev(`document.getElementById('q').focus()`); await sleep(300);
  check('empty field offers the events near you', /Events near you/.test(await ev(`document.getElementById('results').textContent`)), await ev(`document.getElementById('results').textContent`));
  await send('Input.insertText', { text: 'Zytglogge' }); await sleep(3500);
  const rows = await ev(`[...document.querySelectorAll('#results li')].map(li => (li.firstElementChild && li.firstElementChild.tagName === 'BUTTON' ? 'button' : 'text') + ':' + li.textContent.trim().slice(0, 40)).join(' | ')`);
  check('every result is a button', /^button:/.test(rows) && !/role=option/.test(rows), rows);
  check('"Show more" is a button', await ev(`!!document.querySelector('#results li.more > button')`));
  check('result count is announced', /\d+ results?/.test(await said()), await said());
  check('names carry their language', await ev(`document.querySelector('#results .title').lang`) === 'de', await ev(`document.querySelector('#results .title').outerHTML`));
  await ev(`document.querySelector('#results li > button').focus()`); await sleep(200); // as TalkBack does before it presses a row
  const a1 = await active();
  check('focus can move from the field into the list, which stays open', /^button/.test(a1) && await ev(`document.getElementById('results').classList.contains('open') && document.getElementById('results').contains(document.activeElement) && document.getElementById('q').value === 'Zytglogge'`), a1);
  await ev(`document.querySelector('#results li.more > button').focus(); document.querySelector('#results li.more > button').click()`); await sleep(300);
  check('after "Show more" focus is on the first new row', await ev(`document.getElementById('results').contains(document.activeElement) && document.activeElement.tagName === 'BUTTON' && !document.activeElement.closest('.more')`), await active());
  check('list is drawn below the search card', await ev(`(() => { const r = document.getElementById('results').getBoundingClientRect(), f = document.getElementById('searchForm').getBoundingClientRect(); return r.top >= f.bottom - 1 && r.height > 50; })()`));
  await ev(`document.getElementById('clear').click()`); await sleep(400);
  await ev(`document.getElementById('q').focus()`);
  await send('Input.insertText', { text: 'toilet' }); await sleep(3500);
  const kinds = await ev(`[...document.querySelectorAll('#results li:not(.on-map):not(.more) .title')].map(t => t.textContent + '=' + (t.lang || '-') + (t.getAttribute('translate') || '')).join(' | ')`);
  check('a place listed by its kind ("Public toilet") is not marked as a name in another language', !/(Public toilet|Customer toilet|Wheelchair toilet)=(de|fr|it)/.test(kinds), kinds);
  await ev(`document.getElementById('clear').click()`); await sleep(400);
}

if (want('events')) {
  section('events in the search');
  await ev(`document.getElementById('q').focus()`); await sleep(300);
  await ev(`document.querySelector('#results li > button').focus(); document.querySelector('#results li > button').click()`); await sleep(2500);
  check('the results take over the focus of "Events near you"', await ev(`document.getElementById('results').contains(document.activeElement)`), await active());
  const evs = await ev(`[...document.querySelectorAll('#results li > button .title')].map(t => t.textContent).slice(0, 4).join(' | ')`);
  check('"Events near you" lists events', await ev(`results.length > 0 && results.every(r => r.origin === 'event')`), evs);
  check('nearest first', await ev(`results.every((r, i) => !i || r.distance >= results[i - 1].distance)`));
  await ev(`document.querySelector('#results li > button').focus(); document.querySelector('#results li > button').click()`); await sleep(900);
  check('an event opens its page', await ev(`document.getElementById('evPage').classList.contains('open') && !document.getElementById('evPage').inert`), await ev('location.hash'));
  check('focus is on Back', /evBack/.test(await active()), await active());
  check('page behind is out of reach', await ev(`document.getElementById('map').inert && document.getElementById('searchWrap').inert && !document.getElementById('srStatus').inert`));
  console.log('      langs:', await ev(`['evTitle','evAbout','evVenue','evCity'].map(i => i + '=' + (document.getElementById(i).lang || '-') + ' "' + document.getElementById(i).textContent.slice(0, 30) + '"').join('; ')`));
  await key('Escape', 'Escape', 27); await sleep(900);
  check('Escape closes it', await ev(`!document.getElementById('evPage').classList.contains('open') && document.getElementById('evPage').inert && !document.getElementById('map').inert`));
  check('focus returns to the row it was opened from, list open again', await ev(`document.getElementById('results').classList.contains('open') && document.getElementById('results').contains(document.activeElement)`), await active());
  await ev(`document.getElementById('q').focus()`); await ev(`document.getElementById('q').value = ''; document.getElementById('q').dispatchEvent(new Event('input'))`);
  await send('Input.insertText', { text: 'language events' }); await sleep(2500);
  check('"language events" narrows them down', await ev(`results.length > 0 && results.every(r => r.origin === 'event')`), await ev(`results.slice(0,3).map(r => r.title + ' — ' + r.subtitle).join(' | ')`));
  await ev(`document.getElementById('clear').click()`); await sleep(300);
}

if (want('journey')) {
  section('journey');
  await ev(`document.getElementById('q').focus()`);
  await send('Input.insertText', { text: 'Zürich HB' }); await sleep(3500);
  await ev(`window.__heard.length = 0; document.getElementById('searchForm').requestSubmit()`);
  await sleep(300);
  check('focus moves to the journey', /section#journey/.test(await active()), await active());
  await sleep(9000);
  let h1 = await heard();
  if (await ev('journeyList')) {
    check('several journeys: their number and the one on the map are announced', /\d+ journeys to .+\. On the map: \d\d:\d\d to \d\d:\d\d/.test(h1), h1);
    check('each journey in the list is worded as one sentence', /^\d\d:\d\d to \d\d:\d\d, .+(direct|change|on foot)/.test(await ev(`document.querySelector('#jBody .jrow').getAttribute('aria-label')`)), await ev(`document.querySelector('#jBody .jrow').getAttribute('aria-label')`));
    await ev(`window.__rows = [...document.querySelectorAll('#jBody ol.journeys > li')]; document.querySelector('#jBody .jrow').focus(); refreshList(); renderBody();`);
    check('the list keeps its rows while the clock moves on', await ev(`document.activeElement.classList.contains('jrow') && [...document.querySelectorAll('#jBody ol.journeys > li')].every((li, i) => li === window.__rows[i])`), await active());
    await ev(`window.__heard.length = 0; document.querySelector('#jBody .jrow').click()`); await sleep(1200);
    h1 = await heard();
    check('picking one moves the focus to the journey', /section#journey/.test(await active()), await active());
  } else console.log('      (one journey only: no list to choose from)');
  check('the journey is announced in one sentence', /Journey to .*: \d\d:\d\d to \d\d:\d\d.*(direct|change)/.test(h1), h1);
  check('…with what to do first', /(Walk|leaves|Leave at)/.test(h1));
  check('sheet is named after the destination', /^Journey to /.test(await ev(`document.getElementById('journey').getAttribute('aria-label')`)), await ev(`document.getElementById('journey').getAttribute('aria-label')`));
  check('a heading leads the sheet', await ev(`!!document.querySelector('#jHead h1')`));
  check('platform is worded for screen readers', /Platform \d+/.test(await ev(`[...document.querySelectorAll('#journey .plat .sr-only')].map(e => e.textContent).join('|')`)), await ev(`[...document.querySelectorAll('#journey .plat')].slice(0,2).map(e => e.innerHTML).join(' ## ')`));
  check('expanders say their state', await ev(`[...document.querySelectorAll('#jBody .expander')].every(b => b.hasAttribute('aria-expanded'))`));
  check('station names carry their language', await ev(`document.querySelector('#jBody .tl-ride .tl-name strong').lang`) === 'de');
  // toggling an expander keeps the focus on it
  await ev(`(() => { const b = document.querySelector('#jBody .expander'); b.focus(); b.click(); })()`); await sleep(400);
  check('an opened list keeps the focus on its button', await ev(`document.activeElement.classList.contains('expander') && document.activeElement.getAttribute('aria-expanded')`) === 'true', await active());
  // the rest of the list was not replaced
  await ev(`window.__li = [...document.querySelectorAll('#jBody ol.tl > li')]; (() => { const b = [...document.querySelectorAll('#jBody .expander')].pop(); b.focus(); b.click(); })()`); await sleep(400);
  check('only the changed step is redrawn', await ev(`(() => { const now = [...document.querySelectorAll('#jBody ol.tl > li')]; return now.filter((li, i) => li === window.__li[i]).length; })()`) >= 2, await ev(`(() => { const now = [...document.querySelectorAll('#jBody ol.tl > li')]; return now.filter((li, i) => li === window.__li[i]).length + ' of ' + now.length + ' kept'; })()`));
  // header buttons survive the minute tick
  await ev(`window.__close = document.querySelector('#jHead [aria-label="Close journey"]'); window.__close.focus()`);
  await ev(`headKey = ''; renderHead(); renderHead(true);`);
  check('header redraw keeps its buttons', await ev(`document.contains(window.__close) && document.activeElement === window.__close`));

  section('time picker');
  await ev(`document.getElementById('whenChip').focus(); document.getElementById('whenChip').click()`); await sleep(500);
  check('opens with focus on the chosen option', await ev(`document.activeElement.dataset.mode`) === 'dep' && await ev(`document.activeElement.getAttribute('aria-pressed')`) === 'true', await active());
  check('page behind is out of reach, backdrop still closes it', await ev(`document.getElementById('journey').inert && document.getElementById('map').inert && !document.getElementById('tDim').inert`));
  await key('Escape', 'Escape', 27); await sleep(400);
  check('Escape closes it and focus returns to its button', await ev(`!document.getElementById('tSheet').classList.contains('open') && document.getElementById('tSheet').inert && document.activeElement.id`) === 'whenChip', await active());
  check('nothing is left out of reach', await ev(`[...document.body.children].filter(e => e.inert).map(e => e.id).join(',')`) === 'tSheet,evPage', await ev(`[...document.body.children].filter(e => e.inert).map(e => e.id).join(',')`));
}

if (want('guide')) {
  section('guidance');
  if (!(await ev('!!journeyConn'))) { await ev(`document.getElementById('q').focus()`); await send('Input.insertText', { text: 'Zürich HB' }); await sleep(3500); await ev(`document.getElementById('searchForm').requestSubmit()`); await sleep(9000); }
  if (await ev('journeyList')) { await ev(`document.querySelector('#jBody .jrow').click()`); await sleep(1200); }
  console.log('      steps:', await ev(`journeySteps.map((st, i) => i + ':' + st.type + (st.type === 'ride' ? ' ' + lineName(st.s.journey) + ' ' + fmtTime(st.t0) + '-' + fmtTime(st.t1) : '')).join(', ')`));
  await ev(`window.__heard.length = 0; (() => { const b = document.querySelector('#jFoot .start'); b.focus(); b.click(); })()`); await sleep(600);
  let h = await heard();
  check('Start switches guidance on and says the current step', /Guidance is on\. .+/.test(h), h);
  check('Start keeps the focus and says what it does next', await ev(`document.activeElement.classList.contains('start') && document.activeElement.getAttribute('aria-label')`) === 'Start: say the current step again', await active());
  await ev(`window.__heard.length = 0; document.querySelector('#jFoot .start').click()`); await sleep(400);
  h = await heard();
  check('Start again repeats the step, without "Guidance is on"', h.length > 10 && !/Guidance is on/.test(h), h);
  await ev(`window.__heard.length = 0`); await sleep(11000);
  check('nothing is repeated while nothing changes', (await heard()) === '', await heard());
  // the first ride's platform changes, goes back to the planned one, and changes again: each is said
  const plat = await ev(`(() => { const r = journeySteps.find(st => st.type === 'ride'); window.__dep = r.s.departure; window.__plat0 = r.s.departure.platform; window.__prog0 = r.s.departure.prognosis; return r.s.departure.platform && Date.now() < r.t0 ? r.s.departure.platform : ''; })()`);
  if (plat) {
    const to = (p) => ev(`window.__heard.length = 0; window.__dep.prognosis = { ...(window.__prog0 || {}), platform: ${JSON.stringify(p)} }; guideTick();`).then(() => sleep(300)).then(heard);
    const other = plat === '9' ? '8' : '9';
    let hp = await to(other);
    check('a platform change interrupts', new RegExp('^! .*change: .* now leaves from \\w+ ' + other + ', not ' + plat).test(hp), hp);
    hp = await to(plat);
    check('…and so does the change back to the planned one', new RegExp('^! .*leaves from \\w+ ' + plat + ' after all, not ' + other).test(hp), hp);
    hp = await to(other);
    check('…and a second change to the other one', new RegExp('^! .*now leaves from \\w+ ' + other).test(hp), hp);
    hp = await to(plat);
    check('…and back once more', /after all/.test(hp), hp);
    await ev(`window.__dep.prognosis = window.__prog0; window.__heard.length = 0`);
  } else console.log('      (the first ride has no platform, or has left: platform changes not checked)');
  // GPS: stand at the boarding point of the first ride
  // (the boarding point itself, which can lie some way from where the drawn walk to it ends)
  const dep = await ev(`journeySteps.find(st => st.type === 'ride').depLL`);
  await ev(`window.__heard.length = 0`);
  await geo(dep); await sleep(7000); await geo([dep[0] + 0.00001, dep[1]]); await sleep(7000);
  h = await heard();
  check('at the boarding point: says where you are and when it leaves', /You are at .+\. .+ (leaves in|is leaving now|left)/.test(h), h);
  // far off the route (two fixes)
  await ev(`window.__heard.length = 0`);
  await geo([dep[0] + 0.01, dep[1] + 0.01]); await sleep(6500); await geo([dep[0] + 0.0101, dep[1] + 0.01]); await sleep(3000);
  check('…but not at the first fixes off it', !/off the route/.test(await heard()), await heard());
  await sleep(6000); await geo([dep[0] + 0.0102, dep[1] + 0.01]); await sleep(6500);
  h = await heard();
  check('off the route interrupts, once it is sure', /^! .*off the route/m.test(h), h);
  // on the ride, half way; then just before the last stop
  const mid = await ev(`(() => { const r = journeySteps.find(st => st.type === 'ride'); return pointAtKm(r.path, lengthKm(r.path) * 0.5); })()`);
  await ev(`window.__heard.length = 0`);
  await geo(mid); await sleep(6500); await geo([mid[0] + 0.00002, mid[1]]); await sleep(6500);
  h = await heard();
  console.log('      mid-ride heard:', JSON.stringify(h), '| track:', await ev(`JSON.stringify(track && { i: track.i, kmIn: +track.kmIn.toFixed(2), off: track.off, missed: !!track.missed })`), '| header:', await ev(`document.querySelector('#jHead .jhead-act') ? document.querySelector('#jHead .jhead-act').innerText.replace(/\\s+/g, ' ') : ''`));
  const end = await ev(`(() => { const r = journeySteps.find(st => st.type === 'ride'); return pointAtKm(r.path, lengthKm(r.path) - 0.2); })()`);
  await ev(`window.__heard.length = 0`);
  await geo(end); await sleep(6500); await geo([end[0] + 0.00002, end[1]]); await sleep(6500);
  h = await heard();
  check('close to your stop: "get off" interrupts', /^! Next stop: .+\. Get off there\./m.test(h), h);
  console.log('      track:', await ev(`JSON.stringify(track && { i: track.i, kmIn: +track.kmIn.toFixed(2), off: track.off, missed: !!track.missed })`));
  check('every announcement is one sentence group, none empty', !/undefined|null|NaN/.test(h + (await heard())), h);
  check('"off the route" looks at the step you are on and its neighbours only', await ev(`(() => {
    const i = journeySteps.findIndex(st => st.type === 'ride'), r = journeySteps[i], w = journeySteps[i - 1];
    if (!w || journeySteps.length < i + 2) return 'skip';
    const on = pointAtKm(r.path, lengthKm(r.path) * 0.5);   // on the ride, far from the walk before it
    const s = snapToTrip(on, 0, r.t0 - 20 * 60000);          // long before it leaves: you are counted on the walk
    return s.i < i ? (s.near < 30 ? 'near the ride' : 'far') : 'counted on the ride';
  })()`) !== 'near the ride');
  await ev(`document.querySelector('#jHead [aria-label="Close journey"]').click()`); await sleep(500);
  check('closing the journey ends guidance', await ev(`guiding === false && guideSaid.size === 0 && !document.body.classList.contains('following')`));
}

if (want('access')) {
  section('blind or low vision mode');
  await ev(`window.__spoken = []; speechSynthesis.speak = (u) => { window.__spoken.push(u.text); }; speechSynthesis.cancel = () => {}; window.__buzz = []; Object.defineProperty(navigator, 'vibrate', { value: (p) => { window.__buzz.push(p); return true; }, configurable: true });`);
  await ev(`document.getElementById('menuBtn').click(); document.getElementById('settingsBtn').click()`); await sleep(700);
  check('with Settings open, announcements can still be heard', await ev(`!document.getElementById('srAlert').inert && !document.getElementById('srStatus').inert && document.getElementById('map').inert`));
  check('settings has Read aloud and Vibrate', await ev(`!!document.querySelector('input[data-setting=readAloud]') && !!document.querySelector('input[data-setting=vibrate]') && !document.getElementById('setAloudRow').hidden`));
  await ev(`document.querySelector('input[data-setting=readAloud]').click(); document.querySelector('input[data-setting=vibrate]').click(); document.querySelector('input[data-setting=lowVision]').click()`); await sleep(300);
  check('switching Read aloud on says so with the voice', (await ev(`window.__spoken.join('|')`)).includes('Read aloud is on.'), await ev(`window.__spoken.join('|')`));
  check('switching Vibrate on buzzes once', await ev(`window.__buzz.length`) === 1);
  await ev(`document.getElementById('settingsClose').click()`); await sleep(700);
  await geo(BERN); await sleep(500);
  await ev(`document.getElementById('q').focus()`);
  await send('Input.insertText', { text: 'Bern Wankdorf Bahnhof' }); await sleep(3500);
  console.log('      top result:', await ev(`results[0] && results[0].title + ' — ' + results[0].subtitle`));
  await ev(`window.__heard.length = 0; window.__spoken.length = 0; document.getElementById('searchForm').requestSubmit()`); await sleep(11000);
  check('journeys open as a list', await ev(`document.getElementById('journey').dataset.detent`) === 'full', await ev(`document.getElementById('journey').dataset.detent`));
  check('what was found is read aloud', /Journey to|journeys to/.test(await ev(`window.__spoken.join('|')`)), await ev(`window.__spoken.join(' | ')`));
  if (await ev('journeyList')) { await ev(`document.querySelector('#jBody .jrow').click()`); await sleep(1500); }
  console.log('      steps:', await ev(`journeySteps.map((st, i) => i + ':' + st.type + (st.type === 'ride' ? ' ' + lineName(st.s.journey) + ' from ' + st.s.departure.station.name + ' ' + (quayOf(st, 'dep').label || '-') : '')).join(', ')`));
  check('the journey stays a list once picked', await ev(`document.getElementById('journey').dataset.detent`) === 'full', await ev(`document.getElementById('journey').dataset.detent`));
  check('the journey is read aloud', (await ev(`window.__spoken.join('|')`)).includes('Journey to'), await ev(`window.__spoken.join(' | ')`));
  const acc = await ev(`JSON.stringify(journeySteps.filter(st => st.type === 'ride').map(st => stopAccess(st)))`);
  check('tactile / speech data found for the boarding points', /Tactile|Spoken|speech/.test(acc), acc);
  check('…and shown in "Where to stand"', /Tactile|Spoken|speech/.test(await ev(`[...document.querySelectorAll('#jBody .stand-note')].map(e => e.textContent).join(' | ')`)), await ev(`[...document.querySelectorAll('#jBody .stand-note')].map(e => e.textContent).join(' | ')`));
  console.log('      sound crossings per walk:', await ev(`JSON.stringify(journeySteps.map((st, i) => (st.type === 'walk' || st.type === 'change') ? i + ':' + soundCrossings(stepCoords(st)) : null).filter(Boolean))`), '| posts loaded:', await ev(`soundPosts ? soundPosts.length : 'none'`), '| lines:', await ev(`[...document.querySelectorAll('#jBody .quiet-line')].map(e => e.textContent).filter(t => /sound/.test(t)).join(' | ')`));
  check('a walk past a signal post counts its crossing once', await ev(`(() => { const p = soundPosts[0]; return soundCrossings([[[p[0] - 0.0005, p[1]], [p[0] + 0.0005, p[1]]]]) + '/' + soundCrossings([[[p[0] - 0.0005, p[1] + 0.001], [p[0] + 0.0005, p[1] + 0.001]]]); })()`) === '1/0');
  check('…and two lines of a walk are not joined across the block between them', await ev(`(() => { const p = soundPosts[0]; return soundCrossings([[[p[0] - 0.002, p[1] - 0.001], [p[0] - 0.001, p[1] - 0.001]], [[p[0] + 0.001, p[1] + 0.001], [p[0] + 0.002, p[1] + 0.001]]]); })()`) === 0);
  check('a walk that has not been routed yet claims no crossings', await ev(`walkPaths({ lines: [[[7.44, 46.94], [7.45, 46.95]]], walks: [] }).length`) === 0);
  check('a bay without tactile guidance does not borrow its neighbour\'s', await ev(`(() => {
    const st = PLATFORMS.get('8590129'); if (!st) return 'no stop';
    const of = (ref) => { const e = st.edges.find(x => x.ref === ref); return e ? stopAccess({ s: { departure: { station: { id: '8590129' }, platform: ref }, journey: { category: 'B' } }, depLL: e.ll, depAt: { edge: e } }).join('+') : 'no edge'; };
    return of('A') + ' | ' + of('B');
  })()`) === 'Tactile guide lines+Tactile field at the boarding point+Departure display with speech | ', await ev(`(() => { const st = PLATFORMS.get('8590129'); if (!st) return 'no stop'; return st.edges.map(e => e.ref + ':' + stopAccess({ s: { departure: { station: { id: '8590129' }, platform: e.ref }, journey: { category: 'B' } }, depLL: e.ll, depAt: { edge: e } }).length).join(' '); })()`));
  const many = await ev(`(() => { const r = journeySteps.find(st => st.type === 'ride' && stopKms(st).length >= 3); if (!r) return null; const k = stopKms(r); window.__r = r; return { before: pointAtKm(r.path, k[k.length - 2] - 0.022), past: pointAtKm(r.path, k[k.length - 2] + 0.06), i: journeySteps.indexOf(r) }; })()`);
  if (many) {
    const at = (ll) => ev(`(() => { const r = window.__r, i = ${many.i}, now = r.t1 - 100000; track = { i, kmIn: snapToTrip(${JSON.stringify(ll)}, tripLayout().km0[i], now).kmIn, km: 0, d: 0, near: 0, cost: 0, v: geoVersion, offCount: 0, off: false }; const g = guidePosition(now); return g ? g.key + ' :: ' + g.text : 'nothing'; })()`);
    const before = await at(many.before), past = await at(many.past);
    check('22 m before the stop before yours: not yet "get off at the next stop"', !/Get off|next stop/i.test(before), before);
    check('once that stop is behind you: "Next stop … Get off there"', /^last\|.*Next stop: .+\. Get off there\./.test(past), past);
    await ev(`track = null`);
  } else console.log('      (no ride with a stop on the way: the early "get off" is not checked)');
  await ev(`window.__heard.length = 0; window.__buzz.length = 0; document.querySelector('#jFoot .start').click()`); await sleep(500);
  check('Start keeps the list open in this mode', await ev(`document.getElementById('journey').dataset.detent`) === 'full');
  check('guidance buzzes', await ev(`window.__buzz.length`) >= 1, await ev(`JSON.stringify(window.__buzz)`));
  console.log('      heard:', await heard());
  await ev(`document.querySelector('#jHead [aria-label="Close journey"]').click()`); await sleep(400);
  // back to defaults for the sections that follow
  await ev(`for (const k of ['readAloud', 'vibrate', 'lowVision']) { const i = document.querySelector('input[data-setting=' + k + ']'); if (i.checked) i.click(); }`);
}

if (want('scan')) {
  section('scan');
  await geo(BERN); await sleep(300);
  await ev(`window.__heard.length = 0; document.getElementById('menuBtn').click(); document.getElementById('scanBtn').click()`);
  await sleep(9000);
  check('Scan opens as a dialog with the focus in it', await ev(`!!document.querySelector('.sv[role=dialog]') && document.activeElement === document.querySelector('.sv')`), await active());
  check('the app behind is out of reach', await ev(`document.getElementById('map').inert && document.getElementById('menu').inert`));
  check('camera picture is hidden from screen readers', await ev(`document.querySelector('.sv video').getAttribute('aria-hidden')`) === 'true');
  check('the card is no longer one big live region', await ev(`!document.querySelector('.sv-sheet').hasAttribute('aria-live') && !document.querySelector('.sv-status').hasAttribute('role')`));
  const sv = await ev(`document.querySelector('.sv-say').textContent`);
  check('the stop is said in one sentence with its departures', /(Nearest stop|Recognised|Possible match): .+ metres.*\. (Next: .+ to .+ at \d\d:\d\d|No departures)/.test(sv), sv);
  check('other stops nearby are buttons', await ev(`document.querySelectorAll('.sv-alt li').length === document.querySelectorAll('.sv-alt li > button').length`), await ev(`document.querySelectorAll('.sv-alt li').length + ' alternatives: ' + [...document.querySelectorAll('.sv-alt li > button')].map(b => b.getAttribute('aria-label')).join(' | ')`));
  await sleep(6000);
  check('it is not said again while nothing changes', (await ev(`document.querySelector('.sv-say').textContent`)) === sv, await ev(`document.querySelector('.sv-say').textContent`));
  await ev(`window.__heard.length = 0; document.querySelector('.sv-actions button').click()`); await sleep(6000);
  check('"Show on map" closes Scan and gives everything back', await ev(`!document.querySelector('.sv') && !document.getElementById('map').inert && !document.getElementById('menu').inert`));
  check('the stop card takes the focus', await ev(`!!document.activeElement.closest('.maplibregl-popup')`), await active());
  check('its departures are said', /Next|departures/.test(await heard()), await heard());
  await key('Escape', 'Escape', 27); await sleep(400);
  check('the stop card closes with Escape (or its Close button), without the map', await ev(`!document.querySelector('.maplibregl-popup') && document.activeElement.id`) === 'menuBtn', await active());
}

if (want('language')) {
  section('another app language (Settings › Language, through Google Translate)');
  await ev(`localStorage.setItem('app-language', 'de'); location.reload()`); await sleep(9000);
  await ev(hear);
  await geo(BERN);
  await ev(`document.getElementById('q').focus()`);
  await send('Input.insertText', { text: 'Zytglogge' }); await sleep(5000);
  const said = await heard();
  if (/\d+ results/.test(said)) console.log('      (Google Translate did not answer: the sentence was said in English, as intended)  →', said);
  else {
    check('an announcement is said in the app language', /\d+ \S*rgebnis/i.test(said), said);
    check('…and only once, not first in English', said.split('\n').length === 1, JSON.stringify(said));
  }
  check('names stay as they are and keep their language', await ev(`(() => { const t = document.querySelector('#results .title'); return t.getAttribute('translate') === 'no' && /Zytglogge/.test(t.textContent); })()`), await ev(`document.querySelector('#results .title').outerHTML`));
  check('the page says which language it is in', await ev(`document.documentElement.lang`) === 'de');
  await ev(`document.getElementById('q').value = ''; document.getElementById('q').dispatchEvent(new Event('input'))`);
  await send('Input.insertText', { text: 'Zürich HB' }); await sleep(4000);
  await ev(`document.getElementById('searchForm').requestSubmit()`); await sleep(10000);
  if (await ev('journeyList')) {
    await sleep(1500); // the translator has rewritten the rows by now
    // (a row whose minutes have just moved on is rightly drawn again: the rows that say the same as before must stay)
    const kept = await ev(`(() => {
      const ol = document.querySelector('#jBody ol.journeys'), olds = [...ol.children];
      const fresh = document.createElement('div'); fresh.append(buildBody());
      const same = olds.map((li, i) => drawn.get(li) === fresh.querySelector('ol.journeys').children[i].outerHTML);
      const translated = olds.some((li) => li.outerHTML !== drawn.get(li));
      renderBody();
      const now = [...ol.children];
      return { unchanged: same.filter(Boolean).length, kept: same.every((u, i) => !u || now[i] === olds[i]), translated };
    })()`);
    check('translated rows are kept from one redraw to the next', kept.translated && kept.unchanged > 0 && kept.kept, JSON.stringify(kept));
  } else console.log('      (one journey only: the list is not checked)');
  // an alert still being translated when the journey closes is dropped
  await ev(`window.__heard.length = 0; A11Y.say('The change at Bern will not work.', { urgent: true }); A11Y.hush();`); await sleep(2500);
  check('a sentence still being translated is dropped when the journey closes', (await heard()) === '', await heard());
  await ev(`localStorage.removeItem('app-language'); location.reload()`); await sleep(8000);
  await ev(hear);
}

if (want('intro')) {
  section('first visit with a shared event link');
  const evId = await ev(`EVENTS.features[0].properties.id`);
  await ev(`localStorage.clear()`);
  await send('Page.navigate', { url: URL_.replace('?intro=0', '') + '#event/' + encodeURIComponent(evId) });
  await sleep(9000);
  check('the introduction is showing', await ev(`!!document.getElementById('onboarding') && document.documentElement.dataset.onboarding === 'first'`));
  check('…and can be used: it is not out of reach', await ev(`!document.getElementById('onboarding').inert`));
  check('…and has the focus, not the event page under it', await ev(`document.getElementById('onboarding').contains(document.activeElement)`), await active());
  for (const go of ['speed', 'access', 'done']) { await ev(`document.querySelector('#onboarding [data-page]:not([hidden]) [data-go="${go}"]').click()`); await sleep(900); }
  await sleep(1500);
  check('after it, the event page can be used', await ev(`document.getElementById('evPage').classList.contains('open') && !document.getElementById('evPage').inert`), await ev(`[...document.body.children].filter(e => e.inert).map(e => e.id || e.className).join(',')`));
  await ev(`document.getElementById('evBack').click()`); await sleep(1200);
  check('…and closed, with nothing left out of reach', await ev(`[...document.body.children].filter(e => e.inert).map(e => e.id).join(',')`) === 'tSheet,evPage', await ev(`[...document.body.children].filter(e => e.inert).map(e => e.id).join(',')`));
  await send('Page.navigate', { url: URL_ }); await sleep(8000);
  await ev(hear);
}

if (want('shots')) {
  section('screenshots');
  await geo(BERN);
  await ev(`document.getElementById('q').focus()`); await sleep(500); await shot('1-empty-focus');
  await send('Input.insertText', { text: 'Zytglogge' }); await sleep(3500); await shot('2-results');
  await ev(`document.getElementById('q').value = ''; document.getElementById('q').dispatchEvent(new Event('input'))`);
  await send('Input.insertText', { text: 'events' }); await sleep(2500); await shot('3-events');
  await ev(`document.getElementById('q').value = ''; document.getElementById('q').dispatchEvent(new Event('input'))`);
  await send('Input.insertText', { text: 'Bern Wankdorf Bahnhof' }); await sleep(3500);
  await ev(`document.getElementById('searchForm').requestSubmit()`); await sleep(11000); await shot('4-journeys');
  if (await ev('journeyList')) { await ev(`document.querySelector('#jBody .jrow').click()`); await sleep(1500); }
  await shot('4-journey-low');
  await ev(`setDetent('full')`); await sleep(900); await shot('5-journey-full');
  await ev(`document.querySelector('#jBody .expander').click()`); await sleep(500); await shot('6-directions');
  await ev(`document.getElementById('whenChip').click()`); await sleep(900); await shot('7-time');
  await ev(`document.getElementById('tClose').click()`); await sleep(500);
  await ev(`document.querySelector('input[data-setting=lowVision]').click()`); await sleep(1500); await shot('8-journey-blind-mode');
  await ev(`document.querySelector('input[data-setting=lowVision]').click()`);
  await ev(`document.getElementById('menuBtn').click(); document.getElementById('settingsBtn').click()`); await sleep(900); await shot('9-settings');
  await ev(`document.getElementById('setGuideHead').scrollIntoView()`); await sleep(400); await shot('10-settings-guidance');
}
console.log(`\n${pass} passed, ${fail} failed`);
if (errors.length) console.log('JS errors:\n  ' + [...new Set(errors)].join('\n  '));
else console.log('no JS errors');
ws.close();
process.exit(fail || errors.length ? 1 : 0);
