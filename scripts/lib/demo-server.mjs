// Starts the built app in demo mode for scripted browser runs: a fresh
// in-memory store (nothing read from or written to .data), uploads in a scratch
// folder, and production settings. Returns its base URL and a stop function.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export async function startDemoServer({ port = 3210, env = {} } = {}) {
  const base = `http://localhost:${port}`;
  if (!existsSync(".next/BUILD_ID")) throw new Error("no production build: run `npm run build` first");
  // Something already answering (an earlier run still shutting down, a dev
  // server) would be tested instead of a fresh app.
  if (await fetch(`${base}/api/health`).then(() => true, () => false)) {
    throw new Error(`something is already listening on port ${port}; stop it or choose another port`);
  }
  const uploads = mkdtempSync(path.join(tmpdir(), "findmaxxing-uploads-"));
  const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-p", String(port)], {
    env: {
      ...process.env,
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      FINDMAXXING_DEMO_FRESH: "1",
      FINDMAXXING_DEMO_NO_PERSIST: "1",
      FINDMAXXING_ALLOW_DEMO_IN_PRODUCTION: "1",
      FINDMAXXING_DEMO_UPLOAD_DIR: uploads,
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  const stop = async () => {
    const exited = new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once("exit", resolve)));
    child.kill();
    await exited;
    rmSync(uploads, { recursive: true, force: true });
  };
  const started = Date.now();
  for (;;) {
    if (await fetch(`${base}/api/health`).then((r) => r.ok, () => false)) return { base, stop, uploads, log: () => log };
    if (child.exitCode !== null || Date.now() - started > 60_000) {
      await stop();
      throw new Error(`server did not start\n${log}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** True once React has attached its props to the element (the page is hydrated). */
export async function hydrated(page, selector) {
  await page.waitForFunction(
    (sel) => {
      const el = document.querySelector(sel);
      return !!el && Object.keys(el).some((k) => k.startsWith("__reactProps"));
    },
    selector,
    { timeout: 30_000 },
  );
}

/**
 * Browser launch options. Locally the installed Chrome; E2E_CHANNEL=chromium
 * uses Playwright's own download (CI installs it with `npx playwright-core install chromium`).
 */
export function launchOptions() {
  const channel = process.env.E2E_CHANNEL ?? "chrome";
  return { headless: true, ...(channel === "chromium" ? {} : { channel }) };
}
