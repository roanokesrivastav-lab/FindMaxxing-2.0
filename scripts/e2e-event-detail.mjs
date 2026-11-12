// Event detail browser checks (roadmap 4.1), in a real browser at 390×844
// against a fresh demo server with tickets switched on (demo checkout only; no
// billing or hosted service is reached).
//
//   npm run build && npm run e2e:event-detail
//
// Covers: the editorial reading order, date and time as text with the zone,
// a free event joined and then full for the next person, a priced event that
// never says "free" (buyer and signed-out reader), the one action staying in
// reach above the navigation, 200% text by keyboard and by touch, desktop
// width, and axe on each state. Exits non-zero on any failed check;
// screenshots go to EVENT_DETAIL_E2E_OUT.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { hydrated, launchOptions, startDemoServer } from "./lib/demo-server.mjs";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const out = process.env.EVENT_DETAIL_E2E_OUT ?? ".data/e2e-event-detail";
mkdirSync(out, { recursive: true });
const server = await startDemoServer({ port: Number(process.env.EVENT_DETAIL_E2E_PORT ?? 3214), env: {
  NEXT_PUBLIC_FEATURES: "payments",
  STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "",
  POSTHOG_KEY: "", PLAUSIBLE_DOMAIN: "", ANALYTICS_FORWARD_SECRET: "", SENTRY_DSN: "",
} });
const PHONE = { width: 390, height: 844 };
const run = Date.now().toString(36);

let browser;
const results = [], errors = [], contexts = [];
let shots = 0;
async function step(name, fn) {
  try { await fn(); results.push({ name, pass: true }); console.log(`PASS  ${name}`); }
  catch (err) { results.push({ name, pass: false }); console.error(`FAIL  ${name}: ${err.message.split("\n")[0]}`); }
}
async function snap(page, label, fullPage = false) { await page.screenshot({ path: `${out}/${String(++shots).padStart(2, "0")}-${label}.png`, fullPage }); }

