// Scripted browser checks for moderation (demo mode). Exits non-zero on failure.
// Usage: FINDMAXXING_DEMO_NO_PERSIST=1 npm run start (in another terminal) && node scripts/smoke-moderation.mjs [baseUrl] [outDir]
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const base = process.argv[2] ?? "http://localhost:3000";
const out = process.argv[3] ?? ".data/smoke-moderation";
mkdirSync(out, { recursive: true });

const browser = await chromium.launch({ channel: "chrome", headless: true });
const results = [];
function check(name, pass, detail = "") {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** True once React has attached its props to the element (the page is hydrated). */
async function hydrated(page, selector) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
    },
    selector,
    { timeout: 20000 },
  );
}

async function session(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.goto(`${base}/auth/sign-in`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "#email");
  await page.fill("#email", email);
  await page.fill("#password", "findmaxxing");
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth"), { timeout: 20000 });
  return { ctx, page };
}

const LUMEN = "/places/" + (await (async () => {
  // Resolve the seeded place id the same way the app does.
  const { createHash } = await import("node:crypto");
  const h = createHash("sha256").update("findmaxxing:place:The Lumen Rooftop").digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
})());

// 1. A non-moderator gets a 404 for the queue.
{
  const { ctx, page } = await session("maya@example.com");
  const res = await page.goto(`${base}/moderation`);
  check("non-moderator gets 404 for /moderation", res?.status() === 404, `status ${res?.status()}`);
  await ctx.close();
}

// 2. The moderator sees the queue, opens The Lumen Rooftop and removes it with a reason.
{
  const { ctx, page } = await session("sam@example.com");
  const res = await page.goto(`${base}/moderation`, { waitUntil: "domcontentloaded" });
  check("moderator opens the queue", res?.status() === 200);
  const card = page.locator('a[href^="/moderation/place/"]').filter({ hasText: "The Lumen Rooftop" });
  check("queue lists The Lumen Rooftop with its open report", (await card.count()) === 1 && /1 open/.test(await card.innerText()));
  await page.screenshot({ path: `${out}/1-queue.png`, fullPage: true });
  await card.click();
  await page.waitForURL("**/moderation/place/**");
  await hydrated(page, "button.rounded-full");
  check("target page shows who reported it", (await page.getByText("@maya_r").count()) > 0);
  await page.getByRole("button", { name: "Remove content" }).click();
  await page.getByRole("button", { name: /^Remove$/ }).click();
  await page.waitForTimeout(800);
  check("removing without a reason is refused on the reason field", (await page.getByText("Give a reason").count()) > 0);
  await page.fill("#moderation-reason", "Repeated reports of unsafe crowding");
  await page.getByRole("button", { name: /^Remove$/ }).click();
  await page.getByText("Removed the content").waitFor({ timeout: 15000 });
  check("history records the removal with the reason", (await page.getByText("“Repeated reports of unsafe crowding”").count()) === 1);
  await page.screenshot({ path: `${out}/2-removed.png`, fullPage: true });
  await ctx.close();
}

// 3. The place is gone for its owner and for everyone else; the owner sees why.
{
  const { ctx, page } = await session("lena@example.com");
  // Routes with a loading.tsx stream a 200 before notFound() renders, so check the page itself.
  await page.goto(`${base}${LUMEN}`, { waitUntil: "networkidle" });
  const ownerText = await page.locator("body").innerText();
  check("owner gets the not-found page for their removed place", /Off the map/.test(ownerText) && !/The Lumen Rooftop/.test(ownerText));
  await page.goto(`${base}/profile`, { waitUntil: "domcontentloaded" });
  const notice = page.locator("section", { hasText: "Removed by moderators" });
  check("owner's profile explains the removal", (await notice.count()) === 1 && /unsafe crowding/.test(await notice.innerText()));
  await page.screenshot({ path: `${out}/3-owner-notice.png`, fullPage: true });
  await ctx.close();
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  await anonPage.goto(`${base}${LUMEN}`, { waitUntil: "networkidle" });
  const anonText = await anonPage.locator("body").innerText();
  check("anonymous visitors get the not-found page too", /Off the map/.test(anonText) && !/The Lumen Rooftop/.test(anonText));
  await anon.close();
}

// 4. The reporter sees that it was resolved, not by whom.
{
  const { ctx, page } = await session("maya@example.com");
  await page.goto(`${base}/profile/reports`, { waitUntil: "domcontentloaded" });
  const text = await page.locator("body").innerText();
  check("reporter sees the report resolved", /a moderator resolved it on/.test(text));
  check("reporter does not see who resolved it", !/sam_k|Sam Kowalski/.test(text));
  await ctx.close();
}

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
