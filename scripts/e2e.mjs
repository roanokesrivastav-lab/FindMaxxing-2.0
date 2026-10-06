// End-to-end beta suite, in a real browser at 390×844 (a phone). Exits non-zero
// on any failed check, and saves a screenshot after every step.
//
//   npm run build && npm run e2e
//
// With no E2E_BASE_URL it starts the built app itself, in demo mode, on a
// fresh in-memory store (FINDMAXXING_DEMO_FRESH=1, nothing written to .data)
// with uploads in a scratch folder that is deleted afterwards. Point
// E2E_BASE_URL at a running server to test that instead (e.g. staging; the
// demo-only steps are skipped there).
//
// Covers the core loop and the beta flows: discover on the map, onboarding,
// open a place, save it to a new list, add a place with a photo, create an
// event, join one, follow someone, report a place, a moderator resolving the
// report, password reset, and account deletion.
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { hydrated, launchOptions, startDemoServer } from "./lib/demo-server.mjs";

const OUT = process.env.E2E_OUT ?? ".data/e2e";
mkdirSync(OUT, { recursive: true });
const external = process.env.E2E_BASE_URL;
const PORT = Number(process.env.E2E_PORT ?? 3210);
const BASE = external ?? `http://localhost:${PORT}`;
const demo = !external;

