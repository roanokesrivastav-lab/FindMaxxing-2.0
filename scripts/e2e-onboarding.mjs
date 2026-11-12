// Onboarding and first-map browser checks (roadmap 1.2 and 1.3), in a real
// browser at 390×844 against a fresh demo server. Each case signs up its own
// newcomer and goes through the real picker, save actions and Explore page.
//
//   npm run build && npm run e2e:onboarding
//
// Covers: zero and maximum choices, skip, keyboard-only use, coming back to the
// step, returning users, 200% text, and axe on each picker state; then the
// first map: removable interests, Show everything, no nearby matches, a refused
// location prompt, the one widening, list mode and desktop width. Exits
// non-zero on any failed check; screenshots go to ONBOARDING_E2E_OUT.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { hydrated, launchOptions, startDemoServer } from "./lib/demo-server.mjs";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const out = process.env.ONBOARDING_E2E_OUT ?? ".data/e2e-onboarding";
mkdirSync(out, { recursive: true });
const server = await startDemoServer({ port: Number(process.env.ONBOARDING_E2E_PORT ?? 3213) });
const MAX = 12;
const VIEWPORT = { width: 390, height: 844 };

let browser;
const results = [], errors = [], contexts = [];
let shots = 0, people = 0;
const run = Date.now().toString(36);

async function step(name, fn) {
  try { await fn(); results.push({ name, pass: true }); console.log(`PASS  ${name}`); }
  catch (err) { results.push({ name, pass: false }); console.error(`FAIL  ${name}: ${err.message.split("\n")[0]}`); }
}
async function snap(page, label, fullPage = false) { await page.screenshot({ path: `${out}/${String(++shots).padStart(2, "0")}-${label}.png`, fullPage }); }

/** A fresh account, signed up and waiting on the interests step. */
async function newcomer(contextOptions = {}) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, reducedMotion: "reduce", ...contextOptions });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to|Minified React error|[Hh]ydrat/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  // Every pin query the map sends, so a test can compare the area before and after a widening.
  page.pinQueries = [];
  page.on("request", (r) => { if (r.url().includes("/api/discover/map")) page.pinQueries.push(new URL(r.url()).searchParams); });
  const tag = `ob${run}${++people}`;
  await page.goto(`${server.base}/auth/sign-up`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "#email");
  await page.fill("#displayName", "Onboarding Tester");
  await page.fill("#username", tag);
  await page.fill("#email", `${tag}@example.test`);
  await page.fill("#password", "onboarding-e2e-1");
  await page.getByRole("button", { name: /^Create account$/ }).click();
  await page.waitForURL("**/welcome");
  await hydrated(page, '[role="checkbox"]');
  return page;
}
const boxes = (page) => page.getByRole("checkbox");
const checked = (page) => page.getByRole("checkbox", { checked: true });
const openMore = (page) => page.getByRole("button", { name: /^More interests/ }).click();
const forward = (page) => page.getByRole("button", { name: "Continue to home city", exact: true });

/** From the home-city step: skip the rest and land on the map. Returns the landing URL. */
async function finishFromHomeCity(page) {
  await page.getByRole("heading", { name: "Where's home?" }).waitFor();
  await page.getByRole("button", { name: "Skip", exact: true }).click();
  await page.getByRole("button", { name: "Not now", exact: true }).click();
  await page.getByRole("button", { name: "Go to the map", exact: true }).click();
  await page.waitForURL((u) => u.pathname === "/" && u.searchParams.get("welcome") === "1");
  return new URL(page.url());
}
async function audit(page) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async () => await window.axe.run(document, { resultTypes: ["violations"], rules: { "target-size": { enabled: true } } }));
  return result.violations.map((v) => `${v.impact}:${v.id} ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
}
/** The first-arrival strip that is on screen (the map's copy, or the list's in list mode). */
const strip = (page) => page.getByRole("region", { name: "Your first map" });
const removers = (page) => strip(page).getByRole("button", { name: /^Remove / });
const widen = (page) => strip(page).getByRole("button", { name: "Search a wider area", exact: true });
const pins = (page) => page.locator(".maplibregl-marker button[aria-label], .mapboxgl-marker button[aria-label]");
/** The next pin query the map sends, as its search parameters. */
const nextPinQuery = (page, when = () => true) =>
  page.waitForRequest((r) => r.url().includes("/api/discover/map") && when(new URL(r.url()).searchParams)).then((r) => new URL(r.url()).searchParams);
const bboxArea = (params) => {
  const [west, south, east, north] = (params.get("bbox") ?? "").split(",").map(Number);
  return (east - west) * (north - south);
};
async function auditMapPage(page) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async () => await window.axe.run({ exclude: [[".maplibregl-canvas"], [".mapboxgl-canvas"]] }, { resultTypes: ["violations"], rules: { "target-size": { enabled: true } } }));
  return result.violations.map((v) => `${v.impact}:${v.id} ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
}
/** Fails with the violations themselves in the message, so a failure says what to fix. */
function assertClean(violations, label) {
  assert.equal(violations.length, 0, `${label}: ${violations.join("; ")}`);
}
const active = (page) => page.evaluate(() => ({
  interest: document.activeElement?.getAttribute("data-interest") ?? null,
  text: document.activeElement?.textContent?.trim() ?? "",
  tag: document.activeElement?.tagName ?? "",
  outline: document.activeElement ? getComputedStyle(document.activeElement).outlineStyle : "none",
}));

