// Image weight of a place page with six photos, measured in a real browser at
// the Lighthouse mobile profile (412px wide, DPR 1.75). The budget is 600KB of
// images (see README, "Mobile budget"); exits 1 over it.
//
//   npm run build && node scripts/measure-images.mjs
//
// Starts a fresh demo server, signs in, adds a place with six realistic
// photo-sized images through the real form (so they go through the image
// pipeline), then loads its page in a new context and sums the bytes of every
// image response.
import { chromium } from "playwright-core";
import sharp from "sharp";
import { hydrated, launchOptions, startDemoServer } from "./lib/demo-server.mjs";

const BUDGET = 600 * 1024;
const server = await startDemoServer({ port: Number(process.env.MEASURE_PORT ?? 3212) });
const browser = await chromium.launch(launchOptions());

/** A noisy, photo-like 4000×3000 JPEG (~3-5MB), different each time. */
async function photo(seed) {
  const w = 1000;
  const h = 750;
  const raw = Buffer.alloc(w * h * 3);
  let x = seed * 9973;
  for (let i = 0; i < raw.length; i += 3) {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    const n = x % 60;
    const px = (i / 3) % w;
    const py = Math.floor(i / 3 / w);
    raw[i] = (px / w) * 200 + n;
    raw[i + 1] = (py / h) * 180 + n;
    raw[i + 2] = ((px + py + seed * 50) % 255) * 0.6 + n;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 3 } }).resize(4000, 3000).jpeg({ quality: 92 }).toBuffer();
}

let exitCode = 0;
try {
  const photos = await Promise.all([1, 2, 3, 4, 5, 6].map(photo));
  const original = photos.reduce((s, p) => s + p.length, 0);

  // Add the place as maya.
  const author = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await author.newPage();
  await page.goto(`${server.base}/auth/sign-in?next=/places/new`, { waitUntil: "domcontentloaded" });
  await hydrated(page, "#email");
  await page.fill("#email", "maya@example.com");
  await page.fill("#password", "findmaxxing");
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await page.waitForURL("**/places/new", { timeout: 30_000 });
  await hydrated(page, "#name");
  await page.fill("#name", "Six photo spot");
  await page.getByRole("button", { name: /Pickup sports/ }).first().click();
  await page.fill("#description", "A place with a full gallery, for measuring image weight.");
  await page.locator('input[type="file"][multiple]').first().setInputFiles(photos.map((buffer, i) => ({ name: `photo-${i + 1}.jpg`, mimeType: "image/jpeg", buffer })));
  const map = page.locator(".maplibregl-map, .mapboxgl-map").first();
  await map.waitFor({ timeout: 30_000 });
  await page.waitForTimeout(1500);
  const box = await map.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  // The browser shrinks photos before upload; wait until the form allows submitting.
  const submit = page.getByRole("button", { name: /Add to the map/ });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Add to the map/.test(x.textContent ?? ""));
    return b && !b.disabled;
  }, null, { timeout: 120_000 });
  await submit.click();
  await page.waitForURL("**/places/*?new=1", { timeout: 120_000 });
  const placeUrl = new URL(page.url()).pathname;
  await author.close();

  // Load it as a phone on the Lighthouse mobile profile.
  const viewer = await browser.newContext({ viewport: { width: 412, height: 823 }, deviceScaleFactor: 1.75, isMobile: true, hasTouch: true });
  const p = await viewer.newPage();
  // Signed in, so the measurement is of the page a real member sees.
  await p.goto(`${server.base}/auth/sign-in?next=${encodeURIComponent(placeUrl)}`, { waitUntil: "domcontentloaded" });
  await hydrated(p, "#email");
  await p.fill("#email", "jules@example.com");
  await p.fill("#password", "findmaxxing");
  const images = [];
  p.on("response", async (res) => {
    if (res.request().resourceType() !== "image" || !res.url().includes("/api/photos/")) return;
    const body = await res.body().catch(() => null);
    images.push({ url: new URL(res.url()).pathname + new URL(res.url()).search, bytes: body?.length ?? 0 });
  });
  await p.getByRole("button", { name: /^Sign in$/ }).click();
  await p.waitForURL(`**${placeUrl}`, { timeout: 30_000 });
  // Scroll the whole gallery into view so every lazy image loads.
  for (let y = 0; y < 6000; y += 400) {
    await p.evaluate((top) => window.scrollTo(0, top), y);
    await p.waitForTimeout(150);
  }
  await p.waitForLoadState("networkidle");
  await viewer.close();

  const total = images.reduce((s, i) => s + i.bytes, 0);
  for (const i of images) console.log(`  ${String(Math.round(i.bytes / 1024)).padStart(5)} KB  ${i.url}`);
  console.log(`six photos: ${(original / 1024 / 1024).toFixed(1)} MB uploaded; ${images.length} image responses, ${Math.round(total / 1024)} KB transferred at 412px / DPR 1.75 (budget ${BUDGET / 1024} KB)`);
  if (images.length < 6) {
    console.error("FAIL: fewer than six photo responses — the gallery did not load");
    exitCode = 1;
  } else if (total > BUDGET) {
    console.error("FAIL: over the mobile image budget");
    exitCode = 1;
  } else {
    console.log("PASS: within the mobile image budget");
  }
} catch (err) {
  console.error(`FAIL: ${err instanceof Error ? err.message : err}`);
  exitCode = 1;
} finally {
  await browser.close();
  await server.stop();
}
process.exit(exitCode);
