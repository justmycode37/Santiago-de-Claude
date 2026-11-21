// Exploration of the current app (16:00 state): what each new screen looks like and which selectors exist.
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
const out = path.join(here, "explore4");
fs.mkdirSync(out, { recursive: true });
const URL0 = process.argv[2] || "http://127.0.0.1:8160/";
const PARTS = (process.argv[3] || "intro,journey,settings,search,live").split(",");
const RUETI = [7.50559, 46.95628];

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const mk = () => browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  geolocation: { latitude: 46.94758, longitude: 7.44007, accuracy: 6 }, permissions: ["geolocation"], locale: "en-GB",
});
const shot = (page, name) => page.screenshot({ path: path.join(out, name + ".jpg"), type: "jpeg", quality: 70 }).then(() => console.log("shot", name));
const buttons = (page) => page.evaluate(() => [...document.querySelectorAll("button, [role=button], [role=switch], select, input, a.btn")]
  .filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0; })
  .map((b) => (b.id ? "#" + b.id : "." + b.className.toString().split(" ").slice(0, 2).join(".")) + (b.dataset && b.dataset.setting ? "[" + b.dataset.setting + "]" : "") + ":" + (b.innerText || b.getAttribute("aria-label") || b.title || "").replace(/\n/g, " ").slice(0, 30)).join("  "));
const step = async (name, fn) => { try { await fn(); } catch (e) { console.log("STEP FAILED", name, e.message.split("\n")[0].slice(0, 200)); } };
const open = async (ctx, q = "") => {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 160)));
  await page.goto(URL0 + q, { waitUntil: "load" });
  await page.waitForTimeout(4000);
  return page;
};

if (PARTS.includes("intro")) {
  const ctx = await mk();
  const page = await open(ctx);
  await shot(page, "intro-0-welcome");
  console.log("welcome:", await buttons(page));
  console.log("welcome text:", (await page.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 400));
  await step("demo", async () => {
    await page.locator("button", { hasText: /Yes, show me/i }).first().click({ timeout: 4000 });
    for (let i = 1; i <= 12; i++) {
      await page.waitForTimeout(2500);
      await shot(page, "intro-1-demo-" + String(i).padStart(2, "0"));
      if (i === 2 || i === 12) console.log("demo buttons@" + i + ":", await buttons(page));
      const done = await page.locator("button", { hasText: /^Continue$/ }).count();
      if (done) { console.log("continue visible at", i * 2.5, "s"); break; }
    }
  });
  await step("q1", async () => {
    await page.locator("button", { hasText: /Continue|Skip the demo/ }).first().click({ timeout: 4000 });
    await page.waitForTimeout(1500);
    await shot(page, "intro-2-speed");
    console.log("q1:", await buttons(page));
    console.log("q1 text:", (await page.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 600));
  });
  await step("q2", async () => {
    await page.locator("button", { hasText: /Continue|Next/ }).last().click({ timeout: 4000 });
    await page.waitForTimeout(1500);
    await shot(page, "intro-3-access");
    console.log("q2:", await buttons(page));
    console.log("q2 text:", (await page.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 600));
  });
  await ctx.close();
}

if (PARTS.includes("journey")) {
  const ctx = await mk();
  const page = await open(ctx, "?intro=0");
  await shot(page, "home");
  console.log("home:", await buttons(page));
  await step("journey", async () => {
    await page.evaluate((lngLat) => showDestinationJourney({ title: "Ostermundigen, Rüti", lngLat }), RUETI);
    await page.waitForTimeout(9000);
    await shot(page, "journey");
    console.log("journey:", await buttons(page));
    console.log("sheet:", (await page.locator(".ksheet").innerText()).replace(/\n+/g, " | ").slice(0, 900));
  });
  await step("sheet-up", async () => {
    // show the whole sheet: scroll its content
    const h = await page.evaluate(() => { const s = document.querySelector(".ksheet"); return s ? [s.scrollHeight, s.clientHeight, s.className] : null; });
    console.log("sheet size:", JSON.stringify(h));
    await page.evaluate(() => { const s = document.querySelector(".ksheet"); if (s) s.scrollTop = 400; });
    await page.waitForTimeout(600);
    await shot(page, "journey-scrolled");
  });
  await step("ids", async () => {
    console.log("ids:", await page.evaluate(() => [...document.querySelectorAll("[id]")].filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).map((e) => e.id).join(",")));
  });
  await ctx.close();
}

if (PARTS.includes("settings")) {
  const ctx = await mk();
  const page = await open(ctx, "?intro=0");
  await step("settings", async () => {
    await page.click("#menuBtn");
    await page.waitForTimeout(500);
    await shot(page, "menu");
    console.log("menu:", await buttons(page));
    await page.click("#settingsBtn");
    await page.waitForTimeout(1200);
    await shot(page, "settings-0");
    console.log("settings:", await buttons(page));
    console.log("settings text:", (await page.locator("body").innerText()).replace(/\n+/g, " | ").slice(0, 1800));
    for (let i = 1; i <= 3; i++) {
      await page.evaluate((y) => { const els = [...document.querySelectorAll("*")].filter((e) => e.scrollHeight > e.clientHeight + 40 && getComputedStyle(e).overflowY.match(/auto|scroll/)); els.forEach((e) => (e.scrollTop = y)); }, i * 600);
      await page.waitForTimeout(500);
      await shot(page, "settings-" + i);
    }
  });
  await ctx.close();
}

if (PARTS.includes("search")) {
  const ctx = await mk();
  const page = await open(ctx, "?intro=0");
  await step("search", async () => {
    await page.click("#q");
    await page.waitForTimeout(600);
    await shot(page, "search-focus");
    console.log("search focus:", await buttons(page));
    await page.keyboard.type("Wankdorf", { delay: 40 });
    await page.waitForTimeout(3500);
    await shot(page, "search-wankdorf");
    console.log("results:", (await page.locator("#results").innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 400));
  });
  await ctx.close();
}

if (PARTS.includes("live")) {
  const ctx = await mk();
  const page = await open(ctx, "?intro=0");
  await step("live", async () => {
    await page.click("#menuBtn");
    await page.waitForTimeout(500);
    console.log("menu:", await buttons(page));
  });
  await ctx.close();
}
await browser.close();
