// Open the live map in a headless browser, let it run, and save where it drew every vehicle each second.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
// Playwright is borrowed from another project; point PLAYWRIGHT_PACKAGE_JSON at any package.json that has it installed.
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON || `${process.env.HOME}/Powercoders-Hackathon/kante/app/package.json`);
// The little of Playwright this script uses (the package is not installed here, so it has no types).
interface PwConsoleMessage { type(): string; text(): string }
interface PwPage {
  on(event: "console", listener: (m: PwConsoleMessage) => void): void;
  on(event: "pageerror", listener: (e: Error) => void): void;
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" }): Promise<unknown>;
  /** `fn` runs in the page, again and again until it answers something truthy. */
  waitForFunction(fn: () => unknown, arg?: null, options?: { timeout?: number }): Promise<unknown>;
  waitForTimeout(ms: number): Promise<void>;
  /** `fn` runs in the page; `arg` and the result travel as JSON. */
  evaluate<R>(fn: () => R): Promise<R>;
  evaluate<R, A>(fn: (arg: A) => R, arg: A): Promise<R>;
}
interface PwContextOptions { viewport?: { width: number; height: number }; deviceScaleFactor?: number; isMobile?: boolean; hasTouch?: boolean }
interface PwBrowser { newContext(options?: PwContextOptions): Promise<{ newPage(): Promise<PwPage> }>; close(): Promise<void> }
interface Playwright { chromium: { launch(): Promise<PwBrowser> } }
// What the functions handed to the page use there: page.ts's own top-level variables.
declare const fleet: { size: number }, map: { loaded(): boolean }, shapeCache: { size: number };
declare const window: { __trace: Map<string, LiveMapTrace> };

const { chromium } = require("playwright") as Playwright;
const [out, seconds] = [process.argv[2], Number(process.argv[3])];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const errors: string[] = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto("http://127.0.0.1:8090/?trace=1", { waitUntil: "load" });
await page.waitForFunction(() => fleet.size > 0 && map.loaded() && shapeCache.size > 0, null, { timeout: 60000 });
await page.waitForTimeout(seconds * 1000);
const keys = await page.evaluate(() => [...window.__trace.keys()]);
const trace: Record<string, LiveMapTrace> = {};
for (let i = 0; i < keys.length; i += 400) Object.assign(trace, await page.evaluate((ks) => Object.fromEntries(ks.map((k) => [k, window.__trace.get(k)])), keys.slice(i, i + 400)));
writeFileSync(out, gzipSync(JSON.stringify(trace)));
console.log("vehicles traced", keys.length, "errors", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