try {
  browser = await chromium.launch(launchOptions());

  await step("the step shows six thumbnail rows, More interests, Skip and Continue to home city", async () => {
    const page = await newcomer();
    await page.getByRole("heading", { name: /What would you go out for\?/ }).waitFor();
    const visible = await page.locator('ul[aria-label="Interests"] [role="checkbox"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-interest")));
    assert.deepEqual(visible, ["pickup-sports", "coffee", "cheap-eats", "outdoors", "nightlife", "studying"]);
    assert.equal(await page.locator('ul[aria-label="Interests"] [data-thumb]').count(), 6, "every row has a thumbnail or its glyph");
    assert.equal(await checked(page).count(), 0);
    await page.getByRole("button", { name: /^More interests/ }).waitFor();
    await page.getByRole("button", { name: "Skip", exact: true }).waitFor();
    await forward(page).waitFor();
    assert.equal(await page.locator("#more-interests").isVisible(), false, "More interests starts closed");
    await snap(page, "picker-default");
    assertClean(await audit(page), "axe: default picker");
  });

  await step("zero choices: Continue works with nothing picked and the map opens unfiltered", async () => {
    const page = await newcomer();
    assert.equal(await forward(page).isEnabled(), true);
    await forward(page).click();
    const url = await finishFromHomeCity(page);
    assert.equal(url.searchParams.get("tags"), null);
    // First arrival without interests: it says the map shows everything and has no filter chips.
    await strip(page).waitFor();
    assert.match(await strip(page).innerText(), /The map is showing everything\./);
    assert.equal(await removers(page).count(), 0);
    assert.equal(await strip(page).getByRole("button", { name: "Show everything" }).count(), 0);
    await snap(page, "map-zero-interests");
    await strip(page).getByRole("button", { name: "Got it" }).click();
    assert.equal(await strip(page).count(), 0, "Got it dismisses the strip");
    // A later visit is not a first arrival.
    await page.goto(`${server.base}/`, { waitUntil: "domcontentloaded" });
    await pins(page).first().waitFor({ timeout: 30_000 });
    assert.equal(await strip(page).count(), 0, "a returning visit shows no first-arrival strip");
  });

  await step(`maximum choices: ${MAX} are accepted, the next is refused out loud, and the map link carries all ${MAX}`, async () => {
    const page = await newcomer();
    await openMore(page);
    const all = await boxes(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-interest")));
    assert.equal(all.length, 24);
    const picks = all.slice(0, MAX);
    for (const slug of picks) await page.locator(`[role="checkbox"][data-interest="${slug}"]`).click();
    assert.equal(await checked(page).count(), MAX);
    const limit = page.locator("#interest-limit");
    await limit.waitFor();
    assert.match(await limit.innerText(), /That’s 12, the most the map can use at once/);
    const extra = page.locator(`[role="checkbox"][data-interest="${all[MAX]}"]`);
    assert.equal(await extra.getAttribute("aria-disabled"), "true");
    assert.equal(await extra.getAttribute("aria-describedby"), "interest-limit");
    // A tap on an unavailable row changes nothing and is not silent: the limit line stays and is emphasised.
    await extra.click({ force: true });
    assert.equal(await checked(page).count(), MAX);
    assert.equal(await extra.getAttribute("aria-checked"), "false");
    assert.match(await limit.getAttribute("class"), /font-semibold/);
    await snap(page, "picker-at-limit", true);
    assertClean(await audit(page), "axe: picker at the limit");
    // Removing one frees a place.
    await page.locator(`[role="checkbox"][data-interest="${picks[0]}"]`).click();
    assert.equal(await extra.getAttribute("aria-disabled"), null);
    await extra.click();
    assert.equal(await checked(page).count(), MAX);
    const expected = [...picks.slice(1), all[MAX]];
    await forward(page).click();
    const url = await finishFromHomeCity(page);
    const tags = (url.searchParams.get("tags") ?? "").split(",");
    assert.deepEqual([...tags].sort(), [...expected].sort(), "the first map is asked for every accepted interest");
    assert.equal(tags.length, MAX);
    // All twelve are on the first map as removable filters, with Show everything beside them.
    await strip(page).waitFor();
    assert.equal(await removers(page).count(), MAX);
    await strip(page).getByRole("button", { name: "Show everything", exact: true }).waitFor();
    await snap(page, "map-twelve-interests");
    // Removing one filters by the other eleven, and only because it was tapped.
    const label = await removers(page).first().getAttribute("aria-label");
    const [eleven] = await Promise.all([nextPinQuery(page, (q) => (q.get("tags") ?? "").split(",").length === MAX - 1), removers(page).first().focus().then(() => page.keyboard.press("Enter"))]);
    assert.equal(await removers(page).count(), MAX - 1);
    assert.equal(await strip(page).getByRole("button", { name: label, exact: true }).count(), 0);
    assert.equal(eleven.get("tags").split(",").length, MAX - 1);
    // Show everything clears the interest filters.
    const [unfiltered] = await Promise.all([nextPinQuery(page, (q) => !q.get("tags")), strip(page).getByRole("button", { name: "Show everything", exact: true }).click()]);
    assert.equal(unfiltered.get("tags"), null);
    assert.equal(await removers(page).count(), 0);
    assert.match(await strip(page).innerText(), /The map is showing everything\./);
  });

  await step("skip: picks made before Skip are not saved, and the map opens unfiltered", async () => {
    const page = await newcomer();
    await page.getByRole("checkbox", { name: /^Coffee/ }).click();
    await page.getByRole("checkbox", { name: /^Nightlife/ }).click();
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    const url = await finishFromHomeCity(page);
    assert.equal(url.searchParams.get("tags"), null);
  });

  await step("keyboard only: rows, More interests and Continue all work, with a visible focus ring", async () => {
    const page = await newcomer();
    // The step heading takes focus; the first Tab stop after it is the first row.
    let a;
    for (let i = 0; i < 4 && (a = await active(page)).interest !== "pickup-sports"; i++) await page.keyboard.press("Tab");
    assert.equal(a.interest, "pickup-sports");
    assert.notEqual(a.outline, "none", "the focused row shows a focus ring");
    const first = page.locator('[role="checkbox"][data-interest="pickup-sports"]');
    await page.keyboard.press("Space");
    assert.equal(await first.getAttribute("aria-checked"), "true");
    await page.keyboard.press("Space");
    assert.equal(await first.getAttribute("aria-checked"), "false");
    await page.keyboard.press("Enter");
    assert.equal(await first.getAttribute("aria-checked"), "true");
    for (let i = 0; i < 6; i++) await page.keyboard.press("Tab");
    assert.match((await active(page)).text, /^More interests/);
    await page.keyboard.press("Enter");
    assert.equal(await page.locator("#more-interests").isVisible(), true);
    await page.keyboard.press("Tab");
    assert.equal((await active(page)).interest, "sports");
    await page.keyboard.press("Space");
    assert.equal(await page.locator('[role="checkbox"][data-interest="sports"]').getAttribute("aria-checked"), "true");
    await snap(page, "picker-more-open", true);
    assertClean(await audit(page), "axe: More interests open");
    for (let i = 0; i < 30 && (await active(page)).text !== "Continue to home city"; i++) await page.keyboard.press("Tab");
    assert.equal((await active(page)).text, "Continue to home city");
    await page.keyboard.press("Enter");
    await page.getByRole("heading", { name: "Where's home?" }).waitFor();
    assert.equal((await active(page)).tag, "H1", "focus moves to the next step's heading");

    // Coming back to the step: what was saved is checked, and More interests is open because one pick lives there.
    await page.goto(`${server.base}/welcome`, { waitUntil: "domcontentloaded" });
    await hydrated(page, '[role="checkbox"]');
    const saved = await checked(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-interest")).sort());
    assert.deepEqual(saved, ["pickup-sports", "sports"]);
    assert.equal(await page.getByRole("button", { name: /^More interests/ }).getAttribute("aria-expanded"), "true");

    // 200% text at phone width: nothing runs off the side, every row still fits.
    await page.addStyleTag({ content: "html{font-size:200% !important}" });
    await page.waitForTimeout(200);
    // The configured width, not window.innerWidth: a mobile viewport grows to fit content that is too wide.
    const fit = await page.evaluate(() => {
      const controls = [...document.querySelectorAll('[role="checkbox"], button, h1, p')].filter((e) => e.getClientRects().length);
      const widest = controls.reduce((a, b) => (a.getBoundingClientRect().right >= b.getBoundingClientRect().right ? a : b));
      return { scroll: document.documentElement.scrollWidth, right: Math.round(widest.getBoundingClientRect().right), which: widest.textContent.trim().slice(0, 40) };
    });
    assert.ok(fit.scroll <= VIEWPORT.width, `page is ${fit.scroll}px wide at 200% text, past the ${VIEWPORT.width}px viewport`);
    assert.ok(fit.right <= VIEWPORT.width, `"${fit.which}" ends at ${fit.right}px, past the ${VIEWPORT.width}px viewport`);
    await snap(page, "picker-large-text", true);

    // Finish, then: a returning user never sees onboarding again.
    await page.reload({ waitUntil: "domcontentloaded" });
    await hydrated(page, '[role="checkbox"]');
    await forward(page).click();
    const url = await finishFromHomeCity(page);
    assert.deepEqual((url.searchParams.get("tags") ?? "").split(",").sort(), ["pickup-sports", "sports"]);
    await page.goto(`${server.base}/welcome`, { waitUntil: "domcontentloaded" });
    assert.equal(new URL(page.url()).pathname, "/", "a finished user is sent to the map, not back to onboarding");
  });

  await step("no nearby matches: says so, keeps the filter, offers one widening, and never relaxes it", async () => {
    const page = await newcomer();
    await openMore(page);
    // Nothing in the demo data is tagged Volunteering.
    await page.getByRole("checkbox", { name: /^Volunteering/ }).click();
    await forward(page).click();
    const url = await finishFromHomeCity(page);
    assert.equal(url.searchParams.get("tags"), "volunteering");
    await strip(page).waitFor();
    const message = strip(page).locator('[data-notice="no-matches"]');
    await message.waitFor();
    assert.match(await message.innerText(), /Nothing in this area matches your interests yet\. Your filters are unchanged\./);
    assert.equal(await removers(page).count(), 1, "the interest is still an active filter");
    assert.equal(await pins(page).count(), 0, "no pin is shown that does not match");
    assert.equal(await widen(page).count(), 1, "exactly one widening is offered");
    assert.equal(await strip(page).locator("[data-widening]").count(), 1);
    await snap(page, "map-no-matches");
    assertClean(await auditMapPage(page), "axe: first map with no matches");

    // The widening searches a bigger area with the same filter.
    const before = page.pinQueries.at(-1);
    assert.ok(before, "the map queried its own viewport before the widening");
    const [wider] = await Promise.all([nextPinQuery(page), widen(page).click()]);
    assert.equal(wider.get("tags"), "volunteering", "the wider search keeps the interest filter");
    assert.ok(bboxArea(wider) > bboxArea(before) * 3, `the searched area grew (${bboxArea(before).toFixed(4)} → ${bboxArea(wider).toFixed(4)})`);
    await strip(page).locator('[data-notice="no-matches"]', { hasText: "Still nothing for your interests in the wider area." }).waitFor();
    assert.equal(await widen(page).count(), 0, "the widening is offered once");
    assert.equal(await removers(page).count(), 1);
    assert.equal(await pins(page).count(), 0);
    assert.equal(new URL(page.url()).searchParams.get("tags"), "volunteering");
    await snap(page, "map-no-matches-wider");

    // The same strip in list mode, where the map is hidden.
    await page.getByRole("button", { name: /^List$/ }).click();
    await strip(page).waitFor();
    assert.equal(await removers(page).count(), 1);
    await snap(page, "list-no-matches");
    await page.getByRole("button", { name: "Show map" }).click();

    // Only the viewer's own tap shows everything.
    await strip(page).getByRole("button", { name: "Show everything", exact: true }).click();
    await pins(page).first().waitFor({ timeout: 30_000 });
    assert.equal(await removers(page).count(), 0);
  });

  await step("one empty interest beside one with results: results stay, and the empty one is named", async () => {
    // Motion left on here, so the widening is also exercised as an animated move (the other cases jump).
    const page = await newcomer({ reducedMotion: "no-preference" });
    await page.getByRole("checkbox", { name: /^Pickup games/ }).click();
    await openMore(page);
    await page.getByRole("checkbox", { name: /^Volunteering/ }).click();
    await forward(page).click();
    await finishFromHomeCity(page);
    await strip(page).waitFor();
    await pins(page).first().waitFor({ timeout: 30_000 });
    const message = strip(page).locator('[data-notice="no-matches"]');
    await message.waitFor();
    assert.match(await message.innerText(), /Nothing for Volunteering in this area yet\./);
    assert.equal(await removers(page).count(), 2);
    assert.equal(await widen(page).count(), 1);
    await snap(page, "map-one-empty-interest");
    const before = page.pinQueries.at(-1);
    const [wider] = await Promise.all([nextPinQuery(page, (q) => bboxArea(q) > bboxArea(before) * 3), widen(page).click()]);
    assert.deepEqual(wider.get("tags").split(",").sort(), ["pickup-sports", "volunteering"], "both filters are kept");
    await strip(page).locator('[data-notice="no-matches"]', { hasText: "Still nothing for Volunteering in the wider area." }).waitFor();
    assert.equal(await widen(page).count(), 0);
    assert.equal(await removers(page).count(), 2);
  });

  await step("denied location: says the map starts in a default area, offers one widening, changes no filter", async () => {
    const page = await newcomer();
    // The browser refuses the prompt, as it does after someone taps "Don't allow".
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Browser.setPermission", { permission: { name: "geolocation" }, setting: "denied", origin: server.base });
    await page.getByRole("checkbox", { name: /^Coffee/ }).click();
    await forward(page).click();
    await page.getByRole("heading", { name: "Where's home?" }).waitFor();
    await page.getByRole("button", { name: "Skip", exact: true }).click();
    await page.getByRole("button", { name: /Use my location/ }).click();
    await page.getByText("No problem. You can turn it on later from the map.").waitFor();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await page.getByRole("button", { name: "Go to the map", exact: true }).click();
    await page.waitForURL((u) => u.pathname === "/" && u.searchParams.get("welcome") === "1");
    assert.equal(new URL(page.url()).searchParams.get("tags"), "coffee");
    await strip(page).waitFor();
    const note = strip(page).locator('[data-notice="location-off"]');
    await note.waitFor();
    assert.match(await note.innerText(), /Location is off, so the map starts in the default area, not where you are\./);
    await pins(page).first().waitFor({ timeout: 30_000 });
    assert.equal(await removers(page).count(), 1, "the Coffee filter is untouched");
    await widen(page).waitFor();
    assert.equal(await strip(page).locator("[data-widening]").count(), 1, "exactly one widening is offered");
    await snap(page, "map-location-denied");
    assertClean(await auditMapPage(page), "axe: first map with location off");

    // 200% text: the strip still fits the phone.
    await page.addStyleTag({ content: "html{font-size:200% !important}" });
    await page.waitForTimeout(200);
    const fit = await strip(page).evaluate((el) => ({ right: Math.round(el.getBoundingClientRect().right), left: Math.round(el.getBoundingClientRect().left), scroll: document.documentElement.scrollWidth }));
    assert.ok(fit.left >= 0 && fit.right <= VIEWPORT.width, `strip spans ${fit.left}–${fit.right}px at 200% text`);
    assert.ok(fit.scroll <= VIEWPORT.width, `page is ${fit.scroll}px wide at 200% text`);
    await snap(page, "map-location-denied-large-text");
    await page.addStyleTag({ content: "html{font-size:100% !important}" });

    // The widening keeps the filter and is offered once.
    const before = page.pinQueries.at(-1);
    const [wider] = await Promise.all([nextPinQuery(page), widen(page).click()]);
    assert.equal(wider.get("tags"), "coffee");
    assert.ok(bboxArea(wider) > bboxArea(before) * 3, "the searched area grew");
    await widen(page).waitFor({ state: "detached" });
    assert.equal(await removers(page).count(), 1);
    await note.waitFor();
  });

  await step("desktop width: the strip is on the map with the same controls", async () => {
    const page = await newcomer({ viewport: { width: 1280, height: 900 }, isMobile: false, hasTouch: false });
    await page.getByRole("checkbox", { name: /^Coffee/ }).click();
    await page.getByRole("checkbox", { name: /^Outdoors/ }).click();
    await forward(page).click();
    await finishFromHomeCity(page);
    await strip(page).waitFor();
    assert.equal(await removers(page).count(), 2);
    await strip(page).getByRole("button", { name: "Show everything", exact: true }).waitFor();
    const box = await strip(page).boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 1280, "the strip is inside the window");
    await snap(page, "map-desktop");
    assertClean(await auditMapPage(page), "axe: first map at desktop width");
  });

  await step("no browser page, hydration or CSP errors", async () => assert.deepEqual(errors, []));
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser?.close();
  await server.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} onboarding checks passed; screenshots in ${out}`);
process.exitCode = failed.length ? 1 : 0;
