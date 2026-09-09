// Scripted browser walkthrough of the main flows (demo mode). Requires Google Chrome installed.
// Usage: npm run dev (in another terminal) && node scripts/smoke.mjs [outDir]

import { chromium } from "playwright-core";
const base = "http://localhost:3000";
const out = process.argv[2] ?? ".data/smoke";
import { mkdirSync } from "node:fs";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const results = [];
async function run(name, width, height, url, actions) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, isMobile: width < 500, hasTouch: width < 500 });
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 300)); });
  page.on("pageerror", (e) => errors.push("PAGEERROR " + e.message.slice(0, 300)));
  await page.goto(base + url, { waitUntil: "domcontentloaded", timeout: 60000 }).catch((e) => errors.push("NAV " + e.message));
  if (actions) await actions(page).catch((e) => errors.push("ACTION " + e.message));
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${out}/${name}.png`, fullPage: false });
  results.push({ name, url: page.url(), errors });
  await ctx.close();
}
const M = [390, 844], D = [1366, 860];
const ids = { place: "a383ba25-872d-4154-ae60-51da7901394f", event: "2194b5a2-2f6c-466a-af4d-cf70d0d11552" };
await run("m-explore", ...M, "/");
await run("d-explore", ...D, "/");
await run("m-explore-list", ...M, "/", async (p) => { await p.getByRole("button", { name: /^List$/ }).click(); await p.waitForTimeout(500); });
await run("m-explore-search", ...M, "/", async (p) => { await p.getByLabel("Search places and events").fill("soccer"); await p.waitForTimeout(600); });
await run("m-place", ...M, `/places/${ids.place}`);
await run("d-place", ...D, `/places/${ids.place}`);
await run("m-event", ...M, `/events/${ids.event}`);
await run("m-events", ...M, "/events");
await run("m-people", ...M, "/people");
await run("m-signin", ...M, "/auth/sign-in");
await run("m-profile-anon", ...M, "/profile");
// Signed-in flow: demo persona sign-in → profile → place save → event join → create place
await run("m-signed-flow", ...M, "/auth/sign-in?next=/profile", async (p) => {
  await p.getByRole("button", { name: /Maya Reyes/ }).click();
  await p.waitForURL("**/profile", { timeout: 20000 });
});
await run("m-signed-place", ...M, "/auth/sign-in?next=/places/" + ids.place, async (p) => {
  await p.getByRole("button", { name: /Theo Okafor/ }).click();
  await p.waitForURL("**/places/**", { timeout: 20000 });
  await p.waitForTimeout(800);
  await p.getByRole("button", { name: /^(Save|Saved|Unsave)$/ }).click();
  await p.waitForTimeout(1200);
  await p.getByRole("radio", { name: "5 stars" }).click();
  await p.waitForTimeout(1200);
});
await run("m-signed-event", ...M, "/auth/sign-in?next=/events/" + ids.event, async (p) => {
  await p.getByRole("button", { name: /Jules Park/ }).click();
  await p.waitForURL("**/events/**", { timeout: 20000 });
  await p.waitForTimeout(800);
  await p.getByRole("button", { name: /Join event|You're going/ }).click();
  await p.waitForTimeout(1500);
});
await run("m-new-place", ...M, "/auth/sign-in?next=/places/new", async (p) => {
  await p.getByRole("button", { name: /Maya Reyes/ }).click();
  await p.waitForURL("**/places/new", { timeout: 20000 });
  await p.waitForTimeout(1500);
});
await run("m-new-place-submit", ...M, "/auth/sign-in?next=/places/new", async (p) => {
  await p.getByRole("button", { name: /Maya Reyes/ }).click();
  await p.waitForURL("**/places/new", { timeout: 20000 });
  await p.waitForTimeout(1500);
  await p.fill("#name", "Test Court From Playwright");
  await p.getByRole("button", { name: /Pickup sports/ }).click();
  await p.fill("#description", "An automated test place with enough description text.");
  await p.fill("#localTip", "Go early.");
  const map = p.locator(".maplibregl-map, .mapboxgl-map").first();
  await map.waitFor({ timeout: 15000 });
  await p.waitForTimeout(1500);
  const box = await map.boundingBox();
  await p.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await p.waitForTimeout(500);
  await p.getByRole("button", { name: /Add to the map/ }).click();
  await p.waitForURL("**/places/*?new=1", { timeout: 20000 });
  await p.waitForTimeout(1000);
});
await run("m-new-event-submit", ...M, "/auth/sign-in?next=/events/new", async (p) => {
  await p.getByRole("button", { name: /Sam Kowalski/ }).click();
  await p.waitForURL("**/events/new", { timeout: 20000 });
  await p.waitForTimeout(1500);
  await p.fill("#title", "Playwright pickup run");
  await p.getByRole("button", { name: /Pickup sports/ }).click();
  await p.fill("#description", "Automated event with enough description text here.");
  await p.selectOption("#placeId", { label: "Tuttle Lot Fields" });
  await p.fill("#capacity", "10");
  await p.waitForTimeout(500);
  await p.getByRole("button", { name: /Create event/ }).click();
  await p.waitForURL("**/events/*?new=1", { timeout: 20000 });
  await p.waitForTimeout(1000);
});
await run("m-edit-profile", ...M, "/auth/sign-in?next=/profile/edit", async (p) => {
  await p.getByRole("button", { name: /Maya Reyes/ }).click();
  await p.waitForURL("**/profile/edit", { timeout: 20000 });
  await p.fill("#bio", "Updated by playwright.");
  await p.getByRole("button", { name: /Save profile/ }).click();
  await p.waitForURL("**/profile", { timeout: 20000 });
  await p.waitForTimeout(800);
});
await run("d-people-follow", ...D, "/auth/sign-in?next=/people", async (p) => {
  await p.getByRole("button", { name: /Maya Reyes/ }).click();
  await p.waitForURL("**/people", { timeout: 20000 });
  await p.getByRole("button", { name: /^Follow$/ }).first().click();
  await p.waitForTimeout(1200);
});
await browser.close();
for (const r of results) console.log(r.name.padEnd(22), r.url.replace(base, "").padEnd(60), r.errors.length ? "ERRORS:\n   " + r.errors.join("\n   ") : "ok");
