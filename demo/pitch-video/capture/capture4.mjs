// Version 4 footage: the current app (16:00 state, TypeScript build served on :8160), recorded at phone size, 2x.
// Each segment becomes capture/v4/<name>.mp4 (30 fps, real time) plus <name>.json with the times of its events.
// Usage: node capture4.mjs [segment,segment]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const here = path.dirname(new URL(import.meta.url).pathname.slice(1));
const OUT = path.join(here, "v4");
fs.mkdirSync(OUT, { recursive: true });
const URL0 = process.env.APP_URL || "http://127.0.0.1:8160/";
const ONLY = (process.argv[2] || "intro,lang,journey,live").split(",");
const RUETI = [7.50559, 46.95628];
const W = 390, H = 844, DPR = 2;

const browser = await chromium.launch({ channel: "chrome", headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });

async function session(name, query, fn, cast = false) {
  if (!ONLY.includes(name)) return;
  const ctx = await browser.newContext({
    viewport: { width: W, height: H }, deviceScaleFactor: DPR, isMobile: true, hasTouch: true,
    geolocation: { latitude: 46.94758, longitude: 7.44007, accuracy: 6 }, permissions: ["geolocation"], locale: "en-GB",
  });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log("pageerror:", e.message.slice(0, 160)));
  await page.addInitScript(() => {
    window.__tap = (x, y) => {
      const d = document.createElement("div");
      d.style.cssText = `position:fixed;left:${x - 22}px;top:${y - 22}px;width:44px;height:44px;border-radius:50%;
        background:rgba(20,20,25,.22);border:2px solid rgba(255,255,255,.85);z-index:2147483647;pointer-events:none;
        transform:scale(.6);opacity:0;transition:transform .32s cubic-bezier(.05,.7,.1,1),opacity .18s ease-out`;
      document.body.appendChild(d);
      requestAnimationFrame(() => { d.style.transform = "scale(1)"; d.style.opacity = "1"; });
      setTimeout(() => { d.style.transition = "transform .4s ease-out,opacity .4s ease-out"; d.style.transform = "scale(1.5)"; d.style.opacity = "0"; }, 380);
      setTimeout(() => d.remove(), 900);
    };
  });
  const cdp = await ctx.newCDPSession(page);
  await page.goto(URL0 + query, { waitUntil: "load" });
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: DPR, mobile: true });
  await page.waitForTimeout(4500);

  const dir = path.join(OUT, name + "-frames");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const frames = [], events = [];
  let n = 0, recording = true;
  const t0 = Date.now() / 1000;
  const now = () => Date.now() / 1000 - t0;
  let castT0 = null;
  if (cast) {
    cdp.on("Page.screencastFrame", (ev) => {
      cdp.send("Page.screencastFrameAck", { sessionId: ev.sessionId }).catch(() => {});
      if (!recording) return;
      const f = String(n++).padStart(5, "0") + ".jpg";
      fs.writeFileSync(path.join(dir, f), Buffer.from(ev.data, "base64"));
      frames.push({ f, t: Date.now() / 1000 - t0 });
    });
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: 88, everyNthFrame: 1 });
  }
  const loop = (async () => {
    while (recording && !cast) {
      const a = Date.now();
      const r = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90, optimizeForSpeed: true }).catch(() => null);
      if (!r) break;
      const f = String(n++).padStart(5, "0") + ".jpg";
      fs.writeFileSync(path.join(dir, f), Buffer.from(r.data, "base64"));
      frames.push({ f, t: (a + Date.now()) / 2000 - t0 });
    }
  })();
  const api = {
    page,
    mark: (m) => { events.push({ name: m, t: +now().toFixed(3) }); console.log(`  [${name}] ${m} @ ${now().toFixed(2)}`); },
    wait: (ms) => page.waitForTimeout(ms),
    text: async (sel) => (await page.locator(sel).first().innerText().catch(() => "")).replace(/\n+/g, " | ").slice(0, 600),
    tap: async (loc, label, dom = false) => {
      const l = typeof loc === "string" ? page.locator(loc).first() : loc;
      await l.waitFor({ state: "visible", timeout: 8000 });
      let box = await l.boundingBox();
      for (let i = 0; i < 20; i++) {
        await page.waitForTimeout(80);
        const b = await l.boundingBox();
        const still = b && box && Math.abs(b.y - box.y) < 0.5 && Math.abs(b.x - box.x) < 0.5;
        box = b || box;
        if (still) break;
      }
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await page.evaluate(([x, y]) => window.__tap(x, y), [x, y]);
      await page.waitForTimeout(240);
      if (label) api.mark(label);
      if (dom) await l.evaluate((e) => e.click()); else await page.mouse.click(x, y);
    },
    step: async (label, f) => { try { await f(); } catch (e) { console.log(`  [${name}] STEP FAILED ${label}: ${e.message.split("\n")[0].slice(0, 200)}`); } },
  };
  api.mark("start");
  try { await fn(api); } catch (e) { console.log(`[${name}] FAILED: ${e.message.split("\n")[0].slice(0, 200)}`); }
  api.mark("end");
  recording = false;
  await loop;
  if (cast) await cdp.send("Page.stopScreencast").catch(() => {});
  const end = now();
  const lines = [];
  frames.forEach((fr, i) => {
    const next = i + 1 < frames.length ? frames[i + 1].t : end;
    lines.push(`file '${name}-frames/${fr.f}'`, `duration ${Math.max(0.001, next - (i === 0 ? 0 : fr.t)).toFixed(4)}`);
  });
  lines.push(`file '${name}-frames/${frames.at(-1).f}'`);
  fs.writeFileSync(path.join(OUT, name + ".txt"), lines.join("\n"));
  execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", name + ".txt", "-vf", "fps=30,format=yuv420p", "-c:v", "libx264", "-crf", "14", "-preset", "veryfast", "-g", "15", name + ".mp4"], { cwd: OUT, stdio: "inherit" });
  fs.writeFileSync(path.join(OUT, name + ".json"), JSON.stringify({ W, H, DPR, length: +end.toFixed(3), fps: +(frames.length / end).toFixed(1), events }, null, 1));
  console.log(`[${name}] ${frames.length} frames, ${(frames.length / end).toFixed(1)} fps, ${end.toFixed(1)} s`);
  fs.rmSync(dir, { recursive: true, force: true });
  await ctx.close();
}

