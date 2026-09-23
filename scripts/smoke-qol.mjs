// Browser checks for the quality-of-life pass (demo mode).
// Usage: npm run dev (in another terminal) && node scripts/smoke-qol.mjs [outDir]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = "http://localhost:3000";
const out = process.argv[2] ?? ".data/smoke-qol";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function newCtx(width = 1280, height = 900) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    permissions: [],
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 200)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 200));
  });
  return { ctx, page, errors };
}

async function signIn(page, email) {
  await page.goto(`${base}/auth/sign-in`, { waitUntil: "domcontentloaded" });
  await page.fill("#email", email);
  await page.fill("#password", "findmaxxing");
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth"), { timeout: 20000 });
}

/** Reads the pin coordinates the LocationPicker writes into the form. */
async function pinCoords(page) {
  return page.evaluate(() => {
    const lat = document.querySelector('input[name="lat"]');
    const lng = document.querySelector('input[name="lng"]');
    return lat && lng ? { lat: Number(lat.value), lng: Number(lng.value) } : null;
  });
}

// ── 1. Address → pin ─────────────────────────────────────────────────────────
{
  const { ctx, page, errors } = await newCtx();
  await signIn(page, "maya@example.com");
  await page.goto(`${base}/places/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  check("no pin before an address is typed", (await pinCoords(page)) === null);

  await page.fill("#city", "Columbus");
  await page.waitForTimeout(4000);
  const cityOnly = await pinCoords(page);
  check("city alone moves the pin to the area", !!cityOnly && Math.abs(cityOnly.lat - 39.96) < 0.2, cityOnly ? `${cityOnly.lat}, ${cityOnly.lng}` : "no pin");

  await page.fill("#streetName", "Oak St");
  await page.waitForTimeout(4000);
  const street = await pinCoords(page);
  check("street name narrows the city pin", !!street && Math.abs(street.lat - 39.9627) < 0.02, street ? `${street.lat}, ${street.lng}` : "no pin");

  await page.fill("#address", "1210 Oak St");
  await page.waitForTimeout(4000);

  const moved = await pinCoords(page);
  const near = moved && Math.abs(moved.lat - 39.9627) < 0.01 && Math.abs(moved.lng + 82.9681) < 0.01;
  check("typing an exact address moves the pin close to that address", !!near, moved ? `${moved.lat}, ${moved.lng}` : "no pin");
  await page.screenshot({ path: `${out}/address-pin.png` });

  // A neighborhood-only query should land wide rather than on a house.
  await page.fill("#address", "");
  await page.fill("#neighborhood", "Clintonville");
  await page.waitForTimeout(4000);
  const region = await pinCoords(page);
  check("a neighborhood moves the pin to that region", !!region && Math.abs(region.lat - 40.039) < 0.05, region ? `${region.lat}, ${region.lng}` : "no pin");
  check("no console errors during address lookup", errors.length === 0, errors[0] ?? "");
  await ctx.close();
}

// ── 2. A hand-placed pin is not hijacked ─────────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "maya@example.com");
  await page.goto(`${base}/places/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const map = page.locator(".maplibregl-map, .mapboxgl-map").first();
  await map.waitFor({ timeout: 15000 });
  // The picker sits well below the fold on this form; without scrolling, the
  // click lands outside the viewport and never reaches the map.
  await map.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  const box = await map.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(800);
  const placed = await pinCoords(page);

  await page.fill("#address", "1210 Oak St");
  await page.fill("#city", "Columbus");
  await page.waitForTimeout(4500);

  const after = await pinCoords(page);
  const unchanged = placed && after && placed.lat === after.lat && placed.lng === after.lng;
  check("a hand-placed pin is not moved automatically", !!unchanged);
  check("the match is offered as a chip instead", await page.getByRole("button", { name: /Move pin to/ }).isVisible());
  await page.screenshot({ path: `${out}/pin-suggestion.png` });

  await page.getByRole("button", { name: /Move pin to/ }).click();
  await page.waitForTimeout(1200);
  const accepted = await pinCoords(page);
  check("accepting the chip moves the pin", !!accepted && accepted.lat !== placed.lat);
  await ctx.close();
}

// ── 3. Validation error keeps typed input and photos ─────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "maya@example.com");
  await page.goto(`${base}/places/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  const description = "A long description that took real effort to write and must survive a failed submit.";
  await page.fill("#name", "Input Retention Test");
  await page.fill("#description", description);

  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator('input[type="file"][multiple]').first().setInputFiles([{ name: "a.png", mimeType: "image/png", buffer: png }]);
  await page.waitForTimeout(600);

  // Submit with no category and no pin, so the server rejects it.
  await page.getByRole("button", { name: /Add to the map/ }).click();
  await page.waitForTimeout(3000);

  check("typed name survives a validation error", (await page.inputValue("#name")) === "Input Retention Test");
  check("typed description survives a validation error", (await page.inputValue("#description")) === description);
  const fileCount = await page.evaluate(() => {
    const el = document.querySelector('input[type="file"][name="photos"]');
    return el?.files?.length ?? -1;
  });
  check("selected photo is still attached after the error", fileCount === 1, `files=${fileCount}`);
  check("an error is shown", await page.locator('[role="alert"], .text-danger').first().isVisible());
  await page.screenshot({ path: `${out}/error-retention.png` });
  await ctx.close();
}

// ── 4. Foldable events section, remembered ───────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const eventsFold = page.getByRole("button", { name: /^Events · \d+$/ });
  await eventsFold.waitFor({ timeout: 15000 });
  check("events section has a fold control", await eventsFold.isVisible());
  check("events start expanded", (await eventsFold.getAttribute("aria-expanded")) === "true");

  const before = await page.locator('a[href^="/events/"]').count();
  await eventsFold.click();
  await page.waitForTimeout(700);
  const after = await page.locator('a[href^="/events/"]').count();
  check("folding hides the event cards", after < before, `${before} → ${after}`);
  await page.screenshot({ path: `${out}/events-folded.png` });

  // The fold should survive navigating away and back.
  await page.goto(`${base}/events`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  const foldAfterNav = page.getByRole("button", { name: /^Events · \d+$/ });
  check("the fold is remembered across navigation", (await foldAfterNav.getAttribute("aria-expanded")) === "false");
  await foldAfterNav.click();
  await page.waitForTimeout(500);
  check("unfolding brings the events back", (await page.locator('a[href^="/events/"]').count()) > 0);
  await ctx.close();
}

// ── 4b. The whole panel collapses on desktop ────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);

  const listItem = page.locator('a[href^="/places/"]').first();
  check("list panel is shown by default", await listItem.isVisible());

  await page.getByRole("button", { name: /Hide the list/ }).click();
  await page.waitForTimeout(900);
  check("hiding the panel clears the map", !(await listItem.isVisible().catch(() => false)));

  const restore = page.getByRole("button", { name: /nearby|Nothing matches/ });
  check("a control to bring the list back is offered", await restore.isVisible());
  await page.screenshot({ path: `${out}/panel-collapsed.png` });

  await page.goto(`${base}/events`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  check(
    "the collapsed panel stays collapsed across navigation",
    !(await page.locator('a[href^="/places/"]').first().isVisible().catch(() => false)),
  );

  await page.getByRole("button", { name: /nearby|Nothing matches/ }).click();
  await page.waitForTimeout(900);
  check("restoring brings the list back", await page.locator('a[href^="/places/"]').first().isVisible());
  await ctx.close();
}

// Mobile keeps its own map/list toggle and gains no desktop-only control.
{
  const { ctx, page } = await newCtx(390, 844);
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  check("mobile has no desktop hide control", !(await page.getByRole("button", { name: /Hide the list/ }).isVisible().catch(() => false)));
  check("mobile keeps its map/list toggle", await page.getByRole("button", { name: /^List$/ }).isVisible());
  await ctx.close();
}

// ── 5. Share button ──────────────────────────────────────────────────────────
{
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    permissions: ["clipboard-read", "clipboard-write"],
  });
  const page = await ctx.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.getByLabel("Search places and events").fill("Cannon");
  await page.waitForTimeout(1400);
  await page.locator('a[href^="/places/"]').filter({ hasText: /Cannon & Crown/ }).first().click();
  await page.waitForURL("**/places/**", { timeout: 20000 });
  await page.waitForTimeout(1800);

  // Force the clipboard path so the assertion is deterministic in headless.
  await page.evaluate(() => {
    delete Object.getPrototypeOf(navigator).share;
  });
  const share = page.getByRole("button", { name: /^Share / });
  check("share button present on a place", await share.isVisible());
  await share.click();
  await page.waitForTimeout(1200);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  check("share copies the page URL", copied.includes("/places/"), copied.slice(0, 60));
  await ctx.close();
}

// ── 6. Saved: search and sort ────────────────────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "maya@example.com");
  await page.goto(`${base}/saved`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const total = await page.locator('a[href^="/places/"]').count();
  check("saved page lists places", total > 1, `${total}`);

  await page.getByLabel("Search saved places").fill("ridgeline");
  await page.waitForTimeout(1200);
  const filtered = await page.locator('a[href^="/places/"]').count();
  check("saved search narrows the list", filtered < total && filtered > 0, `${total} → ${filtered}`);

  await page.getByLabel("Search saved places").fill("");
  await page.waitForTimeout(900);
  const orderBefore = await page.locator('a[href^="/places/"] h3').allInnerTexts();
  await page.getByRole("button", { name: /^A–Z$/ }).click();
  await page.waitForTimeout(900);
  const orderAfter = await page.locator('a[href^="/places/"] h3').allInnerTexts();
  const alphabetical = [...orderAfter].sort((a, b) => a.localeCompare(b));
  check(
    "A–Z sort orders the saved list alphabetically",
    JSON.stringify(orderAfter) === JSON.stringify(alphabetical) && orderAfter.length > 1,
    orderAfter.join(", "),
  );
  check("A–Z differs from the default save order", JSON.stringify(orderBefore) !== JSON.stringify(orderAfter), `was: ${orderBefore.join(", ")}`);
  await page.screenshot({ path: `${out}/saved-sorted.png` });
  await ctx.close();
}

// ── 7. Past events ───────────────────────────────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "theo@example.com"); // attended the seeded season opener
  await page.goto(`${base}/events`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);

  const beenTo = page.getByRole("button", { name: /^Been to$/ });
  check("Been to filter is offered when signed in", await beenTo.isVisible());
  await beenTo.click();
  await page.waitForTimeout(1200);
  const text = await page.evaluate(() => document.body.innerText);
  check("past attended event is listed", text.includes("Season opener watch party"));
  check("past events show as ended", /Ended/.test(text));
  await page.screenshot({ path: `${out}/been-to.png` });
  await ctx.close();
}
{
  const { ctx, page } = await newCtx();
  await page.goto(`${base}/events`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1800);
  check("Been to is hidden when signed out", !(await page.getByRole("button", { name: /^Been to$/ }).isVisible().catch(() => false)));
  await ctx.close();
}

// ── 8. Event duration guard ──────────────────────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "sam@example.com");
  await page.goto(`${base}/events/new`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.fill("#title", "Duration guard check");
  await page.fill("#description", "Checking that a reversed end time is caught.");
  await page.fill("#startTime", "18:00");
  await page.fill("#endTime", "17:00");
  await page.getByRole("button", { name: /Pickup sports/ }).click();
  await page.fill("#locationName", "Somewhere specific");
  // A pin is required, and zod only runs the cross-field duration check once
  // the individual fields parse, so place one before submitting.
  const evMap = page.locator(".maplibregl-map, .mapboxgl-map").first();
  await evMap.waitFor({ timeout: 15000 });
  await evMap.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  const evBox = await evMap.boundingBox();
  await page.mouse.click(evBox.x + evBox.width / 2, evBox.y + evBox.height / 2);
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /Create event/ }).click();
  await page.waitForTimeout(3000);
  const body = await page.evaluate(() => document.body.innerText);
  check("a reversed end time is rejected, not silently accepted", /Check the start and end times/.test(body), body.match(/runs \d+ hours[^\n]*/)?.[0] ?? "");
  check("title survived the rejected submit", (await page.inputValue("#title")) === "Duration guard check");
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}
