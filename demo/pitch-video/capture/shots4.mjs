// 3x stills of the current app's journey sheet (Bay L, Start, Ticket, fare) and its step list.
import { chromium } from "playwright-core";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  geolocation: { latitude: 46.94758, longitude: 7.44007, accuracy: 6 }, permissions: ["geolocation"], locale: "en-GB" });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8160/?intro=0", { waitUntil: "load" });
await page.waitForTimeout(5000);
await page.evaluate(() => showDestinationJourney({ title: "Ostermundigen, Rüti", lngLat: [7.50559, 46.95628] }));
await page.waitForSelector(".jrow", { timeout: 25000 });
await page.waitForTimeout(2500);
await page.screenshot({ path: path.join(here, "v4", "routes4.png") });
await page.locator(".jrow").nth(1).evaluate((e) => e.click());
await page.waitForTimeout(5000);
await page.screenshot({ path: path.join(here, "v4", "journey4.png") });
const box = async (sel) => page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((e) => e.getBoundingClientRect().width > 0).map((e) => { const r = e.getBoundingClientRect(); return { t: (e.innerText || "").replace(/\n/g, " ").slice(0, 40), x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; }), sel);
console.log("ticket:", JSON.stringify(await box("a.ticket")));
console.log("fare:", JSON.stringify(await box(".ticket-fare-row")));
console.log("sheet:", JSON.stringify(await box(".ksheet")));
try {
  await page.locator("#jHandle").evaluate((e) => e.click());
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(here, "v4", "steps4.png") });
  console.log("view3d:", JSON.stringify(await box("button.view3d")));
} catch (e) { console.log("expand failed", e.message.slice(0, 100)); }
await browser.close();
