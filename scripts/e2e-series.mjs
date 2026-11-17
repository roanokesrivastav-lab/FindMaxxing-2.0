// Recurring series browser checks (roadmap 4.5a), in a real browser at 390×844
// against a fresh demo server.
//
//   npm run build && npm run e2e:series
//
// Covers: creating a repeating session from the event form, the series line and
// host tools on an occurrence, someone joining one session only, editing "this
// and future", cancelling one session without touching the next, ending the
// series, and axe on the form and the occurrence page. Exits non-zero on any
// failed check; screenshots go to SERIES_E2E_OUT.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";
import { hydrated, launchOptions, startDemoServer } from "./lib/demo-server.mjs";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const out = process.env.SERIES_E2E_OUT ?? ".data/e2e-series";
mkdirSync(out, { recursive: true });
const server = await startDemoServer({ port: Number(process.env.SERIES_E2E_PORT ?? 3215) });
const run = Date.now().toString(36);
const title = `Thursday loop ${run}`;

let browser;
const results = [], errors = [], contexts = [];
let shots = 0;
async function step(name, fn) {
  try { await fn(); results.push({ name, pass: true }); console.log(`PASS  ${name}`); }
  catch (err) { results.push({ name, pass: false }); console.error(`FAIL  ${name}: ${err.message.split("\n")[0]}`); }
}
const snap = (page, label) => page.screenshot({ path: `${out}/${String(++shots).padStart(2, "0")}-${label}.png` });
async function person(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" });
  contexts.push(ctx);
  const page = await ctx.newPage();
  page.setDefaultTimeout(20_000);
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to|Minified React error|[Hh]ydrat/.test(m.text())) errors.push(m.text().slice(0, 200)); });
  await page.goto(`${server.base}/auth/sign-in`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "#email");
  await page.fill("#email", email);
  await page.fill("#password", "findmaxxing");
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth"));
  return page;
}
async function visit(page, path) {
  const res = await page.goto(`${server.base}${path}`, { waitUntil: "domcontentloaded" });
  assert.equal(res?.status(), 200, `${path} answered ${res?.status()}`);
  await hydrated(page, "h1");
  await page.waitForFunction(() => document.querySelectorAll("[data-event-detail]").length <= 1);
}
async function audit(page, include = null) {
  await page.addScriptTag({ content: AXE });
  const result = await page.evaluate(async (inc) => await window.axe.run(inc ? { include: [[inc]] } : { exclude: [[".maplibregl-canvas"], [".mapboxgl-canvas"]] }, { resultTypes: ["violations"], rules: { "target-size": { enabled: true } } }), include);
  return result.violations.map((v) => `${v.impact}:${v.id} ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(" | ")}`);
}
const assertClean = (v, label) => assert.equal(v.length, 0, `${label}: ${v.join("; ")}`);
const detail = (page) => page.locator("[data-event-detail]");
/** Paths of this series' sessions, from the Events list, in the order shown. */
async function sessions(page, name = title) {
  await page.goto(`${server.base}/events`, { waitUntil: "domcontentloaded" });
  await page.locator('a[href^="/events/"]').first().waitFor();
  return page.locator(`a[href^="/events/"]:has-text("${name}")`).evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute("href")))]);
}

