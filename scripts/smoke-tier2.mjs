// Scripted browser checks for the Tier 2 community layer (demo mode).
// Usage: npm run dev (in another terminal) && node scripts/smoke-tier2.mjs [outDir]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = "http://localhost:3000";
const out = process.argv[2] ?? ".data/smoke-tier2";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});

const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function newCtx(width = 1280, height = 900) {
  const ctx = await browser.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message.slice(0, 160)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text().slice(0, 160));
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

/** Searches, then opens the matching PLACE (not event) result. */
async function openPlace(page, query, namePattern) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  await page.getByLabel("Search places and events").fill(query);
  await page.waitForTimeout(1400);
  const link = page.locator('a[href^="/places/"]').filter({ hasText: namePattern }).first();
  await link.click({ timeout: 15000 });
  await page.waitForURL("**/places/**", { timeout: 20000 });
  await page.waitForTimeout(1800);
}

/** Names visible in the Explore list panel. */
async function listNames(page) {
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  return page.evaluate(() => document.body.innerText);
}

// ── 1. Anonymous cannot see locals-only places ───────────────────────────────
{
  const { ctx, page } = await newCtx();
  const text = await listNames(page);
  check("anon: locals-only places hidden", !text.includes("Ridgeline Loop") && !text.includes("Fourth Street Basement"),
    `ridgeline=${text.includes("Ridgeline Loop")} basement=${text.includes("Fourth Street Basement")}`);
  await page.goto(`${base}/places/`, { waitUntil: "domcontentloaded" });
  await ctx.close();
}

// ── 2. A non-local signed-in user still cannot see them ──────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "nina@example.com");
  const text = await listNames(page);
  check("non-local (nina): locals-only hidden", !text.includes("Fourth Street Basement"));
  await page.screenshot({ path: `${out}/nina-explore.png` });
  await ctx.close();
}

// ── 3. A local sees them, with the tier explained ────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "jules@example.com");
  const text = await listNames(page);
  check("local (jules): locals-only visible", text.includes("Fourth Street Basement") || text.includes("Ridgeline Loop"));

  await openPlace(page, "Ridgeline", /Ridgeline Loop/);
  const detail = await page.evaluate(() => document.body.innerText);
  check("locals badge shown on detail", /Locals only/i.test(detail), detail.match(/Locals only[^\n]*/)?.[0] ?? "");
  check("owner controls present for owner", /Who can see it/i.test(detail));
  await page.screenshot({ path: `${out}/jules-locals-place.png`, fullPage: false });
  await ctx.close();
}

// ── 4. Rating notes: write one, see it in the reviews list ───────────────────
{
  const { ctx, page, errors } = await newCtx();
  await signIn(page, "nina@example.com");
  await openPlace(page, "Lumen", /The Lumen Rooftop/);

  await page.getByRole("radio", { name: "4 stars" }).click();
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: /Add a note/ }).click();
  await page.getByLabel("Your note about this place").fill("Weeknights are calm and the view is the whole point.");
  await page.getByRole("button", { name: /Save note/ }).click();
  await page.waitForTimeout(2500);

  const text = await page.evaluate(() => document.body.innerText);
  check("rating note saved and rendered", text.includes("Weeknights are calm"));
  check("reviews section present", /What people say/i.test(text));
  check("no console errors on rating flow", errors.length === 0, errors[0] ?? "");
  await page.screenshot({ path: `${out}/rating-note.png` });
  await ctx.close();
}

// ── 5. Seeded notes appear as reviews ────────────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "maya@example.com");
  await openPlace(page, "Cannon", /Cannon & Crown/);
  const text = await page.evaluate(() => document.body.innerText);
  check("seeded rating notes shown", text.includes("The only bar that turns the sound on"));
  await ctx.close();
}

// ── 6. Followers / following lists ───────────────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "maya@example.com");
  await page.goto(`${base}/profile`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1200);
  await page.getByRole("link", { name: /Followers/ }).first().click();
  await page.waitForURL("**/followers", { timeout: 20000 });
  await page.waitForTimeout(1200);
  const followers = await page.evaluate(() => document.body.innerText);
  check("followers list reachable from profile", /Followers/.test(followers) && /Nina Alvarez|Theo Okafor/.test(followers));
  await page.screenshot({ path: `${out}/followers.png` });

  await page.getByRole("link", { name: /^Following$/ }).first().click();
  await page.waitForURL("**/following", { timeout: 20000 });
  await page.waitForTimeout(1200);
  check("following list reachable", /Following/.test(await page.evaluate(() => document.body.innerText)));
  await ctx.close();
}

// ── 7. Reports inbox, both perspectives ──────────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "lena@example.com"); // owns The Lumen Rooftop, which maya reported
  await page.goto(`${base}/profile/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText);
  check("owner sees reports about their listing", text.includes("The Lumen Rooftop"));
  check("owner inbox shows an open count", /open/i.test(text));
  check("reporter identity not shown", !/maya|Maya Reyes/.test(text), text.match(/maya[^\n]*/i)?.[0] ?? "");
  await page.screenshot({ path: `${out}/reports-owner.png`, fullPage: true });

  await page.goto(`${base}/profile/reports`, { waitUntil: "domcontentloaded" });
  await ctx.close();
}
{
  const { ctx, page } = await newCtx();
  await signIn(page, "maya@example.com");
  await page.goto(`${base}/profile/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const text = await page.evaluate(() => document.body.innerText);
  check("reporter sees what they filed", text.includes("You reported this"));
  await ctx.close();
}

// ── 8. Owner hide / publish ──────────────────────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "lena@example.com");
  await openPlace(page, "Wren Street", /Wren Street Wine Porch/);

  await page.getByRole("button", { name: /^Hide$/ }).click();
  await page.waitForTimeout(2500);
  const hidden = await page.evaluate(() => document.body.innerText);
  check("hide marks the listing hidden", /Hidden from the map|Hidden from discovery/i.test(hidden));
  await page.screenshot({ path: `${out}/owner-hidden.png` });

  await page.getByRole("button", { name: /^Publish$/ }).click();
  await page.waitForTimeout(2500);
  check("publish restores the listing", /Listed on the map/i.test(await page.evaluate(() => document.body.innerText)));
  await ctx.close();
}

// ── 9. Multi-photo contribution ──────────────────────────────────────────────
{
  const { ctx, page } = await newCtx();
  await signIn(page, "theo@example.com");
  await openPlace(page, "Meeple", /Meeple Cellar/);

  await page.getByRole("button", { name: /Add photos/ }).click();
  await page.waitForTimeout(600);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  await page.locator('input[type="file"][multiple]').first().setInputFiles([
    { name: "a.png", mimeType: "image/png", buffer: png },
    { name: "b.png", mimeType: "image/png", buffer: png },
  ]);
  await page.waitForTimeout(800);
  await page.getByRole("button", { name: /^Upload$/ }).click();
  await page.waitForTimeout(3000);
  const after = await page.evaluate(() => document.body.innerText);
  check("two photos uploaded to an existing place", /2\/6/.test(after), after.match(/\d\/6/)?.[0] ?? "");
  await page.screenshot({ path: `${out}/photos.png` });
  await ctx.close();
}

await browser.close();

const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) {
  console.log("FAILED:", failed.map((f) => f.name).join(" | "));
  process.exitCode = 1;
}
