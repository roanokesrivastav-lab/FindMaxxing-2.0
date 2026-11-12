// Onboarding and first-map browser checks (roadmap 1.2 and 1.3), in a real
// browser at 390×844 against a fresh demo server. Each case signs up its own
// newcomer and goes through the real picker, save actions and Explore page.
//
//   npm run build && npm run e2e:onboarding
//
// Covers: zero and maximum choices, skip, keyboard-only use, coming back to the
// step, returning users, 200% text, and axe on each picker state. Exits
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
    assert.deepEqual(await audit(page), [], "axe: default picker");
  });

  await step("zero choices: Continue works with nothing picked and the map opens unfiltered", async () => {
    const page = await newcomer();
    assert.equal(await forward(page).isEnabled(), true);
    await forward(page).click();
    const url = await finishFromHomeCity(page);
    assert.equal(url.searchParams.get("tags"), null);
    await snap(page, "map-zero-interests");
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
    assert.deepEqual(await audit(page), [], "axe: picker at the limit");
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
    await snap(page, "map-twelve-interests");
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
    assert.deepEqual(await audit(page), [], "axe: More interests open");
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

  await step("no browser page, hydration or CSP errors", async () => assert.deepEqual(errors, []));
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser?.close();
  await server.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} onboarding checks passed; screenshots in ${out}`);
process.exitCode = failed.length ? 1 : 0;
