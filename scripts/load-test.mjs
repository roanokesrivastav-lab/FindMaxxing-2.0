// Small concurrency check: hammers the map discovery endpoint and a place page
// on a fresh demo server (or LOAD_BASE_URL) with autocannon, run through npx so
// it never becomes a dependency. Reports throughput, latency and errors; exits
// 1 if any request errored or returned a 5xx.
//
//   npm run build && node scripts/load-test.mjs [--connections 20] [--duration 15]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { startDemoServer } from "./lib/demo-server.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => (argv.includes(name) ? Number(argv[argv.indexOf(name) + 1]) : fallback);
const CONNECTIONS = opt("--connections", 20);
const DURATION = opt("--duration", 15);

const seedId = (label) => {
  const h = createHash("sha256").update(`findmaxxing:${label}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

let server = null;
const base = process.env.LOAD_BASE_URL ?? (server = await startDemoServer({ port: Number(process.env.LOAD_PORT ?? 3213) })).base;
const targets = [
  ["map markers (Columbus viewport)", `${base}/api/discover/map?bbox=-83.12,39.90,-82.88,40.04&kind=all`],
  ["place page", `${base}/places/${seedId("place:Meeple Cellar")}`],
];

let failed = false;
try {
  for (const [label, url] of targets) {
    // Warm the route before measuring; one retry covers a connection reset
    // while the server is still settling after start-up.
    await fetch(url).then((r) => r.arrayBuffer()).catch(() => fetch(url).then((r) => r.arrayBuffer()));
    const raw = execFileSync("npx", ["--yes", "autocannon@8", "-c", String(CONNECTIONS), "-d", String(DURATION), "-j", url], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const r = JSON.parse(raw);
    const bad = r.errors + r.timeouts + (r["5xx"] ?? 0);
    if (bad) failed = true;
    console.log(
      `${label}\n  ${r.requests.average.toFixed(0)} req/s (${r.requests.total} in ${DURATION}s, ${CONNECTIONS} connections)` +
        `\n  latency p50 ${r.latency.p50} ms · p97.5 ${r.latency.p97_5} ms · p99 ${r.latency.p99} ms · max ${r.latency.max} ms` +
        `\n  errors ${r.errors} · timeouts ${r.timeouts} · non-2xx ${r.non2xx}`,
    );
  }
} finally {
  if (server) await server.stop();
}
process.exit(failed ? 1 : 0);
