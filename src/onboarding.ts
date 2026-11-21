// The introduction for a first visit: a welcome page, the demo (a first-person walk in the 3D station view),
// then two short questions that set existing settings (walking speed, access needs), then the map.
// Whether it shows is decided in the <head> of index.html (localStorage 'onboarding', ?intro), which also holds back
// the location prompt until it is over. Settings › "Show the introduction again" opens it once more.
// Nothing is kept here: every answer goes straight into settings.js (window.SETTINGS).
(function () {
  'use strict';

  /** The access needs asked for: switches of the settings page. */
  type NeedKey = 'wheelchair' | 'stepFree' | 'fewerStairs' | 'noEscalators' | 'lowVision';
  interface Need { key: NeedKey; color: string; title: string; note: string; icon: string }
  /** What the demo reports while it runs, and how it ended. */
  type DemoState = 'arrived' | 'error' | 'playing';
  type DemoEnd = 'finished' | 'skipped' | 'unavailable';
  interface Demo { over: Promise<DemoEnd>; close(): void }
  /** The stand-in walk that moves the viewer's slider. */
  interface Walker { stop(): void }
  /** A listener for one of the viewer's events, kept to take it off again. */
  type Heard = [name: keyof Station3DEventMap, fn: (detail: never) => void];
  type PageName = 'welcome' | 'demo' | 'speed' | 'access';

  const KEY = 'onboarding';
  const html = document.documentElement;
  const me = document.currentScript as HTMLScriptElement | null;
  const BASE = ((me && me.src) || '').replace(/[^/]*(\?.*)?$/, '');
  const SETTINGS = window.SETTINGS;
  const reducedMotion = () => !!((window.matchMedia as typeof matchMedia | undefined) && matchMedia('(prefers-reduced-motion: reduce)').matches);

  // The five stops of the walking speed slider: settings.js exports them once the walking-speed-auto branch is in
  // (SETTINGS.speedPresets); until then this is the same list
  const SPEED_NOTES = ['A careful pace, or with small children', 'A stroll', 'The pace timetables assume', 'Walking with a purpose', 'Almost a jog'];
  const SPEEDS = ((SETTINGS && SETTINGS.speedPresets) || [
    { label: 'Slow', kmh: 3 },
    { label: 'Relaxed', kmh: 4 },
    { label: 'Normal', kmh: 4.7 },
    { label: 'Brisk', kmh: 5.5 },
    { label: 'Fast', kmh: 6.5 },
  ]).map((s, i, all) => ({ label: s.label, kmh: s.kmh, note: all.length === SPEED_NOTES.length ? SPEED_NOTES[i] : '' }));
  // Access needs → the switches of the settings page (same keys, icons and colours)
  const NEEDS: Need[] = [
    { key: 'wheelchair', color: 'navy', title: 'I use a wheelchair', note: 'Step-free routes that also avoid barriers a wheelchair can’t pass.',
      icon: '<circle cx="10" cy="4.5" r="1.7" fill="currentColor" stroke="none" /><path d="M10 8v6h5.5l2.5 5M10 10.8h4.5M7.3 12.2a5 5 0 1 0 5.9 7" />' },
    { key: 'stepFree', color: 'sun', title: 'I can’t take stairs or escalators', note: 'For example with a pushchair, a walking aid or heavy luggage.',
      icon: '<path d="M3 18.5h18V9.5z" />' },
    { key: 'fewerStairs', color: 'tang', title: 'Stairs are hard for me', note: 'Takes a lift or ramp when the detour is small.',
      icon: '<path d="M4 20h5v-5h5v-5h5V5" />' },
    { key: 'noEscalators', color: 'rose', title: 'I avoid escalators', note: '',
      icon: '<path d="M3 15.5h4.5L15 7h6M3 20h6.5L17 11.5h4" />' },
    { key: 'lowVision', color: 'rose', title: 'I’m blind or have low vision', note: 'Shows events and groups for you. Doesn’t change routes yet.',
      icon: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="3" />' },
  ];
  // A stricter need includes the milder ones (settings.js, effective()): those show as on and can't be switched off
  const impliedBy: Partial<Record<NeedKey, (p: Settings) => boolean>> = {
    stepFree: (p) => p.wheelchair,
    fewerStairs: (p) => p.stepFree,
    noEscalators: (p) => p.stepFree,
  };

  // ---------- The demo: the one seam to the showcase ----------
  // STATUS: the introduction is complete, the demo walk is NOT complete yet (docs/onboarding.md). What plays is the
  // 3D station view opened on this walk in first person, as station3d.js draws and moves it today; the walk itself
  // is still being worked on. Nothing else in this file depends on what the demo is.
  // The viewer walks by itself (`play: true`) and says when it has arrived ('arrived'). A viewer without that
  // (Station3D.play missing) gets its own "Walk along the route" slider moved instead.
  const DEMO_WALK = { key: 'bern', from: { stop: { uic: '8579896', ref: 'B' } }, to: { stop: { uic: '8579896', ref: 'C' } }, title: 'Bern, Hirschengraben' };
  const WALK_MPS = 2.2;      // stand-in walk: metres of the route per second (38 m in about 17 s)
  const WALK_DELAY = 1700;   // …and how long after the view opened it sets off (the view first swings down to eye level)

  // Starts the demo inside `host`. `onState` hears 'arrived' (the walk is at its destination; the view stays open),
  // 'error' (it could not be shown; the view says why and offers "Try again") and 'playing' (it runs after all).
  // `over` resolves once the view has gone:
  // 'finished' (after arriving), 'skipped' (before) or 'unavailable'. close() ends it from outside.
  function startDemo(host: HTMLElement, onState: (state: DemoState) => void): Demo {
    // Always window.Station3D as it is now: the viewer may be loaded on first use and replace a stand-in object
    const S = () => window.Station3D;
    if (!S() || !SETTINGS) return { over: Promise.resolve('unavailable'), close() {} };
    let end: (how: DemoEnd) => void, arrived = false, failed = false, ended = false, walker: Walker | null = null;
    const over = new Promise<DemoEnd>((resolve) => { end = resolve; });
    const heard: Heard[] = [];
    const hear = <K extends keyof Station3DEventMap>(name: K, fn: (detail: Station3DEventMap[K]) => void) => { heard.push([name, fn]); S().on(name, fn); };
    const deaf = () => { for (const [name, fn] of heard.splice(0)) S().off(name, fn as (detail: unknown) => void); };
    const finish = () => {
      if (ended) return;
      ended = true;
      deaf();
      if (walker) walker.stop();
      if (S().isOpen()) S().close();
      end(failed ? 'unavailable' : arrived ? 'finished' : 'skipped');
    };
    const arrive = () => {
      if (arrived || ended) return;
      arrived = true;
      onState('arrived');
    };
    hear('arrived', arrive);                                                     // once the viewer walks by itself
    hear('step', (e) => { if (e && e.step && e.step.kind === 'arrive') arrive(); }); // Next, up to the last step
    hear('error', () => { failed = true; onState('error'); });
    hear('close', finish);                                                       // the view's own ✕, Done or the back gesture
    hear('open', () => {                                                         // also after the view's "Try again"
      if (failed) { failed = false; onState('playing'); }
      if (walker) walker.stop();
      walker = typeof S().play !== 'function' && !arrived ? standInWalk(host, arrive) : null;
    });
    try {
      S().open({ ...DEMO_WALK, pov: true, play: true, prefs: SETTINGS.journey(), mount: host });
    } catch (e) {
      ended = true;
      deaf();
      return { over: Promise.resolve('unavailable'), close() {} };
    }
    return { over, close: finish };
  }

  // Until the viewer walks by itself: move its slider along the route at walking-demo pace. Using the slider or the
  // step buttons yourself stops it; looking around does not.
  function standInWalk(host: HTMLElement, onEnd: () => void): Walker | null {
    const scrub = host.querySelector<HTMLInputElement>('.s3-scrub');
    if (!scrub) return null;
    const max = +scrub.max, step = scrub.step;
    let raf = 0, timer = 0, last = 0, pos = +scrub.value || 0, stopped = false;
    const check = () => { if (+scrub.value >= max - .5) onEnd(); };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      cancelAnimationFrame(raf);
      scrub.step = step;
      sheet.removeEventListener('pointerdown', stop, true);
      sheet.removeEventListener('keydown', stop, true);
    };
    const tick = (now: number) => {
      if (stopped) return;
      if (last) pos = Math.min(max, pos + Math.min(.25, (now - last) / 1000) * WALK_MPS);
      last = now;
      scrub.value = pos as unknown as string;
      scrub.dispatchEvent(new Event('input'));
      if (pos < max) raf = requestAnimationFrame(tick);
    };
    const sheet = scrub.parentElement || host;
    scrub.addEventListener('input', check);
    sheet.addEventListener('pointerdown', stop, true);
    sheet.addEventListener('keydown', stop, true);
    if (!reducedMotion()) {
      scrub.step = 'any';
      timer = setTimeout(() => { raf = requestAnimationFrame(tick); }, WALK_DELAY);
    }
    return { stop: () => { stop(); scrub.removeEventListener('input', check); } };
  }

  // ---------- Page ----------
  const ART = `
    <svg class="ob-art" viewBox="0 0 340 190" aria-hidden="true">
      <path class="a-block" d="M0 0h118l-14 52H0zM150 0h190v38H140zM0 118h62l-20 72H0zM214 142h126v48H200z" />
      <rect class="a-mon" x="176" y="74" width="20" height="20" rx="5" />
      <path class="a-case" d="M62 150C84 112 118 108 150 118s62 4 84-22 26-40 46-48" />
      <path class="a-way" d="M62 150C84 112 118 108 150 118s62 4 84-22 26-40 46-48" />
      <path class="a-chev" d="M100 124l8-5-2 9M160 124l9 2-6 6M222 106l8-5-1 9" />
      <path class="a-you" d="M62 136l11 26-11-6-11 6z" transform="rotate(32 62 150)" />
      <circle class="a-pin" cx="280" cy="48" r="9" />
      <rect class="a-bay" x="14" y="146" width="26" height="26" rx="7" /><text class="a-bay-t" x="27" y="165">B</text>
      <rect class="a-bay" x="296" y="20" width="26" height="26" rx="7" /><text class="a-bay-t" x="309" y="39">C</text>
    </svg>`;

  const speedRows = SPEEDS.map((s, i) => `
        <label class="set-row">
          <span class="set-text"><b id="obSpeedT${i}">${s.label}</b>${s.note ? `<small id="obSpeedD${i}">${s.note}</small>` : ''}</span>
          <span class="ob-kmh" id="obSpeedK${i}">${s.kmh} km/h</span>
          <input class="ob-pick" type="radio" name="obSpeed" value="${s.kmh}" aria-labelledby="obSpeedT${i}" aria-describedby="obSpeedK${i}${s.note ? ` obSpeedD${i}` : ''}" />
        </label>`).join('');

  const needRows = NEEDS.map((n) => `
        <label class="set-row">
          <span class="set-ic" style="--c:var(--${n.color})${n.color === 'sun' ? ';--f:#344D77' : ''}" aria-hidden="true"><svg viewBox="0 0 24 24">${n.icon}</svg></span>
          <span class="set-text"><b id="obNeedT-${n.key}">${n.title}</b>${n.note ? `<small id="obNeedD-${n.key}">${n.note}</small>` : ''}</span>
          <input class="switch" type="checkbox" role="switch" data-need="${n.key}" aria-labelledby="obNeedT-${n.key}"${n.note ? ` aria-describedby="obNeedD-${n.key}"` : ''} />
        </label>`).join('');

  const MARKUP = `
    <div class="ob-page ob-welcome" data-page="welcome" hidden>
      <div class="ob-scroll"><div class="ob-inner">
        ${ART}
        <h1 id="obT-welcome" tabindex="-1">Want to see what the app can do for you?</h1>
        <p class="ob-lead">Walk from one tram stop to the next in Bern, guided by the app. About 20 seconds.</p>
      </div></div>
      <div class="ob-actions">
        <button class="ob-btn primary" type="button" data-go="demo">Yes, show me</button>
        <button class="ob-btn quiet" type="button" data-go="speed">Skip demo</button>
      </div>
    </div>

    <div class="ob-demo" data-page="demo" hidden>
      <h1 class="ob-sr" id="obT-demo" tabindex="-1">The demo: a walk across Hirschengraben</h1>
      <div id="obDemoHost"></div>
      <div class="ob-actions">
        <button class="ob-btn soft" id="obSkip" type="button">Skip the demo</button>
      </div>
      <p class="ob-sr" id="obDemoSay" role="status"></p>
    </div>

    <div class="ob-page" data-page="speed" hidden>
      <div class="ob-scroll"><div class="ob-inner">
        <p class="ob-step">Question 1 of 2</p>
        <h1 id="obT-speed" tabindex="-1">How fast do you walk?</h1>
        <p class="ob-lead">Used for every walk. Not sure? Leave it on Normal.</p>
        <div class="set-group" role="radiogroup" aria-labelledby="obT-speed">${speedRows}
        </div>
        <div class="set-group" id="obAutoGroup" hidden>
          <label class="set-row">
            <span class="set-text"><b id="obAutoT">Adjust to how I walk</b><small id="obAutoD">Measures your pace and sets the speed for you. Stays on this device.</small></span>
            <input class="switch" type="checkbox" role="switch" id="obAuto" aria-labelledby="obAutoT" aria-describedby="obAutoD" />
          </label>
        </div>
      </div></div>
      <div class="ob-actions">
        <button class="ob-btn primary" type="button" data-go="access">Continue</button>
        <button class="ob-btn quiet" type="button" data-go="welcome">Back</button>
      </div>
    </div>

    <div class="ob-page" data-page="access" hidden>
      <div class="ob-scroll"><div class="ob-inner">
        <p class="ob-step">Question 2 of 2</p>
        <h1 id="obT-access" tabindex="-1">Is there anything the app should plan around?</h1>
        <p class="ob-lead">Switch on what applies to you.</p>
        <div class="set-group" role="group" aria-labelledby="obT-access">${needRows}
        </div>
        <p class="set-foot">Stays on this device. Change it anytime in Settings.</p>
        <p class="set-foot" id="obGeoNote" hidden>Next, your browser asks for your location, to show where you are and start journeys there.</p>
      </div></div>
      <div class="ob-actions">
        <button class="ob-btn primary" type="button" data-go="done">Open the map</button>
        <button class="ob-btn quiet" type="button" data-go="speed">Back</button>
      </div>
    </div>`;

  let el: HTMLElement | null = null;        // the layer, built on first use
  let isOpen = false;
  let demo: Demo | null = null;      // the running demo
  let madeInert: HTMLElement[] = [];
  const themeMeta = document.querySelector('meta[name="theme-color"]');
  const $ = <E extends HTMLElement = HTMLElement>(sel: string) => el!.querySelector<E>(sel)!;

  let cssPromise: Promise<unknown> | null = null;
  function loadCss() {
    if (!cssPromise) cssPromise = new Promise((resolve, reject) => {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = BASE + 'onboarding.css';
      link.onload = resolve;
      link.onerror = reject;
      document.head.appendChild(link);
    });
    return cssPromise;
  }

  function build() {
    el = document.createElement('section');
    el.className = 'ob';
    el.id = 'onboarding';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.hidden = true;
    el.innerHTML = MARKUP;
    document.body.appendChild(el);

    el.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-go]');
      if (b) go(b.dataset.go as PageName | 'done');
      else if ((e.target as HTMLElement).closest('#obSkip') && demo) demo.close();
    });
    el.addEventListener('change', (e) => {
      const t = e.target as HTMLInputElement;
      if (t.name === 'obSpeed') SETTINGS.set({ walkKmh: +t.value });
      else if (t.dataset.need) SETTINGS.set({ [t.dataset.need]: t.checked });
      else if (t.id === 'obAuto') SETTINGS.set({ autoSpeed: t.checked });
    });
  }

  // The answers as the settings have them now
  function render() {
    if (!el || !SETTINGS) return;
    const p = SETTINGS.prefs();
    let best = 0;
    SPEEDS.forEach((s, i) => { if (Math.abs(s.kmh - p.walkKmh) < Math.abs(SPEEDS[best].kmh - p.walkKmh)) best = i; });
    el.querySelectorAll<HTMLInputElement>('input[name="obSpeed"]').forEach((input, i) => { input.checked = i === best; });
    el.querySelectorAll<HTMLInputElement>('input[data-need]').forEach((input) => {
      const k = input.dataset.need as NeedKey;
      input.checked = !!p[k];
      input.disabled = impliedBy[k] ? !!impliedBy[k](p) : false;
    });
    // "Adjust to how I walk" exists once the walking-speed-auto branch is in
    const auto = 'autoSpeed' in p;
    $('#obAutoGroup').hidden = !auto;
    if (auto) $<HTMLInputElement>('#obAuto').checked = !!p.autoSpeed;
  }

  function setInert() {
    for (const n of document.body.children as HTMLCollectionOf<HTMLElement>) {
      if (n === el || n.inert || /^(SCRIPT|STYLE|LINK)$/.test(n.tagName)) continue;
      n.inert = true;
      madeInert.push(n);
    }
  }
  const paintChrome = () => { if (themeMeta && isOpen) themeMeta.setAttribute('content', getComputedStyle(el!).getPropertyValue('--sp-bg').trim()); };
  // The app is still starting behind a first visit: what it adds or sets after us is covered too
  const again = () => { if (isOpen) { setInert(); paintChrome(); } };
  document.addEventListener('DOMContentLoaded', again);
  window.addEventListener('load', again);

  function page(name: PageName) {
    for (const p of el!.querySelectorAll<HTMLElement>('[data-page]')) p.hidden = p.dataset.page !== name;
    el!.setAttribute('aria-labelledby', 'obT-' + name);
    const sc = el!.querySelector(`[data-page="${name}"] .ob-scroll`);
    if (sc) sc.scrollTop = 0;
    const h = document.getElementById('obT-' + name);
    if (h) h.focus({ preventScroll: true });
  }

  function go(name: PageName | 'done') {
    if (name === 'demo') return runDemo();
    if (name === 'done') return finish();
    render();
    page(name);
  }

  function runDemo() {
    const skip = $('#obSkip'), say = $('#obDemoSay');
    const waiting = () => {
      skip.textContent = 'Skip the demo';
      skip.className = 'ob-btn soft';
      say.textContent = '';
    };
    waiting();
    page('demo');
    const mine = demo = startDemo($('#obDemoHost'), (state) => {
      if (state === 'playing') return waiting();
      skip.textContent = 'Continue';
      skip.className = 'ob-btn primary go';
      say.textContent = state === 'error' ? 'The demo can’t be shown here. Continue to the questions.' : 'You have arrived. Continue to the questions.';
      if (state === 'arrived') skip.focus({ preventScroll: true });
    });
    mine.over.then(() => {
      if (demo !== mine) return;
      demo = null;
      if (isOpen) go('speed');
    });
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    if (!html.dataset.onboarding) html.dataset.onboarding = 'again'; // the cover (index.html)
    loadCss().then(() => {
      if (!el) build();
      el!.classList.remove('leaving');
      el!.hidden = false;
      setInert();
      paintChrome();
      // Say on the last page that the location prompt comes next, if it does
      const note = $('#obGeoNote');
      note.hidden = true;
      const geo = window.EARLY_GEO;
      if (geo && !geo.started && window.isSecureContext && navigator.geolocation) {
        if (navigator.permissions && navigator.permissions.query) navigator.permissions.query({ name: 'geolocation' }).then((s) => { note.hidden = s.state !== 'prompt'; }, () => { note.hidden = false; });
        else note.hidden = false;
      }
      go('welcome');
    }).catch(abort);
  }

  // Give the app back: the cover and the layer go, the location prompt comes
  function release() {
    isOpen = false;
    delete html.dataset.onboarding;
    madeInert.forEach((n) => { n.inert = false; });
    madeInert = [];
    if (themeMeta) themeMeta.setAttribute('content', getComputedStyle(html).getPropertyValue('--page-bg').trim());
    if (window.EARLY_GEO && window.EARLY_GEO.start) window.EARLY_GEO.start();
  }

  function finish() {
    try { localStorage.setItem(KEY, 'done'); } catch (e) {}
    // ?intro has done its work: a reload shows the app
    try {
      const u = new URL(location.href);
      if (u.searchParams.has('intro')) { u.searchParams.delete('intro'); history.replaceState(history.state, '', u); }
    } catch (e) {}
    if (demo) { const d = demo; demo = null; d.close(); }
    const layer = el!;
    layer.classList.add('leaving');
    setTimeout(() => { if (!isOpen) layer.hidden = true; }, reducedMotion() ? 0 : 380);
    release();
    const menu = document.getElementById('menuBtn');
    if (menu) menu.focus({ preventScroll: true });
  }

  // Something of ours failed: the app must still start
  function abort() {
    if (el) el.hidden = true;
    release();
  }

  // ---------- Settings › "Show the introduction again" ----------
  let replay = false;
  const reset = document.getElementById('settingsReset');
  if (reset && SETTINGS) {
    const b = document.createElement('button');
    b.className = 'set-reset';
    b.id = 'settingsIntro';
    b.type = 'button';
    b.textContent = 'Show the introduction again';
    reset.classList.add('set-line');
    reset.before(b);
    b.addEventListener('click', () => { replay = true; SETTINGS.close(); });
    SETTINGS.onClose(() => { if (replay) { replay = false; open(); } });
  }
  if (SETTINGS) SETTINGS.onChange(render);

  window.ONBOARDING = { open, isOpen: () => isOpen };

  if (html.dataset.onboarding) {
    if (SETTINGS) open();
    else abort();
  }
})();