try {
  browser = await chromium.launch(launchOptions());
  const host = await person("dev@example.com");
  const guest = await person("maya@example.com");
  let paths = [];

  await step("the event form offers a repeat, off by default, and creates four weeks of sessions", async () => {
    await host.goto(`${server.base}/events/new`, { waitUntil: "domcontentloaded" });
    await hydrated(host, "#title");
    const repeat = host.getByRole("checkbox", { name: "Repeats every week" });
    assert.equal(await repeat.isChecked(), false, "a new event is a one-off unless the host says otherwise");
    assert.equal(await host.locator("#repeatInterval").count(), 0);
    await host.fill("#title", title);
    await host.getByRole("button", { name: /Pickup sports/ }).first().click();
    await host.fill("#description", "An easy loop from the fountain, every week, all paces welcome.");
    await host.fill("#locationName", "Scioto Mile fountain");
    await repeat.check();
    await host.locator("#repeatInterval").waitFor();
    assert.equal(await host.locator('input[name="weekday"]:checked').count(), 1, "the chosen date's weekday is ticked");
    await snap(host, "form-repeat-on");
    // The repeat fields only: the form's selected category tile has a contrast fault of its own, older than this ticket.
    assertClean(await audit(host, "[data-repeat-fields]"), "axe: the repeat fields, open");
    const map = host.locator(".maplibregl-map, .mapboxgl-map").first();
    await map.waitFor({ timeout: 30_000 });
    await host.waitForTimeout(1500);
    const box = await map.boundingBox();
    await host.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await host.waitForTimeout(400);
    await host.getByRole("button", { name: /Create event/ }).click();
    await host.waitForURL("**/events/*", { timeout: 30_000 });
    paths = await sessions(host);
    assert.equal(paths.length, 4, `four sessions listed, got ${paths.length}`);
  });

  await step("an occurrence says it is part of a series and gives its host the series tools", async () => {
    await visit(host, paths[0]);
    const line = (await detail(host).locator("[data-series-line]").innerText()).trim();
    assert.match(line, /^Part of a series · weekly on (Mon|Tues|Wednes|Thurs|Fri|Satur|Sun)days$/, line);
    const tools = host.locator("[data-series-host-tools]");
    await tools.getByRole("button", { name: "Cancel this session", exact: true }).waitFor();
    await tools.getByRole("button", { name: "End series", exact: true }).waitFor();
    await snap(host, "occurrence-host");
    assertClean(await audit(host), "axe: series occurrence as its host");
  });

  await step("someone joins one session and is on that one only; they see no host tools", async () => {
    await visit(guest, paths[1]);
    assert.equal(await guest.locator("[data-series-host-tools]").count(), 0);
    await detail(guest).locator("[data-series-line]").waitFor();
    await guest.getByRole("button", { name: "Join event", exact: true }).click();
    await guest.getByRole("button", { name: /You're going/ }).waitFor();
    await visit(guest, paths[2]);
    await guest.getByRole("button", { name: "Join event", exact: true }).waitFor();
    assertClean(await audit(guest), "axe: series occurrence as a guest");
  });

  await step("editing this and future renames the later sessions and leaves the earlier one alone", async () => {
    await host.goto(`${server.base}${paths[1]}/edit`, { waitUntil: "domcontentloaded" });
    await hydrated(host, "#title");
    const apply = host.locator("[data-apply-to]");
    assert.equal(await apply.getByRole("radio", { name: "This session only" }).isChecked(), true, "one session is the default");
    await apply.getByRole("radio", { name: "This and future sessions" }).check();
    await host.fill("#title", `${title} (tempo)`);
    await snap(host, "edit-apply-to");
    // The Save bar must be the topmost thing where it sits (the navigation used to cover it on this page).
    const save = host.getByRole("button", { name: "Save event", exact: true });
    const onTop = await save.evaluate((el) => { el.scrollIntoView({ block: "center" }); const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return top === el || el.contains(top); });
    assert.ok(onTop, "the Save button is covered by something");
    await save.click();
    await host.waitForURL((u) => !u.pathname.endsWith("/edit"), { timeout: 30_000 });
    await visit(host, paths[0]);
    assert.equal((await detail(host).locator("h1").innerText()).trim(), title, "the session before the one edited keeps its name");
    for (const p of paths.slice(1)) {
      await visit(host, p);
      assert.equal((await detail(host).locator("h1").innerText()).trim(), `${title} (tempo)`, `${p} was renamed`);
    }
    // The person who joined is still going to the same session.
    await visit(guest, paths[1]);
    await guest.getByRole("button", { name: /You're going/ }).waitFor();
  });

  await step("cancelling one session leaves the next as it is", async () => {
    await visit(host, paths[2]);
    await host.locator("[data-series-host-tools]").getByRole("button", { name: "Cancel this session", exact: true }).click();
    const sheet = host.getByRole("dialog", { name: "Cancel this session?" });
    await sheet.getByText("The next session is not affected", { exact: false }).waitFor();
    await snap(host, "cancel-confirm");
    await sheet.getByRole("button", { name: "Cancel session", exact: true }).click();
    await host.getByText("This session is cancelled", { exact: true }).waitFor();
    await visit(host, paths[2]);
    assert.match(await detail(host).innerText(), /Cancelled/);
    assert.equal(await host.locator("[data-series-host-tools]").count(), 0, "a cancelled session has no host tools");
    await visit(host, paths[3]);
    assert.doesNotMatch(await detail(host).innerText(), /Cancelled/);
    await host.locator("[data-series-host-tools]").waitFor();
  });

  await step("ending the series cancels the later sessions and says so on the page", async () => {
    await visit(host, paths[0]);
    await host.locator("[data-series-host-tools]").getByRole("button", { name: "End series", exact: true }).click();
    await host.getByRole("dialog", { name: "End this series?" }).getByRole("button", { name: "End series", exact: true }).click();
    await host.getByText("Series ended", { exact: true }).waitFor();
    for (const p of [paths[1], paths[3]]) {
      await visit(host, p);
      assert.match(await detail(host).innerText(), /Cancelled/, `${p} is cancelled`);
    }
    // The person who had joined can still open their cancelled session and is told.
    await visit(guest, paths[1]);
    assert.match(await detail(guest).innerText(), /Cancelled/);
    await snap(guest, "guest-after-series-ended");
  });

  await step("no browser page, hydration or CSP errors", async () => assert.deepEqual(errors, []));
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser?.close();
  await server.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} series checks passed; screenshots in ${out}`);
process.exitCode = failed.length ? 1 : 0;