let server = null;
if (!external) {
  try {
    server = await startDemoServer({ port: PORT });
  } catch (err) {
    console.error(`e2e: ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }
}

const browser = await chromium.launch(launchOptions());
const results = [];
let shot = 0;
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function phone() {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(e.message.slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) problems.push(m.text().slice(0, 200));
  });
  return { ctx, page, problems };
}

async function snap(page, name) {
  shot += 1;
  await page.screenshot({ path: path.join(OUT, `${String(shot).padStart(2, "0")}-${name}.png`), fullPage: false });
}

async function step(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(name, false, err instanceof Error ? err.message.split("\n")[0] : String(err));
  }
}

async function signIn(page, email, password = "findmaxxing") {
  await page.goto(`${BASE}/auth/sign-in`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "#email");
  await page.fill("#email", email);
  await page.fill("#password", password);
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth"), { timeout: 30_000 });
}

const run = Date.now().toString(36);
const me = { email: `e2e-${run}@example.test`, username: `e2e_${run}`.slice(0, 24), password: "e2e-password-1", newPassword: "e2e-password-2" };
const PLACE_NAME = `E2E court ${run}`;
const photo = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r: 30, g: 140, b: 90 } } }).jpeg().toBuffer();

const { ctx, page, problems } = await phone();

// 1. Discover on the map, anonymously.
await step("explore loads with labelled, focusable pins", async () => {
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.locator(".maplibregl-map, .mapboxgl-map").first().waitFor({ timeout: 30_000 });
  const pin = page.locator('.maplibregl-marker button[aria-label], .mapboxgl-marker button[aria-label]').first();
  await pin.waitFor({ timeout: 30_000 });
  const label = await pin.getAttribute("aria-label");
  check("explore loads with labelled, focusable pins", /, .+, (rated|not rated)|event, /.test(label ?? ""), label ?? "");
  await snap(page, "explore");
});

// 2. Sign up and onboard.
await step("sign up lands on onboarding", async () => {
  await page.goto(`${BASE}/auth/sign-up`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "#email");
  await page.fill("#displayName", "E2E Tester");
  await page.fill("#username", me.username);
  await page.fill("#email", me.email);
  await page.fill("#password", me.password);
  await page.getByRole("button", { name: /^Create account$/ }).click();
  await page.waitForURL("**/welcome", { timeout: 30_000 });
  check("sign up lands on onboarding", true);
  await snap(page, "welcome");
});
await step("onboarding: interests, home city, location, people, then the filtered map", async () => {
  await hydrated(page, "button");
  await page.getByRole("button", { name: /Coffee/ }).first().click();
  await page.getByRole("button", { name: /Hiking/ }).first().click();
  await page.getByRole("button", { name: /^Next$/ }).click();
  await page.getByLabel("Home city").fill("Columbus");
  await page.getByRole("button", { name: /^Next$/ }).click();
  await page.getByRole("button", { name: /^Not now$/ }).click();
  await page.getByRole("button", { name: /^Go to the map$/ }).click();
  await page.waitForURL((u) => u.pathname === "/" && u.searchParams.get("welcome") === "1", { timeout: 30_000 });
  const tags = new URL(page.url()).searchParams.get("tags") ?? "";
  check("onboarding: interests, home city, location, people, then the filtered map", tags.includes("coffee") && tags.includes("hiking"), tags);
  await snap(page, "map-after-onboarding");
  await page.goto(`${BASE}/welcome`);
  check("onboarding never shows again", new URL(page.url()).pathname === "/");
});

// 3. Open a place and save it to a new list.
let placeUrl = "";
await step("open a place from the list", async () => {
  await page.goto(`${BASE}/?tags=`, { waitUntil: "domcontentloaded" });
  const listToggle = page.getByRole("button", { name: /^List$/ });
  if (await listToggle.isVisible().catch(() => false)) await listToggle.click();
  const link = page.locator('a[href^="/places/"]').first();
  await link.waitFor({ timeout: 30_000 });
  placeUrl = await link.getAttribute("href");
  await page.goto(`${BASE}${placeUrl}`, { waitUntil: "domcontentloaded" });
  check("open a place from the list", /\/places\/[0-9a-f-]{36}/.test(placeUrl ?? ""), placeUrl);
  await snap(page, "place");
});
await step("save it to a new list", async () => {
  const save = page.getByRole("button", { name: /^Save$|Saved. Organize into lists/ }).first();
  await hydrated(page, "h1");
  await save.click();
  const sheet = page.getByRole("dialog", { name: "Save to" });
  await sheet.waitFor({ timeout: 15_000 });
  check("the save sheet takes focus", await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')));
  await sheet.getByLabel("List name").fill("E2E picks");
  await sheet.getByRole("button", { name: /^Create$/ }).click();
  await page.getByText("Added to “E2E picks”").waitFor({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await page.goto(`${BASE}/saved`, { waitUntil: "domcontentloaded" });
  const list = page.locator('a[href^="/saved/"]').filter({ hasText: "E2E picks" }).first();
  await list.click();
  await page.waitForURL("**/saved/**");
  check("save it to a new list", (await page.locator(`a[href="${placeUrl}"]`).count()) > 0);
  await snap(page, "list");
});

// 4. Add a place with a photo.
let newPlaceUrl = "";
await step("add a place with a photo", async () => {
  await page.goto(`${BASE}/places/new`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "#name");
  await page.fill("#name", PLACE_NAME);
  await page.getByRole("button", { name: /Pickup sports/ }).first().click();
  await page.fill("#description", "A court added by the end-to-end suite, with enough description.");
  await page.fill("#localTip", "Lights come on at dusk.");
  await page.locator('input[type="file"][multiple]').first().setInputFiles([{ name: "court.jpg", mimeType: "image/jpeg", buffer: photo }]);
  const map = page.locator(".maplibregl-map, .mapboxgl-map").first();
  await map.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const box = await map.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /Add to the map/ }).click();
  await page.waitForURL("**/places/*?new=1", { timeout: 60_000 });
  newPlaceUrl = new URL(page.url()).pathname;
  const img = page.locator('img[src^="/api/photos/"]').first();
  await img.waitFor({ timeout: 15_000 });
  const loaded = await img.evaluate((el) => el.complete && el.naturalWidth > 0);
  check("add a place with a photo", loaded, newPlaceUrl);
  await snap(page, "new-place");
});

// 5. Create an event, then join someone else's.
await step("create an event", async () => {
  await page.goto(`${BASE}/events/new`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "#title");
  await page.fill("#title", `E2E meetup ${run}`);
  await page.getByRole("button", { name: /Pickup sports/ }).first().click();
  await page.fill("#description", "An event created by the end-to-end suite with details.");
  await page.fill("#locationName", "North pitch");
  const map = page.locator(".maplibregl-map, .mapboxgl-map").first();
  await map.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const box = await map.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: /Create event/ }).click();
  await page.waitForURL("**/events/*?new=1", { timeout: 30_000 });
  // The creator attends their own event.
  await page.getByRole("button", { name: /You're going/ }).waitFor({ timeout: 15_000 });
  check("create an event", true);
  await snap(page, "new-event");
});
await step("join an event", async () => {
  await page.goto(`${BASE}/events`, { waitUntil: "domcontentloaded" });
  const links = page.locator('a[href^="/events/"]:not([href="/events/new"])');
  await links.first().waitFor({ timeout: 30_000 });
  const hrefs = await links.evaluateAll((els) => els.map((e) => e.getAttribute("href")));
  for (const href of hrefs) {
    await page.goto(`${BASE}${href}`, { waitUntil: "domcontentloaded" });
    const join = page.getByRole("button", { name: /^Join event$/ });
    if (await join.count()) {
      await hydrated(page, "h1");
      await join.click();
      await page.getByRole("button", { name: /You're going/ }).waitFor({ timeout: 15_000 });
      check("join an event", true, href);
      await snap(page, "joined");
      return;
    }
  }
  check("join an event", false, "no joinable event found");
});

// 6. Follow someone.
await step("follow someone", async () => {
  await page.goto(`${BASE}/people`, { waitUntil: "domcontentloaded" });
  const follow = page.getByRole("button", { name: /^Follow$/ }).first();
  await follow.waitFor({ timeout: 15_000 });
  await hydrated(page, "h1");
  await follow.click();
  await page.getByRole("button", { name: /^Following$/ }).first().waitFor({ timeout: 15_000 });
  check("follow someone", true);
  await snap(page, "followed");
});

// 7. Report a place.
await step("report a place", async () => {
  await page.goto(`${BASE}${placeUrl}`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "h1");
  await page.getByRole("button", { name: /^Report$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Report this listing" });
  await dialog.getByRole("radio", { name: /Spam/ }).check();
  await dialog.locator("#report-details").fill(`Reported by the e2e suite ${run}`);
  await dialog.getByRole("button", { name: /Submit report/ }).click();
  await page.getByText("Thanks. We'll take a look.").waitFor({ timeout: 15_000 });
  check("report a place", true);
  await snap(page, "reported");
});

// 8. A moderator resolves it.
await step("a moderator resolves the report", async () => {
  const mod = await phone();
  await signIn(mod.page, "sam@example.com");
  await mod.page.goto(`${BASE}/moderation/place/${placeUrl.split("/").pop()}`, { waitUntil: "domcontentloaded" });
  await hydrated(mod.page, "h1");
  check("the moderator sees who reported it", (await mod.page.getByText(`@${me.username}`).count()) > 0);
  await mod.page.getByRole("button", { name: "Dismiss reports" }).click();
  await mod.page.getByRole("button", { name: /^Dismiss$/ }).click();
  await mod.page.getByText("Dismissed the reports").waitFor({ timeout: 15_000 });
  check("a moderator resolves the report", true);
  await snap(mod.page, "moderated");
  await mod.ctx.close();
  await page.goto(`${BASE}/profile/reports`, { waitUntil: "domcontentloaded" });
  check("the reporter sees it resolved", /a moderator resolved it on/.test(await page.locator("body").innerText()));
});

// 9. Password reset (demo shows the link instead of emailing it).
if (demo) {
  await step("reset the password", async () => {
    const other = await phone();
    await other.page.goto(`${BASE}/auth/forgot`, { waitUntil: "domcontentloaded" });
    await hydrated(other.page, "#email");
    await other.page.fill("#email", me.email);
    await other.page.getByRole("button", { name: /Send reset link/ }).click();
    const link = other.page.getByRole("link", { name: "Open the reset link" });
    await link.waitFor({ timeout: 15_000 });
    await link.click();
    await other.page.waitForURL("**/auth/reset?token=**");
    await hydrated(other.page, "#password");
    await other.page.fill("#password", me.newPassword);
    await other.page.fill("#confirm", me.newPassword);
    await other.page.getByRole("button", { name: /Save new password/ }).click();
    await other.page.waitForURL("**/profile?reset=1", { timeout: 30_000 });
    check("reset the password", true);
    await snap(other.page, "password-reset");
    await other.ctx.close();
    me.password = me.newPassword;
  });
}

// 10. Delete the account.
await step("delete the account", async () => {
  await page.goto(`${BASE}/profile/settings`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "h1");
  await page.getByRole("button", { name: /^Delete account$/ }).click();
  const dialog = page.getByRole("dialog", { name: "Delete your account?" });
  await dialog.locator("#delete-password").fill("wrong-password");
  await dialog.getByRole("button", { name: /Delete everything/ }).click();
  await dialog.getByText("That password isn't right").waitFor({ timeout: 15_000 });
  await dialog.locator("#delete-password").fill(me.password);
  await snap(page, "delete-confirm");
  await dialog.getByRole("button", { name: /Delete everything/ }).click();
  await page.waitForURL("**/?deleted=1", { timeout: 30_000 });
  const res = await page.goto(`${BASE}${newPlaceUrl}`, { waitUntil: "networkidle" });
  const gone = /Off the map/.test(await page.locator("body").innerText()) || res?.status() === 404;
  check("delete the account", gone, "their place is gone");
  await page.goto(`${BASE}/auth/sign-in`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "#email");
  await page.fill("#email", me.email);
  await page.fill("#password", me.password);
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await page.getByText("Incorrect email or password").waitFor({ timeout: 15_000 });
  check("the deleted account cannot sign in", true);
});

check("no CSP violations or page errors along the way", problems.length === 0, problems.slice(0, 3).join(" | "));
await ctx.close();
await browser.close();
if (server) await server.stop();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${OUT}`);
process.exit(failed.length ? 1 : 0);
