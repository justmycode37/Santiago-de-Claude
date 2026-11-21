// Screen readers (VoiceOver, TalkBack): the few things the app has to do itself.
//
// A screen reader reads what its user moves to. The app only speaks up through a live region (say), for things
// that happen by themselves and can't be seen: a journey was found, the platform changed, get off at the next stop.
// One sentence per real event, never a countdown. Everything said is also on the page, to be read again.
//
// Read aloud (Settings) is for people who do not use a screen reader: the same sentences through this phone's own
// voice. It is off unless switched on, because it talks over a screen reader, ignores its voice and speed, and
// never reaches a braille display. A web page can't tell whether a screen reader is running.
(function (root: typeof globalThis) {
  const doc: Document | undefined = root.document;

  // ---- Which language a piece of text is in, so the screen reader picks the right voice (lang="de") ----
  // Counted on the commonest words of each language; only an answer that is clear is given, the rest stays
  // in the page's language.
  type TextLang = 'de' | 'fr' | 'it' | 'en';
  const WORDS: Record<TextLang, string> = {
    de: 'der die das und für mit von im zum zur ein eine einen nicht auf ist den dem des wir sie oder bei auch aus nach über unter ohne wie wird sind zu vom am beim ab bis um',
    fr: 'le la les des et pour avec dans une du au aux est sur vous nous ce cette qui que ou par chez sans sont en de un',
    it: 'il lo gli della dello delle di e per con nel nella una del alla che sono non da al dei si è un',
    en: 'the and for with of to in is are you your at from on by this that who can or an be it as we our all',
  };
  const LANGS = Object.keys(WORDS) as TextLang[];
  const WORD_SETS = Object.fromEntries(LANGS.map((k) => [k, new Set(WORDS[k].split(' '))])) as Record<TextLang, Set<string>>;
  const DE_END = /(ung|ungen|keit|schaft|dienst|kurs|kurse|treff|gruppe|gruppen|stunde|abend|beratung)$/;
  function textLang(text: string | null | undefined): TextLang | '' {
    const words = String(text || '').toLowerCase().split(/[^a-zà-öø-ÿ]+/).filter(Boolean);
    if (!words.length) return '';
    const score: Record<TextLang, number> = { de: 0, fr: 0, it: 0, en: 0 };
    for (const w of words) {
      for (const k of LANGS) if (WORD_SETS[k].has(w)) score[k]++;
      if (/[äöüß]/.test(w) || (w.length > 5 && DE_END.test(w))) score.de += 1;
      if (/[éèêçœ]/.test(w)) score.fr += 0.5;
      if (/[òìù]/.test(w)) score.it += 0.5;
    }
    const ranked = LANGS.map((k) => [k, score[k]] as const).sort((a, b) => b[1] - a[1]);
    const [best, n] = ranked[0], second = ranked[1][1];
    // one clear hit is enough for a short title ("Chor für Menschen"), a longer text needs a real lead
    if (n < 1 || n < second * 1.5 + (words.length > 6 ? 1 : 0.5)) return '';
    return best;
  }

  // ---- The language spoken where a place is: station, stop and street names are in it ----
  // The French-speaking west as a rough polygon along the language border (Jura, Biel/Bienne, Murten, Fribourg,
  // Saanen, Sierre); Ticino and the Italian-speaking valleys of Graubünden as boxes. Elsewhere German, which is
  // also the nearest voice for Romansh names. Approximate by design: a village right on the border may be wrong.
  const FRENCH: [number, number][] = [[7.33, 47.5], [7.57, 47.37], [7.455, 47.27], [7.36, 47.2], [7.215, 47.15], [7.115, 47.075], [7.085, 47.045],
    [7.04, 47.0], [7.08, 46.95], [7.15, 46.905], [7.175, 46.85], [7.19, 46.8], [7.195, 46.75], [7.22, 46.66], [7.24, 46.6],
    [7.235, 46.49], [7.21, 46.38], [7.55, 46.38], [7.555, 46.33], [7.66, 46.2], [7.7, 45.8], [5.8, 45.8], [5.8, 47.5]];
  function inside(poly: [number, number][], [x, y]: readonly [number, number]) {
    let hit = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i], [xj, yj] = poly[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
    return hit;
  }
  function placeLang(ll: readonly [number, number] | null | undefined): 'de' | 'fr' | 'it' | '' {
    if (!ll || !Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return '';
    const [lon, lat] = ll;
    if (lon < 5.9 || lon > 10.6 || lat < 45.7 || lat > 47.9) return '';
    if ((lat < 46.55 && lon > 8.38 && lon < 9.3) || (lat < 46.45 && lon >= 9.0 && lon < 9.75) || (lat < 46.43 && lon > 9.95)) return 'it';
    if (inside(FRENCH, ll)) return 'fr';
    return 'de';
  }
  // The app's own language: English, or the one chosen under Settings › Language (translate.js)
  const appLang = () => (root.APP_LANG && root.APP_LANG.code) || 'en';
  const pageLang = () => (page.documentElement.lang || 'en').split('-')[0].toLowerCase();
  // Mark an element's text as being in a language (nothing for the page's own, or when not known)
  function setLang<T extends HTMLElement>(el: T, lang: string): T {
    if (!el) return el;
    if (lang && lang !== pageLang()) el.lang = lang;
    else el.removeAttribute('lang');
    return el;
  }
  // …for a text whose language was read from its words (textLang): an event's title or description. Only while
  // the app is in English: in another app language these texts are translated, and are then in that language.
  const inLang = <T extends HTMLElement>(el: T, lang: string): T => setLang(el, appLang() === 'en' ? lang : '');

  // ---- Units in words, for sentences that are spoken ("12 min" is read as "12 min", "750 m" as "750 em") ----
  const minutes = (n: number) => `${n} ${n === 1 ? 'minute' : 'minutes'}`;
  // "750 m" → "750 metres", "1.2 km" → "1.2 kilometres"
  const metres = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} kilometres` : `${Math.max(10, Math.round(m / 10) * 10)} metres`);

  if (!doc) { // tests (node): the pure helpers only
    if (typeof module !== 'undefined' && module.exports) module.exports = { textLang, placeLang, minutes, metres };
    return;
  }
  const page = doc; // (the browser from here on)

  // ---- Settings read from the settings page (settings.js), which loads before this is first used ----
  const prefs = (): Partial<Settings> => (root.SETTINGS && root.SETTINGS.prefs ? root.SETTINGS.prefs() : {});

  // ---- Read aloud: this phone's own voice ----
  const synth: SpeechSynthesis | null = root.speechSynthesis || null;
  let unlocked = false;
  // iOS only lets a page speak once it has spoken inside a tap. With read aloud on, the first tap anywhere
  // says nothing, quietly, so that later sentences (a journey found, the next stop) may be spoken.
  function unlock(e?: Event | true) {
    // (called with true from Settings, in the tap that switches read aloud on)
    if (unlocked || !synth || !(e === true || prefs().readAloud)) return;
    unlocked = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      synth.speak(u);
    } catch (e) { /* no voice on this device */ }
  }
  page.addEventListener('pointerdown', unlock, { capture: true, passive: true });
  page.addEventListener('keydown', unlock, { capture: true, passive: true });
  function speak(text: string, { urgent = false, force = false }: { urgent?: boolean; force?: boolean } = {}) {
    if (!synth || !text || !(force || prefs().readAloud)) return false;
    try {
      if (urgent) synth.cancel(); // what matters now replaces what was being said
      const u = new SpeechSynthesisUtterance(text);
      u.lang = page.documentElement.lang || 'en';
      synth.speak(u);
      unlocked = true;
      return true;
    } catch (e) { return false; }
  }
  const hush = () => { try { if (synth) synth.cancel(); } catch (e) { /* nothing was being said */ } };

  // ---- Vibration (Android; iOS Safari has none): a short buzz for a new step, two for something urgent ----
  function buzz(urgent?: boolean) {
    if (!prefs().vibrate || !root.navigator.vibrate) return;
    try { root.navigator.vibrate(urgent ? [220, 120, 220] : 90); } catch (e) { /* not allowed right now */ }
  }

  // ---- Live regions: one polite, one that interrupts. They are in the page from the start (index.html):
  //      a region made at the moment it is filled is not announced. The same sentence twice in a row is only
  //      read again if the text really changes, hence the empty moment in between. ----
  const timers = new WeakMap<HTMLElement, number>();
  function put(el: HTMLElement | null, text: string) {
    if (!el) return;
    clearTimeout(timers.get(el));
    el.textContent = '';
    timers.set(el, root.setTimeout(() => { el.textContent = text; }, 60));
  }
  // say('Platform changed…', { urgent: true }). region: a live region inside an open dialog (a screen reader
  // inside a modal dialog does not hear the page behind it). quiet: no voice and no buzz, the live region only.
  // The sentences are written in English. In another app language (Settings › Language) a sentence is translated
  // first, and put into the region already translated (the regions are translate="no"): put in English and
  // translated afterwards, it would be read out twice. If the translator does not answer in time, it is said in
  // English rather than late.
  const turn = new WeakMap<HTMLElement, number>(); // region → the number of the sentence last asked for: only the latest is said
  function say(text: string, { urgent = false, region = null, quiet = false }: A11ySayOptions = {}) {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text) return;
    const el = region || page.getElementById(urgent ? 'srAlert' : 'srStatus');
    if (!el) return;
    const out = (t: string) => {
      put(el, t);
      if (quiet) return;
      speak(t, { urgent });
      buzz(urgent);
    };
    const L = root.APP_LANG;
    if (!L || !L.translate || appLang() === 'en') { out(text); return; }
    const n = (turn.get(el) || 0) + 1;
    turn.set(el, n);
    let done = false;
    const once = (t: string) => { if (done || turn.get(el) !== n) return; done = true; out(t); };
    setTimeout(() => once(text), 1500);
    Promise.resolve(L.translate(text)).then((t) => once(t || text), () => once(text));
  }

  // ---- A dialog over the page: everything behind it is out of reach while it is open ----
  // openDialog(el, { focus, returnTo, keep }): hides the rest from screen readers and the keyboard and moves focus
  // in. returnTo: the element (or a function giving it) that opened the dialog; without one, whatever had focus.
  // keep: elements that stay usable (the dimmed backdrop that closes it on a tap).
  // closeDialog(el, { fallback, restore }): gives the rest back and returns focus to where it came from.
  type Opener = HTMLElement | null | (() => HTMLElement | null);
  const KEEP = (el: Element) => el.tagName === 'SCRIPT' || el.classList.contains('sr-live') || el.id === 'toast';
  const openDialogs = new Map<HTMLElement, { made: HTMLElement[]; returnTo: Opener }>();
  const usable = (el: HTMLElement | null): el is HTMLElement => !!el && el !== page.body && page.contains(el) && !el.closest('[inert]') && el.getClientRects().length > 0;
  function openDialog(el: HTMLElement, { focus = null, returnTo = null, keep = [] }: A11yDialogOptions = {}) {
    if (openDialogs.has(el)) return;
    const made = ([...page.body.children] as HTMLElement[]).filter((x) => x !== el && !KEEP(x) && !keep.includes(x) && !x.inert);
    made.forEach((x) => { x.inert = true; });
    openDialogs.set(el, { made, returnTo: returnTo || page.activeElement as HTMLElement | null });
    el.inert = false;
    const target = focus || el;
    if (target === el && !el.hasAttribute('tabindex')) el.tabIndex = -1;
    try { target.focus({ preventScroll: true }); } catch (e) { /* not focusable yet */ }
  }
  function closeDialog(el: HTMLElement, { fallback = null, restore = true }: { fallback?: HTMLElement | null; restore?: boolean } = {}) {
    const d = openDialogs.get(el);
    if (!d) return;
    openDialogs.delete(el);
    d.made.forEach((x) => { x.inert = false; });
    if (!restore) return;
    let back: HTMLElement | null = null;
    try { back = typeof d.returnTo === 'function' ? d.returnTo() : d.returnTo; } catch (e) { back = null; }
    if (!usable(back)) back = usable(fallback) ? fallback : null;
    if (back) { try { back.focus({ preventScroll: true }); } catch (e) { /* gone */ } }
  }

  // Text for screen readers only, next to something drawn for the eye: sr('4 minutes late')
  function sr(text: string) {
    const e = page.createElement('span');
    e.className = 'sr-only';
    e.textContent = text;
    return e;
  }
  // …and the drawn version hidden from them: seen('+4 min')
  function seen(node: string | HTMLElement) {
    const e = typeof node === 'string' ? page.createElement('span') : node;
    if (typeof node === 'string') e.textContent = node;
    e.setAttribute('aria-hidden', 'true');
    return e;
  }

  // ---- Keep the screen on while the app talks you through a trip (a browser stops a page whose screen is off) ----
  let lock: WakeLockSentinel | null = null, wantLock = false;
  async function acquire() {
    if (!wantLock || lock || !root.navigator.wakeLock || page.hidden) return;
    try {
      lock = await root.navigator.wakeLock.request('screen');
      lock.addEventListener('release', () => { lock = null; });
      if (!wantLock) { lock.release().catch(() => {}); lock = null; }
    } catch (e) { lock = null; /* battery saver, or not allowed: guidance still works while the screen is on */ }
  }
  function keepAwake(on: boolean) {
    wantLock = !!on;
    if (on) acquire();
    else if (lock) { lock.release().catch(() => {}); lock = null; }
  }
  page.addEventListener('visibilitychange', () => { if (!page.hidden) acquire(); });

  root.A11Y = { say, speak, hush, buzz, unlock: () => unlock(true), textLang, placeLang, setLang, inLang, minutes, metres, openDialog, closeDialog, sr, seen, keepAwake,
    canSpeak: !!synth, canVibrate: !!root.navigator.vibrate, canKeepAwake: !!root.navigator.wakeLock };
})(typeof window !== 'undefined' ? window : globalThis);
