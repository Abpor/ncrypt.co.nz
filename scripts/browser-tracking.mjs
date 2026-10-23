#!/usr/bin/env node
// Local browser acceptance for the tracking wiring (Chromium via Playwright).
// LIMITATION: TidyCal is simulated. A stub page served at https://tidycal.com/... (via request
// interception) posts bookingComplete, so origin/source checks run for real, but TidyCal's own
// behaviour is NOT verified. No real booking or form is submitted.
// Run: NODE_PATH=$(npm root -g) node scripts/browser-tracking.mjs
import { createRequire } from "node:module";
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = process.cwd();
const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".jpg": "image/jpeg", ".xml": "application/xml" };

const server = http.createServer(async (req, res) => {
  let p = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (p.endsWith("/")) p += "index.html";
  try {
    const file = path.join(root, p);
    if ((await stat(file)).isDirectory()) throw new Error("dir");
    res.writeHead(200, { "content-type": types[path.extname(file)] || "application/octet-stream" });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404).end("not found");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const frameHtml = (origin) => `<button id=book onclick="parent.postMessage({event:'bookingComplete',data:{booking:{id:4242,booking_type_id:7}}},'*')">book</button>
<button id=bad onclick="parent.postMessage({event:'bookingComplete',data:{booking:{}}},'*')">bad</button>`;

const results = [];
const browser = await chromium.launch({ args: ["--no-sandbox"] });

async function newPage({ tidycal = "stub" } = {}) {
  const page = await (await browser.newContext()).newPage();
  page.errors = [];
  page.on("pageerror", (e) => page.errors.push(e.message));
  await page.route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    if (url.startsWith("https://asset-tidycal.b-cdn.net/js/embed.js") && tidycal === "stub") {
      return route.fulfill({ contentType: "text/javascript", body: `document.querySelectorAll('.tidycal-embed').forEach(function(d){var f=document.createElement('iframe');f.src='https://tidycal.com/ncrypt/free-operations-audit';f.style.cssText='width:100%;height:200px;border:0';d.appendChild(f);});` });
    }
    if (url.startsWith("https://tidycal.com/")) return route.fulfill({ contentType: "text/html", body: frameHtml() });
    return route.abort();
  });
  return page;
}
const events = (page) => page.evaluate(() => (window.dataLayer || []).filter((a) => a[0] === "event").map((a) => ({ name: a[1], ...a[2] })));
const blockNav = (page) => page.evaluate(() => document.addEventListener("click", (e) => e.preventDefault(), true));

async function check(name, fn) {
  try { await fn(); results.push([name, "PASS"]); }
  catch (e) { results.push([name, `FAIL: ${e.message.split("\n")[0]}`]); }
}

await check("cta_click + audit_cta_clicked with first-touch UTMs", async () => {
  const page = await newPage();
  await page.goto(`${base}/?utm_source=acceptance&utm_campaign=t1`);
  await blockNav(page);
  await page.locator('a.btn-primary[data-track]').first().click();
  const ev = await events(page);
  const cta = ev.find((e) => e.name === "cta_click");
  assert.ok(cta && cta.utm_source === "acceptance" && cta.utm_campaign === "t1");
  assert.ok(ev.some((e) => e.name === "audit_cta_clicked"));
  assert.deepEqual(page.errors, []);
});

await check("mailto_click", async () => {
  const page = await newPage();
  await page.goto(`${base}/`);
  await blockNav(page);
  await page.locator('a[href^="mailto:hello@ncrypt.nz"]').first().click({ force: true });
  assert.ok((await events(page)).some((e) => e.name === "mailto_click"));
});

await check("booking embed: opening/loading it is not a lead", async () => {
  const page = await newPage();
  await page.goto(`${base}/`);
  await page.waitForSelector(".tidycal-embed iframe");
  await page.waitForTimeout(400);
  assert.ok(!(await events(page)).some((e) => e.name === "generate_lead"));
});

await check("simulated bookingComplete from tidycal.com iframe -> one generate_lead", async () => {
  const page = await newPage();
  await page.goto(`${base}/?utm_source=acceptance`);
  const f = page.frameLocator(".tidycal-embed iframe");
  await f.locator("#bad").click();
  await page.waitForTimeout(200);
  assert.equal((await events(page)).filter((e) => e.name === "generate_lead").length, 0, "malformed payload counted");
  await f.locator("#book").click();
  await f.locator("#book").click();
  await page.waitForFunction(() => (window.dataLayer || []).some((a) => a[1] === "generate_lead"), null, { timeout: 3000 });
  const leads = (await events(page)).filter((e) => e.name === "generate_lead");
  assert.equal(leads.length, 1);
  assert.equal(leads[0].booking_id, "4242");
  assert.equal(leads[0].utm_source, "acceptance");
});

await check("bookingComplete posted by the page itself (wrong origin/source) is ignored", async () => {
  const page = await newPage();
  await page.goto(`${base}/`);
  await page.evaluate(() => window.postMessage({ event: "bookingComplete", data: { booking: { id: 1 } } }, "*"));
  await page.waitForTimeout(300);
  assert.ok(!(await events(page)).some((e) => e.name === "generate_lead"));
});

await check("TidyCal blocked -> email fallback appears, no page errors", async () => {
  const page = await newPage({ tidycal: "block" });
  await page.goto(`${base}/`);
  const fb = page.locator("#booking-fallback");
  await fb.waitFor({ state: "visible", timeout: 12000 });
  assert.match(await fb.innerHTML(), /mailto:hello@ncrypt\.nz/);
  assert.ok((await events(page)).some((e) => e.name === "booking_load_failed"));
  assert.deepEqual(page.errors, []);
});

await check("analytics + Tracer blocked: page works, no errors", async () => {
  const page = await newPage();
  await page.goto(`${base}/`);
  await page.evaluate(() => { window.gtag = undefined; });
  await page.locator("#booking").scrollIntoViewIfNeeded();
  assert.deepEqual(page.errors, []);
});

await browser.close();
server.close();
for (const [n, r] of results) console.log(`${r === "PASS" ? "PASS" : "FAIL"}  ${n}${r === "PASS" ? "" : "  -> " + r}`);
const failed = results.filter(([, r]) => r !== "PASS").length;
console.log(`${results.length - failed}/${results.length} browser checks passed.`);
process.exit(failed ? 1 : 0);
