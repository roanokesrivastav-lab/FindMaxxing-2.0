// Feature-enabled release smoke test. Always local, fresh demo state; no billing,
// hosted Supabase, analytics forwarding, or real push credentials are inherited.
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright-core";
import { hydrated, launchOptions, startDemoServer } from "./lib/demo-server.mjs";

const out = process.env.FEATURE_E2E_OUT ?? ".data/e2e-features";
mkdirSync(out, { recursive: true });
const server = await startDemoServer({ port: Number(process.env.FEATURE_E2E_PORT ?? 3212), env: {
  NEXT_PUBLIC_FEATURES: "messaging,notifications,payments,ads,admin,reputation,recommendations,pwa",
  STRIPE_SECRET_KEY: "", STRIPE_WEBHOOK_SECRET: "", VAPID_PUBLIC_KEY: "", VAPID_PRIVATE_KEY: "",
  POSTHOG_KEY: "", PLAUSIBLE_DOMAIN: "", ANALYTICS_FORWARD_SECRET: "", SENTRY_DSN: "",
} });
let browser;
const results = [], errors = [], contexts = [];
let shots = 0;
async function step(name, run) {
  try { await run(); results.push({ name, pass: true }); console.log(`PASS  ${name}`); }
  catch (err) { results.push({ name, pass: false }); console.error(`FAIL  ${name}: ${err.message.split("\n")[0]}`); }
}
async function person(email) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } }); contexts.push(ctx);
  const page = await ctx.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (m) => { if (m.type() === "error" && /Content Security Policy|Refused to/i.test(m.text())) errors.push(m.text()); });
  await page.goto(`${server.base}/auth/sign-in`, { waitUntil: "domcontentloaded" }); await hydrated(page, "#email");
  await page.fill("#email", email); await page.fill("#password", "findmaxxing");
  await page.getByRole("button", { name: /^Sign in$/ }).click();
  await page.waitForURL((u) => !u.pathname.startsWith("/auth"));
  return page;
}
async function visit(page, path) {
  const res = await page.goto(`${server.base}${path}`, { waitUntil: "domcontentloaded" });
  assert.equal(res?.status(), 200, `${path} must be enabled`); await hydrated(page, "h1");
}
async function snap(page, label) { await page.screenshot({ path: `${out}/${++shots}-${label}.png` }); }
try {
  browser = await chromium.launch(launchOptions());
  const buyer = await person("maya@example.com"), host = await person("dev@example.com"), advertiser = await person("lena@example.com");
  let eventPath;
  const title = `Feature gate ${Date.now().toString(36)}`, headline = `${title} card`, message = `${title} private test message`;
  await step("Plus checkout is explicitly simulated, activates and cancels", async () => {
    await visit(buyer, "/plus"); await buyer.getByRole("button", { name: "Get Plus", exact: true }).click();
    await buyer.waitForURL("**/checkout/demo?plan=plus");
    await buyer.getByText("Demo checkout.", { exact: true }).waitFor();
    await buyer.getByRole("button", { name: "Pay (demo, no charge)", exact: true }).click();
    await buyer.waitForURL("**/plus?status=success"); await buyer.getByRole("button", { name: "Manage your plan" }).click();
    await buyer.waitForURL("**/checkout/demo?plan=manage"); await buyer.getByRole("button", { name: "Cancel Plus (demo)" }).click();
    await buyer.waitForURL((u) => u.pathname === "/plus" && !u.search); await buyer.getByRole("button", { name: "Get Plus", exact: true }).waitFor();
    await snap(buyer, "plus");
  });
  await step("messaging starts a permitted conversation and saves a message", async () => {
    await visit(buyer, "/u/theo"); await buyer.getByRole("button", { name: "Message", exact: true }).click();
    await buyer.waitForURL("**/messages/*"); await buyer.getByPlaceholder("Write a message").fill(message);
    await buyer.getByRole("button", { name: "Send", exact: true }).click(); await buyer.getByText(message, { exact: true }).waitFor();
    await snap(buyer, "chat");
  });
  await step("notification settings save without browser push credentials", async () => {
    await visit(buyer, "/profile/settings"); await buyer.getByRole("button", { name: "Save notification settings" }).click();
    await buyer.getByText("Notification settings saved", { exact: true }).waitFor(); await snap(buyer, "notifications-settings");
    await visit(buyer, "/notifications");
  });
  await step("host creates and prices a future event", async () => {
    await visit(host, "/events/new"); await host.fill("#title", title);
    await host.getByRole("button", { name: /Pickup sports/ }).first().click();
    await host.fill("#description", "A future event for the isolated feature release gate."); await host.fill("#locationName", "Release test pitch");
    const map = host.locator(".maplibregl-map, .mapboxgl-map").first(); await map.waitFor();
    await host.waitForTimeout(1500); const box = await map.boundingBox(); assert(box);
    await host.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await host.getByRole("button", { name: /Create event/ }).click(); await host.waitForURL("**/events/*?new=1");
    eventPath = new URL(host.url()).pathname; await host.locator("#ticket-price").fill("15");
    await host.getByRole("button", { name: "Save price" }).click(); await host.getByText("Tickets are $15.00", { exact: true }).waitFor();
    await snap(host, "priced-event");
  });
  await step("ticket checkout cancel does not admit a buyer", async () => {
    assert(eventPath, "event setup failed"); await visit(buyer, eventPath);
    await buyer.getByRole("button", { name: /Buy ticket/ }).click(); await buyer.waitForURL("**/checkout/demo?ticket=*");
    await buyer.getByRole("button", { name: "Cancel", exact: true }).click(); await buyer.waitForURL(`**${eventPath}`);
    await buyer.getByRole("button", { name: /Buy ticket/ }).waitFor();
    await visit(buyer, "/profile/tickets"); await buyer.getByText(/Not completed/).waitFor();
  });
  await step("settled demo ticket admits the buyer and records payment", async () => {
    assert(eventPath, "event setup failed"); await visit(buyer, eventPath);
    await buyer.getByRole("button", { name: /Buy ticket/ }).click(); await buyer.waitForURL("**/checkout/demo?ticket=*");
    await buyer.getByRole("button", { name: "Pay (demo, no charge)", exact: true }).click();
    await buyer.waitForURL(`**${eventPath}?ticket=success`); await buyer.getByRole("button", { name: /You're going/ }).waitFor();
    await visit(buyer, "/profile/tickets"); await buyer.getByText(/Paid ·/).waitFor(); await snap(buyer, "paid-ticket");
  });
  await step("host cancellation refunds the paid demo ticket", async () => {
    assert(eventPath, "event setup failed"); await visit(host, eventPath); await host.getByRole("button", { name: "Owner actions" }).click();
    await host.getByRole("dialog", { name: "Manage event" }).getByRole("button", { name: "Cancel event" }).click();
    await host.getByRole("dialog", { name: "Cancel this event?" }).getByRole("button", { name: "Cancel event" }).click();
    await host.getByText("Event cancelled", { exact: true }).waitFor(); await visit(buyer, "/profile/tickets");
    await buyer.getByText(/Refunded ·/).waitFor(); await snap(buyer, "refunded-ticket");
  });
  await step("advertiser submits an owned listing for review", async () => {
    await visit(advertiser, "/ads"); await advertiser.fill("#ad-headline", headline);
    await advertiser.getByRole("button", { name: "Send for review" }).click(); await advertiser.getByText("Sent for review", { exact: true }).waitFor();
    await advertiser.getByRole("list", { name: "Your campaigns" }).getByText(headline, { exact: true }).waitFor();
  });
  await step("admin approves the campaign; advertiser pays only through labeled demo checkout", async () => {
    await visit(host, "/admin/ads"); const card = host.getByRole("listitem").filter({ hasText: headline });
    await card.getByRole("button", { name: "Approve", exact: true }).click(); await host.getByText("Approved: waiting for payment", { exact: true }).waitFor();
    await visit(advertiser, "/ads"); const campaign = advertiser.getByRole("listitem").filter({ hasText: headline });
    await campaign.getByRole("button", { name: "Pay and start" }).click(); await advertiser.waitForURL("**/checkout/demo?campaign=*");
    await advertiser.getByText("Demo checkout.", { exact: true }).waitFor(); await advertiser.getByRole("button", { name: "Pay (demo, no charge)", exact: true }).click();
    await advertiser.waitForURL("**/ads?paid=1"); await advertiser.getByRole("listitem").filter({ hasText: headline }).getByRole("button", { name: "Pause", exact: true }).waitFor();
    await snap(advertiser, "campaign-running");
  });
  await step("campaign pause/resume preserves ownership controls", async () => {
    const campaign = advertiser.getByRole("listitem").filter({ hasText: headline });
    await campaign.getByRole("button", { name: "Pause", exact: true }).click(); await campaign.getByRole("button", { name: "Resume", exact: true }).click();
    await campaign.getByRole("button", { name: "Pause", exact: true }).waitFor();
    const res = await buyer.goto(`${server.base}/admin/ads`); assert.equal(res?.status(), 404, "non-admin cannot enter campaign review");
  });
  await step("no browser page or CSP errors", async () => assert.deepEqual(errors, []));
} finally {
  for (const ctx of contexts) await ctx.close();
  await browser?.close(); await server.stop();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} feature checks passed; screenshots in ${out}`);
process.exitCode = failed.length ? 1 : 0;
