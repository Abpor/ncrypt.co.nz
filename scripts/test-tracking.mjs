#!/usr/bin/env node
// Payload tests: runs assets/site.js against a stub window/document.
// Not browser acceptance, and TidyCal messages are simulated, not produced by TidyCal.
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import assert from "node:assert/strict";

const source = await readFile(new URL("../assets/site.js", import.meta.url), "utf8");
const TC = "https://tidycal.com";

function run({ url = "https://ncrypt.nz/", storage = {}, storageThrows = false, gtag = true, embed = true, frame = true } = {}) {
  const events = [];
  const clickL = [];
  const msgL = [];
  const timers = [];
  const store = { ...storage };
  const { pathname, search } = new URL(url);
  const contentWindow = {};
  const fallback = { hidden: true };
  const tidycal = { querySelector: (s) => (s === "iframe" && frame ? { contentWindow } : null) };
  const document = {
    addEventListener: (t, f) => t === "click" && clickL.push(f),
    querySelector: (s) => (s === ".tidycal-embed" && embed ? tidycal : null),
    getElementById: (id) => (id === "booking-fallback" ? fallback : null)
  };
  const window = {
    location: { pathname, search },
    sessionStorage: {
      getItem: (k) => { if (storageThrows) throw new Error("blocked"); return store[k] ?? null; },
      setItem: (k, v) => { if (storageThrows) throw new Error("blocked"); store[k] = v; }
    },
    addEventListener: (t, f) => t === "message" && msgL.push(f)
  };
  if (gtag) window.gtag = (kind, name, params) => events.push({ name, params });
  const ctx = vm.createContext({ window, document, URLSearchParams, Object, JSON, String, setTimeout: (f, ms) => timers.push({ f, ms }) });
  vm.runInContext(source, ctx);
  return {
    events, store, window, fallback, timers, contentWindow,
    click: (target) => clickL.forEach((f) => f({ target })),
    message: (m) => msgL.forEach((f) => f(m))
  };
}
const el = (sel, attrs, text) => ({ closest: (s) => (s === sel ? { getAttribute: (k) => attrs[k] ?? null, href: attrs.href, textContent: text } : null) });
const booked = (id, extra = {}) => ({ event: "bookingComplete", data: { booking: { id, booking_type_id: 7, ...extra } } });

// 1. cta_click + UTM payload
{
  const t = run({ url: "https://ncrypt.nz/?utm_source=li&utm_campaign=q4" });
  t.click(el("[data-track]", { href: "#booking", "data-track": "audit_cta_clicked" }, " Book Free Audit "));
  assert.deepEqual(t.events.map((e) => e.name), ["audit_cta_clicked", "cta_click"]);
  assert.equal(t.events[1].params.utm_source, "li");
  assert.equal(t.events[1].params.label, "Book Free Audit");
  assert.equal(t.events[1].params.destination, "#booking");
}

// 2. mailto_click keeps first-touch attribution from an earlier page
{
  const t = run({ storage: { ncrypt_attribution: JSON.stringify({ landing_path: "/tools/", utm_source: "yt" }) } });
  t.click(el('a[href^="mailto:"]', { href: "mailto:hello@ncrypt.nz" }, "Email"));
  assert.equal(t.events[0].name, "mailto_click");
  assert.equal(t.events[0].params.utm_source, "yt");
  assert.equal(t.events[0].params.landing_path, "/tools/");
}

// 3. TidyCal bookingComplete: valid message counts once per booking id
{
  const t = run({ url: "https://ncrypt.nz/?utm_source=li" });
  const ok = (m) => ({ origin: TC, source: t.contentWindow, data: m });
  t.message(ok(booked(101)));
  t.message(ok(booked(101)));
  t.message(ok(booked("102")));
  const leads = t.events.filter((e) => e.name === "generate_lead");
  assert.equal(leads.length, 2);
  assert.equal(leads[0].params.method, "tidycal_embed");
  assert.equal(leads[0].params.booking_id, "101");
  assert.equal(leads[0].params.booking_type_id, "7");
  assert.equal(leads[0].params.utm_source, "li");
}

// 4. Rejected: wrong origin, wrong source, wrong event, malformed payloads, no iframe
{
  const t = run();
  const good = booked(5);
  t.message({ origin: "https://evil.example", source: t.contentWindow, data: good });
  t.message({ origin: TC + ".evil.example", source: t.contentWindow, data: good });
  t.message({ origin: TC, source: {}, data: good });
  t.message({ origin: TC, source: t.contentWindow, data: { event: "other", data: good.data } });
  t.message({ origin: TC, source: t.contentWindow, data: "bookingComplete" });
  t.message({ origin: TC, source: t.contentWindow, data: null });
  t.message({ origin: TC, source: t.contentWindow, data: { event: "bookingComplete" } });
  t.message({ origin: TC, source: t.contentWindow, data: booked({}) });
  t.message({ origin: TC, source: t.contentWindow, data: booked("") });
  t.message({ origin: TC, source: t.contentWindow, data: { event: "bookingComplete", data: { booking: "x" } } });
  assert.equal(t.events.length, 0);
  const noFrame = run({ frame: false });
  noFrame.message({ origin: TC, source: noFrame.contentWindow, data: good });
  assert.equal(noFrame.events.length, 0);
}

// 5. Failure isolation
{
  const t = run({ gtag: false, storageThrows: true });
  t.click(el("[data-track]", { href: "#booking", "data-track": "x" }, "Go"));
  t.message({ origin: TC, source: t.contentWindow, data: booked(9) });
  const thrower = run();
  thrower.window.gtag = () => { throw new Error("boom"); };
  thrower.click(el("[data-track]", { href: "#booking", "data-track": "x" }, "Go"));
  thrower.message({ origin: TC, source: thrower.contentWindow, data: booked(9) });
}

// 6. Booking fallback is revealed only when no iframe rendered
{
  const bad = run({ frame: false });
  bad.timers.find((x) => x.ms === 8000).f();
  assert.equal(bad.fallback.hidden, false);
  assert.deepEqual(bad.events.map((e) => e.name), ["booking_load_failed"]);
  const good = run();
  good.timers.find((x) => x.ms === 8000).f();
  assert.equal(good.fallback.hidden, true);
}

console.log("Tracking payload tests passed: 6 groups.");
