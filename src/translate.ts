// App language: the app in any of the languages Google Translate offers (Settings → Language).
// The app is written in English. For another language, this script translates the text on the screen as it
// appears (a MutationObserver sees every change) through Google Translate, and keeps the answers on this device
// so each piece of text is fetched only once. Numbers stay out of the text it sends ("{1} min"), so a countdown
// is one translation, not one per second. Names of stops, lines, platforms and places stay as they are written
// on the signs. The choice is saved on this device only; "Reset all settings" leaves it alone.
(function () {
  const KEY = 'app-language';
  const CACHE_KEY = 'app-translations';
  const CACHE_MAX = 4000; // translations kept on the device, newest first
  const ENDPOINT = 'https://translate.googleapis.com/translate_a/t?client=gtx&sl=en&tl=';
  // Google Translate's target languages (translate.googleapis.com/translate_a/l), code → English name
  const LANGS: Record<string, string> = {
    ab: 'Abkhaz', ace: 'Acehnese', ach: 'Acholi', aa: 'Afar', af: 'Afrikaans', sq: 'Albanian', alz: 'Alur',
    am: 'Amharic', ar: 'Arabic', hy: 'Armenian', as: 'Assamese', av: 'Avar', awa: 'Awadhi', ay: 'Aymara',
    az: 'Azerbaijani', ban: 'Balinese', bal: 'Baluchi', bm: 'Bambara', bci: 'Baoulé', ba: 'Bashkir', eu: 'Basque',
    btx: 'Batak Karo', bts: 'Batak Simalungun', bbc: 'Batak Toba', be: 'Belarusian', bem: 'Bemba', bn: 'Bengali',
    bew: 'Betawi', bho: 'Bhojpuri', bik: 'Bikol', bs: 'Bosnian', br: 'Breton', bg: 'Bulgarian', bua: 'Buryat',
    yue: 'Cantonese', ca: 'Catalan', ceb: 'Cebuano', ch: 'Chamorro', ce: 'Chechen', ny: 'Chichewa',
    'zh-CN': 'Chinese (Simplified)', 'zh-TW': 'Chinese (Traditional)', chk: 'Chuukese', cv: 'Chuvash', co: 'Corsican',
    crh: 'Crimean Tatar (Cyrillic)', 'crh-Latn': 'Crimean Tatar (Latin)', hr: 'Croatian', cs: 'Czech', da: 'Danish',
    'fa-AF': 'Dari', dv: 'Dhivehi', din: 'Dinka', doi: 'Dogri', dov: 'Dombe', nl: 'Dutch', dyu: 'Dyula',
    dz: 'Dzongkha', en: 'English', eo: 'Esperanto', et: 'Estonian', ee: 'Ewe', fo: 'Faroese', fj: 'Fijian',
    tl: 'Filipino', fi: 'Finnish', fon: 'Fon', fr: 'French', 'fr-CA': 'French (Canada)', fy: 'Frisian',
    fur: 'Friulian', ff: 'Fulani', gaa: 'Ga', gl: 'Galician', ka: 'Georgian', de: 'German', el: 'Greek',
    gn: 'Guarani', gu: 'Gujarati', ht: 'Haitian Creole', cnh: 'Hakha Chin', ha: 'Hausa', haw: 'Hawaiian',
    iw: 'Hebrew', hil: 'Hiligaynon', hi: 'Hindi', hmn: 'Hmong', hu: 'Hungarian', hrx: 'Hunsrik', iba: 'Iban',
    is: 'Icelandic', ig: 'Igbo', ilo: 'Ilocano', id: 'Indonesian', 'iu-Latn': 'Inuktut (Latin)',
    iu: 'Inuktut (Syllabics)', ga: 'Irish', it: 'Italian', jam: 'Jamaican Patois', ja: 'Japanese', jw: 'Javanese',
    kac: 'Jingpo', kl: 'Kalaallisut', kn: 'Kannada', kr: 'Kanuri', pam: 'Kapampangan', kk: 'Kazakh', kha: 'Khasi',
    km: 'Khmer', cgg: 'Kiga', kg: 'Kikongo', rw: 'Kinyarwanda', ktu: 'Kituba', trp: 'Kokborok', kv: 'Komi',
    gom: 'Konkani', ko: 'Korean', kri: 'Krio', ku: 'Kurdish (Kurmanji)', ckb: 'Kurdish (Sorani)', ky: 'Kyrgyz',
    lo: 'Lao', ltg: 'Latgalian', la: 'Latin', lv: 'Latvian', lij: 'Ligurian', li: 'Limburgish', ln: 'Lingala',
    lt: 'Lithuanian', lmo: 'Lombard', lg: 'Luganda', luo: 'Luo', lb: 'Luxembourgish', mk: 'Macedonian',
    mad: 'Madurese', mai: 'Maithili', mak: 'Makassar', mg: 'Malagasy', ms: 'Malay', 'ms-Arab': 'Malay (Jawi)',
    ml: 'Malayalam', mt: 'Maltese', mam: 'Mam', gv: 'Manx', mi: 'Maori', mr: 'Marathi', mh: 'Marshallese',
    mwr: 'Marwadi', mfe: 'Mauritian Creole', chm: 'Meadow Mari', 'mni-Mtei': 'Meiteilon (Manipuri)', min: 'Minang',
    lus: 'Mizo', mn: 'Mongolian', my: 'Myanmar (Burmese)', nhe: 'Nahuatl (Eastern Huasteca)', 'ndc-ZW': 'Ndau',
    nr: 'Ndebele (South)', new: 'Nepalbhasa (Newari)', ne: 'Nepali', 'bm-Nkoo': 'NKo', no: 'Norwegian', nus: 'Nuer',
    oc: 'Occitan', or: 'Odia (Oriya)', om: 'Oromo', os: 'Ossetian', pag: 'Pangasinan', pap: 'Papiamento',
    ps: 'Pashto', fa: 'Persian', pl: 'Polish', pt: 'Portuguese (Brazil)', 'pt-PT': 'Portuguese (Portugal)',
    pa: 'Punjabi (Gurmukhi)', 'pa-Arab': 'Punjabi (Shahmukhi)', qu: 'Quechua', kek: 'Qʼeqchiʼ', rom: 'Romani',
    ro: 'Romanian', rn: 'Rundi', ru: 'Russian', se: 'Sami (North)', sm: 'Samoan', sg: 'Sango', sa: 'Sanskrit',
    'sat-Latn': 'Santali (Latin)', sat: 'Santali (Ol Chiki)', gd: 'Scots Gaelic', nso: 'Sepedi', sr: 'Serbian',
    st: 'Sesotho', crs: 'Seychellois Creole', shn: 'Shan', sn: 'Shona', scn: 'Sicilian', szl: 'Silesian',
    sd: 'Sindhi', si: 'Sinhala', sk: 'Slovak', sl: 'Slovenian', so: 'Somali', es: 'Spanish', su: 'Sundanese',
    sus: 'Susu', sw: 'Swahili', ss: 'Swati', sv: 'Swedish', ty: 'Tahitian', tg: 'Tajik', 'ber-Latn': 'Tamazight',
    ber: 'Tamazight (Tifinagh)', ta: 'Tamil', tt: 'Tatar', te: 'Telugu', tet: 'Tetum', th: 'Thai', bo: 'Tibetan',
    ti: 'Tigrinya', tiv: 'Tiv', tpi: 'Tok Pisin', to: 'Tongan', lua: 'Tshiluba', ts: 'Tsonga', tn: 'Tswana',
    tcy: 'Tulu', tum: 'Tumbuka', tr: 'Turkish', tk: 'Turkmen', tyv: 'Tuvan', ak: 'Twi', udm: 'Udmurt',
    uk: 'Ukrainian', ur: 'Urdu', ug: 'Uyghur', uz: 'Uzbek', ve: 'Venda', vec: 'Venetian', vi: 'Vietnamese',
    war: 'Waray', cy: 'Welsh', wo: 'Wolof', xh: 'Xhosa', sah: 'Yakut', yi: 'Yiddish', yo: 'Yoruba',
    yua: 'Yucatec Maya', zap: 'Zapotec', zu: 'Zulu',  };

  // Google's codes that differ from the standard language tags (for lang="…" and the browser's language names)
  const TAGS: Record<string, string> = { iw: 'he', jw: 'jv', 'zh-CN': 'zh-Hans', 'zh-TW': 'zh-Hant', pt: 'pt-BR', 'ndc-ZW': 'ndc' };
  const tagOf = (code: string) => TAGS[code] || code;
  // Written right to left. The layout stays as it is; each paragraph takes its own direction (CSS: .tr-rtl).
  const RTL = ['ar', 'iw', 'fa', 'fa-AF', 'ur', 'ps', 'sd', 'ug', 'yi', 'dv', 'ckb', 'pa-Arab', 'ms-Arab', 'bal', 'bm-Nkoo'];
  // A browser language ("de-CH", "zh-Hant-TW", "he") → Google's code, or null
  function fromTag(t: string | null) {
    if (!t) return null;
    if (LANGS[t]) return t;
    const base = t.split('-')[0].toLowerCase();
    if (base === 'zh') return /hant|-tw|-hk|-mo/i.test(t) ? 'zh-TW' : 'zh-CN';
    const alias = ({ he: 'iw', jv: 'jw', nb: 'no', nn: 'no', fil: 'tl', mni: 'mni-Mtei' } as Record<string, string | undefined>)[base];
    return alias || (LANGS[base] ? base : null);
  }

  let lang = 'en';
  try { lang = fromTag(localStorage.getItem(KEY)) || 'en'; } catch { /* English for this visit */ }

  // ---- Translating the page ----
  // Never translated: code, drawings, what you type, and anything marked translate="no"
  const SKIP = 'script, style, noscript, template, svg, canvas, textarea, code, [translate="no"], .notranslate';
  // Names as written on the signs: search results, stops on the timeline and in departures, lines, platforms
  const NAMES = '.results .title, .results .subtitle, .place-pin > span, .pf-name > b, .pf-to, .pf-dot, .tl-name, '
    + '.tl-name > strong, .sheet-title h1, .badge, .j-badge, .plat > b, .route-veh';
  const NAME_LABELS = '.place-pin'; // its aria-label is a place name and address
  const ATTRS = ['placeholder', 'aria-label', 'aria-valuetext', 'title', 'alt'];
  const NUM = /(?<![\p{L}\d])\d+(?:[.,:'’]\d+)*(?![\p{L}\d])/gu; // "4", "12:40", "4.7", "1'000"; not the 1 of "S1"
  const worth = (s: string) => s.length < 4500 && /\p{L}/u.test(s);
  const skipped = (el: Element | null) => !el || !!el.closest(SKIP);

  /** What a text node or an attribute says in English, what it shows now, and for which language change. */
  interface Shown { src: string; shown: string; gen: number }
  let gen = 0;                 // goes up when the language changes: work for the old one is dropped
  const texts = new WeakMap<Text, Shown>(); // text node → { src: its English, shown: what it shows, gen }
  const attrs = new WeakMap<Element, Record<string, Shown>>(); // element → { attribute: { src, shown, gen } }
  let observer: MutationObserver | null = null;

  function visitText(node: Text) {
    const rec = texts.get(node);
    let src = node.data;
    if (rec && src === rec.shown) {
      if (rec.gen === gen) return; // translated, or on its way
      src = rec.src;               // still in an earlier language: start again from the English
    }
    if (lang === 'en' || !worth(src)) {
      texts.delete(node);
      if (node.data !== src) node.data = src;
      return;
    }
    const r = { src, shown: node.data, gen };
    texts.set(node, r);
    translate(src, (t) => {
      if (texts.get(node) !== r || node.data !== r.shown) return; // the app has changed it since
      r.shown = t;
      if (node.data !== t) node.data = t;
    });
  }

  function visitAttr(el: Element, name: string) {
    const v = el.getAttribute(name);
    let recs = attrs.get(el);
    const rec = recs && recs[name];
    if (v == null) { if (rec) delete recs![name]; return; }
    let src = v;
    if (rec && v === rec.shown) {
      if (rec.gen === gen) return;
      src = rec.src;
    }
    if (lang === 'en' || !worth(src)) {
      if (rec) delete recs![name];
      if (v !== src) el.setAttribute(name, src);
      return;
    }
    if (!recs) attrs.set(el, (recs = {}));
    const r = (recs[name] = { src, shown: v, gen });
    translate(src, (t) => {
      if (recs[name] !== r || el.getAttribute(name) !== r.shown) return;
      r.shown = t;
      if (el.getAttribute(name) !== t) el.setAttribute(name, t);
    });
  }

  function visitEl(el: Element) {
    if (!el.matches(NAME_LABELS)) for (const a of ATTRS) if (el.hasAttribute(a)) visitAttr(el, a);
  }

  // Every text and label in `root` (a node the app has just added or changed)
  function scan(root: Node) {
    if (root.nodeType === Node.TEXT_NODE) {
      const p = root.parentElement;
      if (!skipped(p) && !p!.matches(NAMES)) visitText(root as Text);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE || skipped(root as Element)) return;
    visitEl(root as Element);
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeType === Node.ELEMENT_NODE && (n as Element).matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.nodeType === Node.ELEMENT_NODE) visitEl(n as Element);
      else if (!n.parentElement!.matches(NAMES)) visitText(n as Text);
    }
  }

  // Put the English back everywhere on the page
  function restore() {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n: Node | null = walk.currentNode; n; n = walk.nextNode()) {
      if (n.nodeType === Node.TEXT_NODE) {
        const r = texts.get(n as Text);
        if (r && (n as Text).data === r.shown && (n as Text).data !== r.src) (n as Text).data = r.src;
        continue;
      }
      const recs = attrs.get(n as Element);
      if (recs) for (const a in recs) if ((n as Element).getAttribute(a) === recs[a].shown && recs[a].shown !== recs[a].src) (n as Element).setAttribute(a, recs[a].src);
    }
  }

  function observe() {
    if (observer) return;
    observer = new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'childList') m.addedNodes.forEach(scan);
        else if (m.type === 'characterData') scan(m.target);
        else if (!skipped(m.target as Element) && !(m.target as Element).matches(NAME_LABELS)) visitAttr(m.target as Element, m.attributeName!);
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  // English → `lang`. Numbers become {1}, {2}… so "In 3 min" and "In 4 min" are one translation;
  // when the translation loses one of them, the text is translated as it is.
  function translate(src: string, cb: (t: string) => void) {
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(src)!;
    const nums: string[] = [];
    const masked = core.replace(NUM, (n) => `{${nums.push(n)}}`);
    const done = (t: string) => cb(lead + t + trail);
    ask(masked, (t) => {
      const out = nums.length ? unmask(t, nums) : t;
      if (out != null) done(out);
      else ask(core, done);
    });
  }
  function unmask(t: string, nums: string[]) {
    for (let i = 1; i <= nums.length; i++) if (t.split(`{${i}}`).length !== 2) return null;
    return t.replace(/\{(\d+)\}/g, (m, i) => nums[i - 1] ?? m);
  }

  // ---- Google Translate: texts asked for within 30 ms go in one request; answers are kept on the device ----
  let cache = new Map<string, string>();   // English → translation, in `lang`
  let waiting = new Map<string, ((t: string) => void)[]>(); // English → callbacks, for texts asked for and not answered yet
  let queue: string[] = [];          // English texts not sent yet
  let flushTimer = 0;
  let saveTimer = 0;
  let retryTimer = 0;
  let failed = false;

  function ask(text: string, cb: (t: string) => void) {
    const t = cache.get(text);
    if (t !== undefined) return cb(t);
    const cbs = waiting.get(text);
    if (cbs) return void cbs.push(cb);
    waiting.set(text, [cb]);
    queue.push(text);
    if (!flushTimer) flushTimer = setTimeout(flush, 30);
  }

  function flush() {
    flushTimer = 0;
    const all = queue;
    queue = [];
    let batch: string[] = [], chars = 0;
    for (const text of all) {
      if (batch.length && (batch.length >= 100 || chars + text.length > 4500)) { send(batch); batch = []; chars = 0; }
      batch.push(text);
      chars += text.length;
    }
    if (batch.length) send(batch);
  }

  const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  async function send(batch: string[]) {
    const g = gen, w = waiting;
    const body = new URLSearchParams();
    batch.forEach((t) => body.append('q', t));
    let out: unknown[];
    try {
      const res = await fetch(ENDPOINT + encodeURIComponent(lang), { method: 'POST', body });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      out = await res.json();
      if (!Array.isArray(out) || out.length !== batch.length) throw new Error('unexpected answer');
    } catch {
      batch.forEach((text) => w.delete(text));
      if (g === gen) setFailed(true);
      return;
    }
    if (g !== gen) return; // the language has changed meanwhile
    batch.forEach((text, i) => {
      const cbs = w.get(text);
      w.delete(text);
      let t = Array.isArray(out[i]) ? out[i][0] : out[i];
      if (typeof t !== 'string') return;
      t = t.replace(/&(amp|lt|gt|quot|#39);/g, (m, e) => ENTITIES[e]);
      cache.set(text, t);
      if (cbs) cbs.forEach((cb) => { try { cb(t); } catch (e) { console.error(e); } });
    });
    saveCache();
    setFailed(false);
  }

  function loadCache() {
    cache = new Map();
    try {
      const saved = JSON.parse(localStorage.getItem(CACHE_KEY)!);
      if (saved && saved.lang === lang && Array.isArray(saved.items)) cache = new Map(saved.items);
    } catch { /* fetched again */ }
  }
  function saveCache() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      if (lang === 'en') return;
      try { localStorage.setItem(CACHE_KEY, JSON.stringify({ lang, items: [...cache].slice(-CACHE_MAX) })); }
      catch { /* storage full: kept for this visit */ }
    }, 1500);
  }

  // Offline or refused: the text stays in English and the page is tried again a little later
  function setFailed(v: boolean) {
    if (failed === v) return;
    failed = v;
    status.textContent = v ? 'Google Translate can’t be reached right now, so some text is still in English. The app tries again by itself.' : '';
    if (v && !retryTimer) retryTimer = setTimeout(retry, 20000);
  }
  function retry() {
    clearTimeout(retryTimer);
    retryTimer = 0;
    if (!failed || lang === 'en') return;
    setFailed(false);
    gen++;
    waiting = new Map();
    scan(document.body);
    observer!.takeRecords();
  }
  window.addEventListener('online', retry);

  // Show the page in `lang`
  function apply() {
    gen++;
    waiting = new Map();
    queue = [];
    setFailed(false);
    document.documentElement.lang = tagOf(lang);
    document.documentElement.classList.toggle('tr-rtl', RTL.includes(lang));
    if (observer) restore(); // the English first, so nothing stays in the old language
    if (lang === 'en') {
      if (observer) observer.takeRecords(); // keeps watching, to put back the English in texts the app had set aside
      return;
    }
    loadCache();
    observe();
    scan(document.body);
    observer!.takeRecords(); // the changes it just made itself
  }

  // ---- Settings → Language: a list of every language, with a search ----
  const page = document.getElementById('settingsPage')!;
  const main = page.querySelector<HTMLElement>('.set-inner')!;
  const row = document.getElementById('setLangBtn')!;
  const rowValue = document.getElementById('setLangVal')!;
  const picker = document.getElementById('langPage')!;
  const back = document.getElementById('langBack')!;
  const search = document.getElementById('langSearch') as HTMLInputElement;
  const sugHead = document.getElementById('langSugHead')!;
  const sugGroup = document.getElementById('langSug')!;
  const allHead = document.getElementById('langAllHead')!;
  const allGroup = document.getElementById('langAll')!;
  const none = document.getElementById('langNone')!;
  const status = document.getElementById('langStatus')!;
  const HASH = '#settings/language';

  // The browser's name for language `code` in language `inCode`, or null when it doesn't know it
  const namers = new Map<string, Intl.DisplayNames | null>();
  function nameOf(code: string, inCode: string) {
    const loc = tagOf(inCode);
    if (!namers.has(loc)) {
      let dn: Intl.DisplayNames | null = null;
      try {
        dn = new Intl.DisplayNames([loc], { type: 'language', fallback: 'none' });
        if (dn.resolvedOptions().locale.split('-')[0] !== loc.split('-')[0]) dn = null; // it fell back to another language
      } catch { dn = null; }
      namers.set(loc, dn);
    }
    try {
      const n = namers.get(loc) && namers.get(loc)!.of(tagOf(code));
      return n ? n.charAt(0).toLocaleUpperCase(loc) + n.slice(1) : null;
    } catch { return null; }
  }
  // A language's name in the app's language, and in its own
  const label = (code: string) => (lang === 'en' ? LANGS[code] : nameOf(code, lang) || LANGS[code]);
  const ownName = (code: string) => (code === 'en' ? 'English' : nameOf(code, code));
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

  function showValue() {
    rowValue.textContent = ownName(lang) || LANGS[lang];
    rowValue.lang = tagOf(lang);
  }

  function rowFor(code: string, group: string) {
    const lab = document.createElement('label');
    lab.className = 'set-row lang-row';
    const text = document.createElement('span');
    text.className = 'set-text';
    const b = document.createElement('b');
    b.textContent = label(code);
    text.append(b);
    const own = ownName(code);
    if (own && fold(own) !== fold(b.textContent)) {
      const small = document.createElement('small');
      small.lang = tagOf(code);
      small.dir = 'auto';
      small.textContent = own;
      text.append(small);
    }
    const input = document.createElement('input');
    input.type = 'radio';
    input.className = 'lang-check';
    input.name = 'appLang-' + group;
    input.value = code;
    input.checked = code === lang;
    lab.dataset.find = fold([code, LANGS[code], b.textContent, own || ''].join(' '));
    lab.append(text, input);
    return lab;
  }

  // English, the phone's languages and the Swiss ones first
  function suggestions() {
    const out = ['en'];
    for (const t of navigator.languages || [navigator.language]) {
      const c = fromTag(t);
      if (c && !out.includes(c)) out.push(c);
    }
    for (const c of [lang, 'de', 'fr', 'it']) if (!out.includes(c)) out.push(c);
    return out;
  }

  let listIn: string | null = null; // the language the list is written in
  function renderList() {
    if (listIn === lang) {
      for (const i of picker.querySelectorAll<HTMLInputElement>('.lang-check')) i.checked = i.value === lang;
      return;
    }
    listIn = lang;
    let coll;
    try { coll = new Intl.Collator(tagOf(lang)); } catch { coll = new Intl.Collator('en'); }
    const rows = Object.keys(LANGS).map((c) => rowFor(c, 'all'));
    const name = (r: HTMLElement) => r.querySelector('b')!.textContent;
    rows.sort((a, b) => coll.compare(name(a), name(b)));
    sugGroup.replaceChildren(...suggestions().map((c) => rowFor(c, 'sug')));
    allGroup.replaceChildren(...rows);
  }

  function filter() {
    const q = fold(search.value.trim());
    let found = 0;
    for (const r of allGroup.children as HTMLCollectionOf<HTMLElement>) {
      r.hidden = !!q && !r.dataset.find!.includes(q);
      if (!r.hidden) found++;
    }
    sugHead.hidden = sugGroup.hidden = !!q;
    allHead.hidden = allGroup.hidden = !found;
    none.hidden = !!found;
  }

  let pickerOpen = false;
  let pushed = false;
  let closeTimer = 0;
  function showPicker() {
    pickerOpen = true;
    search.value = '';
    renderList();
    filter();
    main.inert = true;
    picker.scrollTop = 0;
    picker.classList.add('open');
    picker.setAttribute('aria-hidden', 'false');
    back.focus({ preventScroll: true });
  }
  function hidePicker() {
    pickerOpen = false;
    clearTimeout(closeTimer);
    picker.classList.remove('open');
    picker.setAttribute('aria-hidden', 'true');
    main.inert = false;
    if (page.classList.contains('open')) row.focus({ preventScroll: true });
  }
  function syncPicker() {
    const want = location.hash === HASH;
    if (want !== pickerOpen) (want ? showPicker : hidePicker)();
  }
  function openPicker() {
    if (location.hash === HASH) return syncPicker();
    pushed = true;
    location.hash = HASH.slice(1);
  }
  function closePicker() {
    if (pushed) { pushed = false; history.back(); return; }
    history.replaceState(null, '', location.pathname + location.search + '#settings');
    syncPicker();
  }

  function choose(code: string) {
    if (code === lang || !LANGS[code]) return;
    lang = code;
    try { localStorage.setItem(KEY, code); } catch { /* this visit only */ }
    apply();
    showValue();
    for (const i of picker.querySelectorAll<HTMLInputElement>('.lang-check')) i.checked = i.value === lang;
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (pickerOpen) closePicker(); }, 350); // a moment to see the tick move
  }

  row.addEventListener('click', openPicker);
  back.addEventListener('click', closePicker);
  search.addEventListener('input', filter);
  picker.addEventListener('change', (e) => { if ((e.target as HTMLInputElement).classList.contains('lang-check')) choose((e.target as HTMLInputElement).value); });
  picker.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || (e.target === search && search.value)) return; // Escape first clears the search
    e.stopPropagation(); // not the settings page's Escape
    closePicker();
  });
  window.addEventListener('hashchange', () => {
    if (location.hash !== HASH) pushed = false;
    syncPicker();
  });

  window.APP_LANG = {
    get code() { return lang; },
    // A sentence that is said instead of shown (a11y.js: what screen readers are told) → Promise of it in the
    // app's language. It stays unanswered while Google Translate can't be reached: the caller does not wait long.
    translate: (text) => new Promise((resolve) => {
      if (lang === 'en' || !worth(text)) resolve(text);
      else translate(text, resolve);
    }),
    // The language to ask a service for, among the ones it offers (['de', 'fr', 'it', 'en']), else `fallback`
    pick: (offered, fallback = 'en') => {
      const base = tagOf(lang).split('-')[0];
      return offered.includes(base) ? base : fallback;
    },
  };

  showValue();
  if (lang !== 'en') apply();
  syncPicker(); // a #settings/language link opens straight on the list
})();
