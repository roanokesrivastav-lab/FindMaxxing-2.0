// Automated accessibility check: axe-core over the main flows in demo mode, at
// 390×844. Fails (exit 1) on any serious or critical violation; prints the
// moderate and minor ones as warnings.
//
//   npm run build && npm run a11y
//
// Starts its own fresh demo server (see scripts/lib/demo-server.mjs), or tests
// A11Y_BASE_URL if set. axe catches what can be checked mechanically (names,
// roles, contrast, labels); keyboard and focus behaviour are checked here too
// for the save sheet, and in scripts/e2e.mjs.
import { chromium } from "playwright-core";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { hydrated, launchOptions, startDemoServer } from "./lib/demo-server.mjs";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const OUT = process.env.A11Y_OUT ?? ".data/a11y";
mkdirSync(OUT, { recursive: true });

let server = null;
const base = process.env.A11Y_BASE_URL ?? (server = await startDemoServer({ port: Number(process.env.A11Y_PORT ?? 3211) })).base;
const browser = await chromium.launch(launchOptions());

const sid = (label) => {
  // Seed ids are deterministic (src/lib/seed/seed-data.ts stableId).
  const { createHash } = require("node:crypto");
  const h = createHash("sha256").update(`findmaxxing:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const PLACE = `/places/${sid("place:Meeple Cellar")}`;

async function context(email) {
  // Reduced motion also means axe never samples a sheet halfway through its slide-in.
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  const page = await ctx.newPage();
  if (email) {
    await page.goto(`${base}/auth/sign-in`, { waitUntil: "domcontentloaded" });
    await hydrated(page, "#email");
    await page.fill("#email", email);
    await page.fill("#password", "findmaxxing");
    await page.getByRole("button", { name: /^Sign in$/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/auth"), { timeout: 30_000 });
  }
  return { ctx, page };
}

async function audit(page, name) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async () => {
    // Map tiles are third-party canvas content; their attribution control is checked.
    return await window.axe.run(document, { exclude: [[".maplibregl-canvas"], [".mapboxgl-canvas"]], resultTypes: ["violations"] });
  });
  return result.violations.map((v) => ({
    page: name,
    id: v.id,
    impact: v.impact,
    help: v.help,
    nodes: v.nodes.slice(0, 3).map((n) => n.target.join(" ")),
    // For contrast failures: the measured colours, so a fix can target the token.
    colors: v.id === "color-contrast"
      ? [...new Set(v.nodes.map((n) => { const d = n.any?.[0]?.data; return d ? `${d.fgColor} on ${d.bgColor} = ${d.contrastRatio}:1  ${n.target.join(" ")}` : null; }).filter(Boolean))]
      : undefined,
  }));
}

const pages = [
  { name: "explore", path: "/", user: null, ready: ".maplibregl-marker button, .mapboxgl-marker button" },
  { name: "place detail", path: PLACE, user: null, ready: "h1" },
  { name: "sign in", path: "/auth/sign-in", user: null, ready: "#email" },
  { name: "sign up", path: "/auth/sign-up", user: null, ready: "#email" },
  { name: "forgot password", path: "/auth/forgot", user: null, ready: "#email" },
  { name: "events", path: "/events", user: null, ready: "h1" },
  { name: "place detail (signed in)", path: PLACE, user: "maya@example.com", ready: "h1" },
  {
    name: "save sheet",
    path: PLACE,
    user: "maya@example.com",
    ready: "h1",
    act: async (page) => {
      await page.getByRole("button", { name: /^Save$|Saved. Organize into lists/ }).first().click();
      await page.getByRole("dialog", { name: "Save to" }).waitFor();
    },
  },
  {
    name: "report sheet",
    path: PLACE,
    user: "maya@example.com",
    ready: "h1",
    act: async (page) => {
      await page.getByRole("button", { name: /^Report$/ }).click();
      await page.getByRole("dialog", { name: "Report this listing" }).waitFor();
    },
  },
  { name: "saved", path: "/saved", user: "maya@example.com", ready: "h1" },
  { name: "add a place", path: "/places/new", user: "maya@example.com", ready: "#name" },
  { name: "create an event", path: "/events/new", user: "maya@example.com", ready: "#title" },
  { name: "profile", path: "/profile", user: "maya@example.com", ready: "h1" },
  { name: "settings", path: "/profile/settings", user: "maya@example.com", ready: "h1" },
  { name: "moderation queue", path: "/moderation", user: "sam@example.com", ready: "h1" },
];

const all = [];
const sessions = new Map();
for (const p of pages) {
  const key = p.user ?? "anon";
  if (!sessions.has(key)) sessions.set(key, await context(p.user));
  const { page } = sessions.get(key);
  await page.goto(`${base}${p.path}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(p.ready, { timeout: 30_000 });
  await hydrated(page, "body *[class]").catch(() => undefined);
  await page.waitForTimeout(600);
  if (p.act) await p.act(page);
  const violations = await audit(page, p.name);
  all.push(...violations);
  await page.screenshot({ path: `${OUT}/${p.name.replace(/\W+/g, "-")}.png` });
  console.log(`${violations.some((v) => v.impact === "serious" || v.impact === "critical") ? "FAIL" : "ok  "}  ${p.name}  (${violations.length} issue${violations.length === 1 ? "" : "s"})`);
}

// Keyboard: the save sheet traps focus and gives it back.
{
  const { page } = sessions.get("maya@example.com");
  await page.goto(`${base}${PLACE}`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "h1");
  const opener = page.getByRole("button", { name: /^Save$|Saved. Organize into lists/ }).first();
  await opener.focus();
  await page.keyboard.press("Enter");
  await page.getByRole("dialog", { name: "Save to" }).waitFor();
  let inside = true;
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press("Tab");
    inside &&= await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
  }
  await page.keyboard.press("Escape");
  const back = await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? "");
  const keyboardOk = inside && /Save/.test(back);
  console.log(`${keyboardOk ? "ok  " : "FAIL"}  keyboard: Tab stays in the sheet, Escape returns focus to the opener (${back})`);
  if (!keyboardOk) all.push({ page: "save sheet", id: "focus-management", impact: "serious", help: "Sheet focus trap or return failed", nodes: [] });
}

for (const { ctx } of sessions.values()) await ctx.close();
await browser.close();
if (server) await server.stop();

writeFileSync(`${OUT}/violations.json`, JSON.stringify(all, null, 2));
const blocking = all.filter((v) => v.impact === "serious" || v.impact === "critical");
for (const v of all) {
  console.log(`  ${v.impact === "serious" || v.impact === "critical" ? "✗" : "·"} [${v.impact}] ${v.page}: ${v.id} — ${v.help}${v.nodes.length ? `\n      ${v.nodes.join("\n      ")}` : ""}`);
}
console.log(`\n${pages.length} pages: ${blocking.length} serious/critical, ${all.length - blocking.length} other`);
process.exit(blocking.length ? 1 : 0);
