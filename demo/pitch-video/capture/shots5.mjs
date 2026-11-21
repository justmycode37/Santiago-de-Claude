// 3x stills of three rows of the current app's settings: Toilets, Drinking water (On the map) and Free food (Events, switched on).
import { chromium } from "playwright-core";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
  geolocation: { latitude: 46.94758, longitude: 7.44007, accuracy: 6 }, permissions: ["geolocation"], locale: "en-GB" });
const page = await ctx.newPage();
await page.goto("http://127.0.0.1:8160/?intro=0", { waitUntil: "load" });
await page.waitForTimeout(4000);
await page.locator("#menuBtn").evaluate((e) => e.click());
await page.waitForTimeout(400);
await page.locator("#settingsBtn").evaluate((e) => e.click());
await page.waitForTimeout(1200);
const row = (id) => page.locator(`#${id}`).locator("xpath=ancestor-or-self::*[contains(concat(' ', normalize-space(@class), ' '), ' set-row ')][1]");
for (const [name, id, on] of [["toilets", "setLayer-toilets", false], ["water", "setLayer-water", false], ["food", "setFoodT", true]]) {
  const r = row(id);
  await r.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  if (on) { await r.locator(".switch").evaluate((e) => e.click()); await page.waitForTimeout(900); }
  const b = await r.boundingBox();
  const h = 68, y = b.y + b.height / 2 - h / 2;
  await page.screenshot({ path: path.join(here, "v4", `row-${name}.png`), clip: { x: 16, y, width: 358, height: h } });
  console.log(name, JSON.stringify(b), (await r.innerText()).replace(/\n/g, " | "), "checked:", await r.locator(".switch").getAttribute("aria-checked").catch(() => "?"));
}
await browser.close();
