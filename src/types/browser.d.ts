// What the browser's own types lack, or say differently from how the page uses them.

// The page's timers start as null, and the browser takes null (it clears nothing).
declare function clearInterval(id: number | null | undefined): void;
declare function clearTimeout(id: number | null | undefined): void;

/** Device Memory API (Chromium): gigabytes of RAM, rounded. */
interface Navigator { readonly deviceMemory?: number }

/** `window.dispatchEvent(new CustomEvent('scan:text', { detail }))`: text Scan read (stopvision.ts; indoornav.ts listens). */
interface ScanTextDetail { text: string; tap?: boolean; at?: number }
/** `window.dispatchEvent(new CustomEvent('indoorloc:pressure', { detail }))`: a barometer reading (`INDOORLOC.pushPressure`). */
interface IndoorPressureDetail { hPa: number; t?: number }
interface WindowEventMap {
  'scan:text': CustomEvent<ScanTextDetail>;
  'indoorloc:pressure': CustomEvent<IndoorPressureDetail>;
}
