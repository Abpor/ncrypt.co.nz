#!/usr/bin/env node
// Static site checks. Run from the repo root: node scripts/check-site.mjs
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const origin = "https://ncrypt.nz";
// Served by a separate Cloudflare project, not present in this repo.
const externalRoutes = new Set(["/tools/ai-cost-calculator/"]);
const skipDirs = new Set([".git", "_archive", "node_modules", "scripts"]);
const errors = [];

async function walk(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (skipDirs.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else files.push(full);
  }
  return files;
}

const first = (html, re) => (html.match(re) || [])[1]?.trim() ?? "";

function localTarget(from, raw) {
  const value = raw.trim();
  if (!value || value.startsWith("#") || /^(?:mailto:|tel:|data:|javascript:|https?:|\/\/)/i.test(value)) return null;
  const clean = decodeURIComponent(value.split("#")[0].split("?")[0]);
  if (!clean) return null;
  const route = clean.startsWith("/") ? clean : null;
  if (route && externalRoutes.has(route.endsWith("/") ? route : route + "/")) return null;
  return clean.startsWith("/") ? path.join(root, clean.slice(1)) : path.resolve(path.dirname(from), clean);
}

async function resolves(target) {
  try {
    const info = await stat(target);
    if (info.isFile()) return true;
    return (await stat(path.join(target, "index.html"))).isFile();
  } catch {
    return false;
  }
}

const pages = (await walk(root)).filter((f) => path.basename(f) === "index.html");
const sitemap = await readFile(path.join(root, "sitemap.xml"), "utf8");
const sitemapUrls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
const sitemapSet = new Set(sitemapUrls);

for (const banned of ["n8n-automation", "migrations", "creative-studios"]) {
  if (pages.some((f) => path.relative(root, f).startsWith(banned + path.sep))) errors.push(`out-of-scope route /${banned}/ present`);
}

for (const file of pages) {
  const rel = path.relative(root, file);
  const route = rel === "index.html" ? "/" : `/${rel.replace(/index\.html$/, "")}`;
  const html = await readFile(file, "utf8");
  const redirectStub = /<meta\s+http-equiv=["']refresh["']/i.test(html);

  if (!redirectStub) {
    const canonical = first(html, /<link\s+rel=["']canonical["']\s+href=["']([^"']+)["']/i);
    if (canonical !== origin + route) errors.push(`${rel}: canonical ${canonical || "(none)"} != ${origin + route}`);
    if (!sitemapSet.has(origin + route)) errors.push(`${rel}: missing from sitemap.xml`);
  }
  for (const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { JSON.parse(m[1]); } catch (e) { errors.push(`${rel}: JSON-LD invalid (${e.message})`); }
  }
  for (const m of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/gi)) {
    const target = localTarget(file, m[1]);
    if (target && !await resolves(target)) errors.push(`${rel}: unresolved reference ${m[1]}`);
  }
  // Every Tracer constructor call must sit behind a typeof guard.
  for (const m of html.matchAll(/new Tracer\(/g)) {
    const before = html.slice(Math.max(0, m.index - 200), m.index);
    if (!/typeof Tracer\s*[!=]==\s*["']function["']/.test(before)) errors.push(`${rel}: unguarded Tracer`);
  }
}

for (const url of sitemapUrls) {
  if (!url.startsWith(origin + "/")) { errors.push(`sitemap.xml: unexpected origin ${url}`); continue; }
  const p = new URL(url).pathname;
  if (externalRoutes.has(p)) continue;
  if (!await resolves(path.join(root, p === "/" ? "index.html" : p.slice(1)))) errors.push(`sitemap.xml: missing page ${url}`);
}

// Commercial surfaces that must survive this release.
const home = await readFile(path.join(root, "index.html"), "utf8");
for (const needle of ["NZ$995", "NZ$750", "Free Ops", "https://creatorops.nz/services/it-support-for-creative-studios/", "ncrypt/free-operations-audit"]) {
  if (!home.includes(needle)) errors.push(`index.html: missing ${needle}`);
}
const proof = await readFile(path.join(root, "policyproof/index.html"), "utf8");
for (const needle of ["NZ$59", "NZ$149"]) if (!proof.includes(needle)) errors.push(`policyproof/index.html: missing ${needle}`);

if (errors.length) {
  console.error(`Site validation failed with ${errors.length} error(s):`);
  errors.forEach((e) => console.error(`- ${e}`));
  process.exit(1);
}
console.log(`Site validation passed: ${pages.length} pages, ${sitemapUrls.length} sitemap URLs.`);
