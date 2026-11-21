// What src/a11y.ts puts on window: what the app tells screen readers (VoiceOver, TalkBack) by itself, the same
// sentences for Read aloud and Vibrate (Settings › Guidance), and a few helpers for markup that reads well.
// See docs/screen-readers.md.

interface A11ySayOptions {
  /** Interrupts what the screen reader is saying (the assertive region). For "get off", "platform changed" and the like. */
  urgent?: boolean;
  /** A live region inside an open dialog: a screen reader in a modal dialog does not hear the page behind it. */
  region?: HTMLElement | null;
  /** The live region only: no voice (Read aloud) and no buzz (Vibrate). */
  quiet?: boolean;
}

interface A11yDialogOptions {
  /** What gets the focus; the dialog itself when left out. */
  focus?: HTMLElement | null;
  /** What opened the dialog, or a function giving it when the dialog closes; whatever had focus when left out. */
  returnTo?: HTMLElement | null | (() => HTMLElement | null);
  /** Elements behind the dialog that stay usable (the dimmed backdrop that closes it on a tap). */
  keep?: HTMLElement[];
}

interface A11yApi {
  /** One sentence for screen readers, through a live region; also spoken and buzzed when those are switched on. */
  say(text: string, options?: A11ySayOptions): void;
  /** This phone's own voice (Read aloud). false when nothing was said. */
  speak(text: string, options?: { urgent?: boolean; force?: boolean }): boolean;
  /** Stop the voice. */
  hush(): void;
  /** A short buzz, or two for something urgent (Vibrate; Android only). */
  buzz(urgent?: boolean): void;
  /** Lets the page speak later: call it inside the tap that switches Read aloud on (iOS). */
  unlock(): void;
  /** The language a text is written in, from its commonest words; '' when that is not clear. */
  textLang(text: string | null | undefined): 'de' | 'fr' | 'it' | 'en' | '';
  /** The language spoken at a place in Switzerland, which its station and street names are in; '' elsewhere. */
  placeLang(ll: readonly [number, number] | null | undefined): 'de' | 'fr' | 'it' | '';
  /** Marks the element's text as being in `lang` (nothing for the page's own language or ''). Returns the element. */
  setLang<T extends HTMLElement>(el: T, lang: string): T;
  /** The same for a text whose language was read from its words: only while the app is in English (else it is translated). */
  inLang<T extends HTMLElement>(el: T, lang: string): T;
  /** "1 minute", "12 minutes". */
  minutes(n: number): string;
  /** "750 metres", "1.2 kilometres". */
  metres(m: number): string;
  /** A dialog over the page: everything behind it is out of reach, focus moves in. */
  openDialog(el: HTMLElement, options?: A11yDialogOptions): void;
  /** Gives the page back and returns focus to where the dialog was opened from (else to `fallback`). */
  closeDialog(el: HTMLElement, options?: { fallback?: HTMLElement | null; restore?: boolean }): void;
  /** Text for screen readers only, next to something drawn for the eye. */
  sr(text: string): HTMLSpanElement;
  /** The drawn version, hidden from screen readers. */
  seen<T extends HTMLElement>(node: T): T;
  seen(node: string): HTMLSpanElement;
  /** Keep the screen on (a browser stops a page whose screen is off). */
  keepAwake(on: boolean): void;
  canSpeak: boolean;
  canVibrate: boolean;
  canKeepAwake: boolean;
}

/** Missing on pages that do not load a11y.js (scan-bench.html). */
declare var A11Y: A11yApi;

// stop-access.js (tools/build-stop-access.mjs), loaded on demand for Settings › Blind or low vision: what is
// known about tactile guidance and spoken information at stop edges.
/** [lon × 1e5, lat × 1e5, the edge's label ("7", "C"), flags: t tactile guide lines, f tactile field at the boarding point, a spoken announcements, s display with speech]. */
type StopAccessEdge = [x: number, y: number, label: string, flags: string];
declare var STOP_ACCESS: { generated: string; stops: Record<string, StopAccessEdge[]> } | undefined;