// ---- the first-visit introduction: welcome, the 3D walk across Hirschengraben, the two questions
await session("intro", "", async ({ page, mark, wait, tap, step }) => {
  await wait(1200);
  await tap(page.locator("button", { hasText: /Yes, show me/i }), "tap-yes");
  mark("walk");
  const bar = () => page.evaluate(() => [...document.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().width > 0 && /^(Skip the demo|Continue)$/.test(b.innerText.trim())).map((b) => b.innerText.trim()).join(","));
  console.log("  bar:", await bar());
  let fpsN = 0;
  await page.evaluate(() => { window.__raf = 0; const f = () => { window.__raf++; requestAnimationFrame(f); }; requestAnimationFrame(f); });
  for (let i = 0; i < 90; i++) {
    await wait(500);
    const b = await bar();
    if (i === 10) console.log("  rAF per second:", (await page.evaluate(() => window.__raf)) / 5.5);
    if (b.includes("Continue") && !b.includes("Skip")) break;
  }
  mark("arrived");
  await wait(1500);
  await tap(page.locator("button", { hasText: /^(Continue|Skip the demo)$/ }).last(), "tap-continue", true);
  await wait(1400);
  mark("q1");
  await step("auto", async () => { await tap("#obAuto", "tap-auto", true); });
  await wait(1600);
  await tap(page.locator("button.ob-btn.primary:visible").last(), "tap-q1-continue", true);
  await wait(1400);
  mark("q2");
  await step("stairs", async () => { await tap(page.locator(".switch:visible").nth(1), "tap-stairs", true); });
  await wait(1600);
  await tap(page.locator("button.ob-btn.primary:visible").last(), "tap-open-map", true);
  await wait(2500);
}, true);

// ---- language: Settings > App language > Ukrainian, then the translated app
await session("lang", "?intro=0", async ({ page, mark, wait, tap, text }) => {
  await tap("#menuBtn", "tap-menu", true);
  await wait(600);
  await tap("#settingsBtn", "tap-settings", true);
  await wait(1300);
  await tap("#setLangBtn", "tap-language", true);
  await wait(1200);
  mark("list");
  // glide down the list of languages
  await page.evaluate(() => {
    const els = [...document.querySelectorAll("#langPage, #langPage *")].filter((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY));
    const el = els[0]; if (!el) return;
    const t0 = performance.now(), D = 2600, Y = 5200;
    const f = (t) => { const k = Math.min(1, (t - t0) / D); el.scrollTop = Y * (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2); if (k < 1) requestAnimationFrame(f); };
    requestAnimationFrame(f);
  });
  await wait(2900);
  mark("list-end");
  const row = page.locator('#langAll label.lang-row', { hasText: "Ukrainian" }).first();
  await row.scrollIntoViewIfNeeded();
  await wait(500);
  await tap(row, "tap-ukrainian", true);
  await wait(4500);
  mark("translated");
  console.log("  settings now:", (await text("#settingsPage")).slice(0, 160));
  await page.evaluate(() => { const b = document.querySelector("#langBack"); if (b && b.getBoundingClientRect().width > 0) b.click(); });
  await wait(1500);
  mark("settings-uk");
  await page.evaluate(() => { const els = [...document.querySelectorAll("#settingsPage, #settingsPage *")].filter((e) => e.scrollHeight > e.clientHeight + 200 && /auto|scroll/.test(getComputedStyle(e).overflowY)); if (els[0]) els[0].scrollTo({ top: 520, behavior: "smooth" }); });
  await wait(2200);
  mark("settings-uk-end");
});

