// Open the live map in a headless browser, let it run, and save where it drew every vehicle each second.
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
// Playwright is borrowed from another project; point PLAYWRIGHT_PACKAGE_JSON at any package.json that has it installed.
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE_JSON || `${process.env.HOME}/Powercoders-Hackathon/kante/app/package.json`);
const { chromium } = require("playwright");
const [out, seconds] = [process.argv[2], Number(process.argv[3])];
const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true })).newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto("http://127.0.0.1:8090/?trace=1", { waitUntil: "load" });
await page.waitForFunction(() => fleet.size > 0 && map.loaded() && shapeCache.size > 0, null, { timeout: 60000 });
await page.waitForTimeout(seconds * 1000);
const keys = await page.evaluate(() => [...window.__trace.keys()]);
const trace = {};
for (let i = 0; i < keys.length; i += 400) Object.assign(trace, await page.evaluate((ks) => Object.fromEntries(ks.map((k) => [k, window.__trace.get(k)])), keys.slice(i, i + 400)));
writeFileSync(out, gzipSync(JSON.stringify(trace)));
console.log("vehicles traced", keys.length, "errors", errors.length ? errors.slice(0, 5) : "none");
await browser.close();