async function person(email, contextOptions = {}) {
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, reducedMotion: "reduce", ...contextOptions });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to|Minified React error|[Hh]ydrat/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  if (email) {
    await page.goto(`${server.base}/auth/sign-in`, { waitUntil: "domcontentloaded" });
    await hydrated(page, "#email");
    await page.fill("#email", email);
    await page.fill("#password", "findmaxxing");
    await page.getByRole("button", { name: /^Sign in$/ }).click();
    await page.waitForURL((u) => !u.pathname.startsWith("/auth"));
  }
  return page;
}
async function visit(page, path) {
  const res = await page.goto(`${server.base}${path}`, { waitUntil: "domcontentloaded" });
  assert.equal(res?.status(), 200, `${path} answered ${res?.status()}`);
  await hydrated(page, "[data-part='action']");
  // While a streamed page settles, the article can briefly be in the document twice.
  await page.waitForFunction(() => document.querySelectorAll("[data-event-detail]").length === 1);
}
/** The host creates an event through the real form; returns its path. */
async function createEvent(host, title, { capacity } = {}) {
  await host.goto(`${server.base}/events/new`, { waitUntil: "domcontentloaded" });
  await hydrated(host, "#title");
  await host.fill("#title", title);
  await host.getByRole("button", { name: /Pickup sports/ }).first().click();
  await host.fill("#description", "Easy games on the north pitch. Bring water and a light and a dark shirt.");
  await host.fill("#locationName", "North pitch, by the blue gate");
  if (capacity) await host.fill("#capacity", String(capacity));
  const map = host.locator(".maplibregl-map, .mapboxgl-map").first();
  await map.waitFor({ timeout: 30_000 });
  await host.waitForTimeout(1500);
  const box = await map.boundingBox();
  await host.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await host.waitForTimeout(400);
  await host.getByRole("button", { name: /Create event/ }).click();
  await host.waitForURL("**/events/*?new=1", { timeout: 30_000 });
  return new URL(host.url()).pathname;
}
const detail = (page) => page.locator("[data-event-detail]");
const action = (page) => page.locator("[data-part='action']");
const detailText = async (page) => (await detail(page).innerText()).replace(/\s+/g, " ");
async function audit(page) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async () => await window.axe.run({ exclude: [[".maplibregl-canvas"], [".mapboxgl-canvas"]] }, { resultTypes: ["violations"], rules: { "target-size": { enabled: true } } }));
  return result.violations.map((v) => `${v.impact}:${v.id} ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
}
function assertClean(violations, label) { assert.equal(violations.length, 0, `${label}: ${violations.join("; ")}`); }
async function textSize(page, percent) {
  await page.evaluate((p) => {
    let tag = document.getElementById("e2e-text-size");
    if (!tag) { tag = document.createElement("style"); tag.id = "e2e-text-size"; document.head.append(tag); }
    tag.textContent = `html{font-size:${p}% !important}`;
  }, percent);
  await page.waitForTimeout(250);
}
/** Where the action block and the bottom navigation are, and whether the block is on screen clear of it. */
const actionLayout = (page) => page.evaluate(() => {
  const box = (el) => { const r = el.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right) }; };
  const act = box(document.querySelector("[data-part='action']"));
  const navEl = Array.from(document.querySelectorAll("nav")).filter((n) => getComputedStyle(n).position === "fixed" && n.getBoundingClientRect().height > 0).at(-1);
  const nav = navEl ? box(navEl) : null;
  return { act, nav, inView: act.top >= 0 && act.bottom <= window.innerHeight, clearOfNav: !nav || act.bottom <= nav.top, scroll: document.documentElement.scrollWidth };
});
/** Wholly in the window and the topmost thing at its centre. */
const usable = (locator) => locator.evaluate((el) => {
  const r = el.getBoundingClientRect();
  const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
  return { inWindow: r.left >= 0 && r.right <= document.documentElement.clientWidth && r.top >= 0 && r.bottom <= window.innerHeight, onTop: !!top && (top === el || el.contains(top)), covering: top && !(top === el || el.contains(top)) ? `${top.closest("[data-part],nav")?.getAttribute("data-part") ?? ""} ${top.tagName}.${String(top.className).slice(0, 60)}` : null, box: [r.left, r.right, r.top, r.bottom].map(Math.round) };
});
async function assertUsable(locator, label) {
  const u = await usable(locator);
  assert.ok(u.inWindow && u.onTop, `${label} cannot be used where it is: ${JSON.stringify(u)}`);
}

try {
  browser = await chromium.launch(launchOptions());
  const host = await person("dev@example.com");
  const guest = await person("maya@example.com");
  const third = await person("lena@example.com");
  let freePath, paidPath;

  await step("the page reads in the editorial order, with one title and the date and time as text with the zone", async () => {
    freePath = await createEvent(host, `Editorial pickup ${run}`, { capacity: 2 });
    await visit(host, freePath);
    const parts = await detail(host).locator("[data-part]").evaluateAll((els) => els.map((e) => e.getAttribute("data-part")));
    assert.deepEqual(parts, ["what", "when", "where", "host", "cost", "action"], "sections in reading order (no activity details on this event)");
    assert.equal(await detail(host).locator("h1").count(), 1);
    const when = (await detail(host).locator("[data-part='when']").innerText()).replace(/\s+/g, " ");
    assert.match(when, /When (Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), [A-Z][a-z]+ \d{1,2}/, `the date is written out: ${when}`);
    assert.match(when, /\d{1,2}:\d{2} [AP]M( – \d{1,2}:\d{2} [AP]M)? [A-Z]{2,5}/, `the time names its zone: ${when}`);
    assert.equal(await detail(host).locator("time, [data-date-block]").count(), 0, "no calendar date block");
    assert.match(await detailText(host), /You're hosting/);
    await snap(host, "host-view");
    assertClean(await audit(host), "axe: event page as the host");
  });

  await step("a free event: says Free with spots left, the action is in reach above the navigation, and joining works", async () => {
    await visit(guest, freePath);
    const text = await detailText(guest);
    assert.match(text, /Cost and spots Free 1 going · 1 of 2 spots left/);
    assert.match(text, /Join so the host knows you're coming\./);
    const layout = await actionLayout(guest);
    assert.ok(layout.inView && layout.clearOfNav, `the action is not in reach on arrival: ${JSON.stringify(layout)}`);
    assert.equal(await action(guest).getByRole("button").count(), 1, "exactly one action");
    const join = action(guest).getByRole("button", { name: "Join event", exact: true });
    await assertUsable(join, "Join event");
    await snap(guest, "free-open");
    assertClean(await audit(guest), "axe: free event, not joined");
    await join.click();
    await action(guest).getByRole("button", { name: /You're going/ }).waitFor();
    await visit(guest, freePath);
    const after = await detailText(guest);
    assert.match(after, /2 going · Full/);
    assert.match(await action(guest).innerText(), /You're going/);
    await snap(guest, "free-joined");
  });

  await step("the next person finds it Full: the action is off, the server refuses, and nothing offers a waitlist", async () => {
    await visit(third, freePath);
    const text = await detailText(third);
    assert.match(text, /2 going · Full/);
    assert.match(text, /Every spot is taken\. One opens if someone leaves\./);
    assert.doesNotMatch(text, /wait ?list|notify me|offer/i);
    const full = action(third).getByRole("button", { name: "Event full", exact: true });
    assert.equal(await full.isDisabled(), true, "the join action is off");
    assert.equal(await action(third).getByRole("button").count(), 1);
    await snap(third, "free-full");
    assertClean(await audit(third), "axe: full event");
    // The seat count on the host's copy is unchanged by the third person's visit.
    await visit(host, freePath);
    assert.match(await detailText(host), /2 going · Full/);
  });

  await step("a priced event shows its price and never says free, to a buyer and to a signed-out reader", async () => {
    paidPath = await createEvent(host, `Ticketed scrimmage ${run}`, { capacity: 6 });
    await host.locator("#ticket-price").fill("15");
    await host.getByRole("button", { name: "Save price" }).click();
    await host.getByText("Tickets are $15.00", { exact: true }).waitFor();
    await visit(guest, paidPath);
    let text = await detailText(guest);
    assert.match(text, /Cost and spots \$15\.00 per ticket 1 going · 5 of 6 spots left/);
    assert.doesNotMatch(text, /\bfree\b/i, "a priced event must not say free");
    assert.equal(await action(guest).getByRole("button").count(), 1);
    await assertUsable(action(guest).getByRole("button", { name: /Buy ticket · \$15\.00/ }), "Buy ticket");
    await snap(guest, "paid-buyer");
    assertClean(await audit(guest), "axe: priced event as a buyer");
    const anon = await person(null);
    await visit(anon, paidPath);
    text = await detailText(anon);
    assert.match(text, /\$15\.00 per ticket/);
    assert.doesNotMatch(text, /\bfree\b/i);
    assertClean(await audit(anon), "axe: priced event signed out");
  });

  await step("200% text: nothing runs off the side, and by keyboard every link before the action is reached uncovered", async () => {
    const page = await person("lena@example.com");
    await visit(page, paidPath);
    await textSize(page, 200);
    const layout = await actionLayout(page);
    assert.ok(layout.scroll <= PHONE.width, `page is ${layout.scroll}px wide at 200% text`);
    // At this size the action does not ride at the foot of the screen: it would cover most of the page.
    assert.ok(layout.act.top >= PHONE.height, `the action block is docked over the page at 200% text: ${JSON.stringify(layout)}`);
    await snap(page, "large-text-top");
    // Tab from the top. Each stop inside the article must be wholly visible and not under the action block.
    const stops = [];
    await page.locator("body").press("Tab");
    for (let i = 0; i < 60; i++) {
      const f = await page.evaluate(() => {
        const el = document.activeElement;
        // The map library's own attribution control is skipped: it redraws while tiles load, and it is not this page's.
        return { inDetail: !!el?.closest("[data-event-detail]") && !el?.closest(".maplibregl-ctrl, .mapboxgl-ctrl"), inAction: !!el?.closest("[data-part='action']"), name: (el?.getAttribute("aria-label") ?? el?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 40), ring: !!el && (getComputedStyle(el).outlineStyle !== "none" || getComputedStyle(el).boxShadow !== "none") };
      });
      if (f.inDetail) {
        await assertUsable(page.locator(":focus"), `focused "${f.name}"`);
        // An outline, or the ring the map pin draws with a shadow.
        assert.ok(f.ring, `"${f.name}" shows no focus indicator`);
        stops.push(f.name);
        if (f.inAction) break;
      }
      await page.keyboard.press("Tab");
    }
    assert.ok(stops.length >= 5, `keyboard stops before the action: ${stops.join(" | ")}`);
    assert.ok(stops.some((s) => /Directions/.test(s)), "Directions is a keyboard stop");
    assert.match(stops.at(-1), /Buy ticket/, `the last stop is the action: ${stops.at(-1)}`);
    await snap(page, "large-text-action-focused");
    assertClean(await audit(page), "axe: priced event at 200% text");
  });

  await step("200% text, touch: the action is tapped where it sits and starts the demo checkout", async () => {
    const page = await person("lena@example.com");
    await visit(page, paidPath);
    await textSize(page, 200);
    const buy = action(page).getByRole("button", { name: /Buy ticket/ });
    // A finger scrolls down to it: it is in its place in the page, clear of the navigation.
    await buy.scrollIntoViewIfNeeded();
    await assertUsable(buy, "Buy ticket at 200% text");
    assert.ok((await actionLayout(page)).clearOfNav, "the action is clear of the navigation once scrolled to");
    const box = await buy.boundingBox();
    await Promise.all([page.waitForURL("**/checkout/demo?ticket=*"), page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)]);
    // Leaving the demo checkout admits nobody.
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.waitForURL(`**${paidPath}`);
    await hydrated(page, "[data-part='action']");
    await page.waitForFunction(() => document.querySelectorAll("[data-event-detail]").length === 1);
    assert.match(await detailText(page), /1 going/);
  });

  await step("normal text, keyboard: every stop above the action is scrolled clear of the docked block", async () => {
    const page = await person("lena@example.com");
    await visit(page, paidPath);
    assert.ok((await actionLayout(page)).inView, "the action is docked in view at normal text size");
    await page.locator("body").press("Tab");
    let checked = 0;
    for (let i = 0; i < 60; i++) {
      const f = await page.evaluate(() => ({ inDetail: !!document.activeElement?.closest("[data-event-detail]") && !document.activeElement?.closest(".maplibregl-ctrl, .mapboxgl-ctrl"), inAction: !!document.activeElement?.closest("[data-part='action']"), name: (document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "").trim().slice(0, 40) }));
      if (f.inDetail) {
        await assertUsable(page.locator(":focus"), `focused "${f.name}"`);
        checked++;
        if (f.inAction) break;
      }
      await page.keyboard.press("Tab");
    }
    assert.ok(checked >= 5, `only ${checked} keyboard stops were checked`);
  });

  await step("desktop width: the same order, the action inside the window", async () => {
    const page = await person("maya@example.com", { viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
    await visit(page, paidPath);
    const parts = await detail(page).locator("[data-part]").evaluateAll((els) => els.map((e) => e.getAttribute("data-part")));
    assert.deepEqual(parts, ["what", "when", "where", "host", "cost", "action"]);
    const layout = await actionLayout(page);
    assert.ok(layout.inView && layout.scroll <= 1280, `desktop layout: ${JSON.stringify(layout)}`);
    await snap(page, "desktop");
    assertClean(await audit(page), "axe: event page at desktop width");
  });

  await step("no browser page, hydration or CSP errors", async () => assert.deepEqual(errors, []));
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser?.close();
  await server.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} event detail checks passed; screenshots in ${out}`);
process.exitCode = failed.length ? 1 : 0;