// ---- search with pins, the choice of journeys, one journey with its ticket, live tracking
await session("journey", "?intro=0", async ({ page, mark, wait, tap, text, step }) => {
  await step("search", async () => {
    await tap("#q", "tap-search");
    await page.focus("#q");
    await page.keyboard.type("Wankdorf", { delay: 90 });
    mark("typed");
    let last = "", since = Date.now();
    for (let i = 0; i < 60; i++) {
      const txt = await page.locator("#results").innerText();
      if (txt !== last) { last = txt; since = Date.now(); }
      if (Date.now() - since > 600) break;
      await wait(60);
    }
    mark("results");
    await wait(1800);
    mark("results-end");
  });
  await page.evaluate((lngLat) => { document.querySelector("#q").blur(); showDestinationJourney({ title: "Ostermundigen, Rüti", lngLat }); }, RUETI);
  mark("journey-call");
  await page.waitForSelector(".jrow", { timeout: 25000 });
  mark("routes");
  await wait(3000);
  await step("row", async () => {
    await tap(page.locator(".jrow").nth(1), "tap-row");
    await wait(3000);
    mark("row-open");
    console.log("  after row:", await text(".ksheet"));
  });
  await step("detail", async () => {
    const start = page.locator(".ksheet button", { hasText: /^Start/ });
    if (!(await start.count())) { await tap(page.locator(".jrow.shown, .jrow").first(), "tap-row-again"); await wait(2500); console.log("  after again:", await text(".ksheet")); }
    mark("detail");
    console.log("  ticket:", await page.locator("a.ticket").count(), "fare:", await text(".ticket-fare-row"), "3d:", await page.locator("button.view3d").count());
    console.log("  buttons:", await page.evaluate(() => [...document.querySelectorAll(".ksheet button, .ksheet a")].filter((b) => b.getBoundingClientRect().width > 0).map((b) => b.className + ":" + (b.innerText || b.getAttribute("aria-label") || "").replace(/\n/g, " ").slice(0, 24)).join("  ")));
    await wait(2500);
    mark("detail-end");
  });
  await step("fare", async () => {
    const t = page.locator(".ticket-fare-toggle").first();
    if (await t.count()) { await tap(t, "tap-fare"); await wait(2200); mark("fare-open"); console.log("  fare form:", await text(".ticket-fare-form")); }
  });
  await step("start", async () => {
    await tap(page.locator(".ksheet button", { hasText: /^Start/ }).first(), "tap-start");
    await wait(6000);
    mark("started");
    console.log("  started:", await text(".ksheet"));
    await wait(3000);
  });
});

// ---- live vehicles around Bern station
await session("live", "?intro=0", async ({ page, mark, wait }) => {
  await page.evaluate(() => map.jumpTo({ center: [7.4405, 46.9482], zoom: 15.9 }));
  await wait(7000);
  mark("live");
  await page.evaluate(() => map.easeTo({ center: [7.4412, 46.9480], zoom: 16.5, duration: 9000, easing: (t) => t }));
  await wait(9500);
  mark("live-end");
});

// ---- the two questions of the introduction: walking speed (with "Adjust to how I walk") and access needs
await session("questions", "", async ({ page, mark, wait, tap, step }) => {
  await tap(page.locator("button.ob-btn", { hasText: /Not now/ }).last(), "tap-not-now", true);
  await wait(1500);
  mark("q1");
  await step("slow", async () => { await tap(page.locator(".ob-pick:visible").nth(1), "tap-relaxed", true); });
  await wait(1100);
  await step("auto", async () => { await tap("#obAuto", "tap-auto", true); });
  await wait(1800);
  await tap(page.locator("button.ob-btn.primary:visible").last(), "tap-q1-continue", true);
  await wait(1500);
  mark("q2");
  await step("stairs", async () => { await tap(page.locator(".switch:visible").nth(1), "tap-stairs", true); });
  await wait(2000);
  await tap(page.locator("button.ob-btn.primary:visible").last(), "tap-open-map", true);
  await wait(2500);
});

await browser.close();
