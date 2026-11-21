import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
const out = path.join(here, "explore4");
const URL0 = "http://127.0.0.1:8160/";
const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  geolocation: { latitude: 46.94758, longitude: 7.44007, accuracy: 6 }, permissions: ["geolocation"], locale: "en-GB" });
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".jpg"), type: "jpeg", quality: 70 }).then(() => console.log("shot", name));
const txt = async (page, sel) => (await page.locator(sel).first().innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 700);
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log("STEP FAILED", name, e.message.split("\n")[0].slice(0, 200)); } };
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 160)));
await page.goto(URL0 + "?intro=0", { waitUntil: "load" });
await page.waitForTimeout(4000);
await step("search", async () => {
  await page.click("#q");
  await page.keyboard.type("Ostermundigen Rüti", { delay: 40 });
  await page.waitForTimeout(3000);
  await shot(page, "f-search");
  console.log("results:", await txt(page, "#results"));
  await page.locator("#results li").first().click();
  await page.waitForSelector(".jrow", { timeout: 20000 });
  await page.waitForTimeout(2500);
  await shot(page, "f-routes");
});
await step("row", async () => {
  await page.locator(".jrow").nth(1).click();
  await page.waitForTimeout(2500);
  await shot(page, "f-row2");
  console.log("after row:", await txt(page, ".ksheet"));
  console.log("classes:", await page.evaluate(() => [...document.querySelectorAll(".ksheet *")].filter((e) => e.getBoundingClientRect().height > 0).map((e) => e.className && e.className.toString()).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" ; ").slice(0, 1500)));
});
await step("row again", async () => {
  await page.locator(".jrow.shown, .jrow").first().click();
  await page.waitForTimeout(2500);
  await shot(page, "f-row3");
  console.log("after row again:", await txt(page, ".ksheet"));
});
await step("expand", async () => {
  await page.locator("#jHandle").click();
  await page.waitForTimeout(1500);
  await shot(page, "f-expanded");
  console.log("expanded:", await txt(page, ".ksheet"));
  console.log("view3d:", await page.locator("button.view3d").count(), "ticket:", await page.locator("a.ticket").count(), "fare:", await txt(page, ".ticket-fare-row"));
});
await step("3d", async () => {
  await page.locator("button.view3d").first().click({ timeout: 3000 });
  for (let i = 1; i <= 4; i++) { await page.waitForTimeout(2500); await shot(page, "f-3d-" + i); }
  console.log("3d text:", (await page.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 500));
});
// language page
const p2 = await ctx.newPage();
await p2.goto(URL0 + "?intro=0", { waitUntil: "load" });
await p2.waitForTimeout(3000);
await step("lang", async () => {
  await p2.click("#menuBtn"); await p2.waitForTimeout(400); await p2.click("#settingsBtn"); await p2.waitForTimeout(900);
  await p2.click("#setLangBtn"); await p2.waitForTimeout(1200);
  await shot(p2, "f-lang");
  console.log("lang page:", await txt(p2, "#langPage"));
  console.log("lang html:", (await p2.locator("#langSug").innerHTML()).slice(0, 500));
  await p2.locator("#langPage").getByText("Ukrainian", { exact: false }).first().click({ timeout: 3000 });
  await p2.waitForTimeout(5000);
  await shot(p2, "f-lang-uk");
  console.log("settings uk:", await txt(p2, "#settingsPage"));
});
// live vehicles
await step("live", async () => {
  await p2.evaluate(() => { document.querySelector("#settingsClose")?.click(); });
  await p2.waitForTimeout(500);
  await p2.evaluate(() => map.jumpTo({ center: [7.4405, 46.9482], zoom: 16.2 }));
  await p2.waitForTimeout(7000);
  await shot(p2, "f-live-1");
  await p2.waitForTimeout(4000);
  await shot(p2, "f-live-2");
  console.log("veh:", await p2.evaluate(() => { const s = map.getSource("kveh"); return s ? JSON.stringify((s._data && s._data.features || []).length) : "no source"; }));
});
await browser.close();
