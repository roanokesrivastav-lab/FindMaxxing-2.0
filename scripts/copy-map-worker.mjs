/**
 * Copies MapLibre's web-worker modules into public/ so they can be served as
 * plain ES modules. MapLibre resolves its worker with a dynamic
 * `new URL(..., import.meta.url)` that bundlers can't analyze, and the worker
 * imports a sibling module, so serving the files statically is the reliable fix.
 * Runs on postinstall; output is git-ignored.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const dist = path.dirname(require.resolve("maplibre-gl/package.json")) + "/dist";
const out = path.join(process.cwd(), "public", "maplibre");
mkdirSync(out, { recursive: true });
for (const f of ["maplibre-gl-worker.mjs", "maplibre-gl-shared.mjs"]) {
  const src = path.join(dist, f);
  if (!existsSync(src)) throw new Error(`Missing ${src}`);
  copyFileSync(src, path.join(out, f));
}
console.log(`Copied MapLibre worker to ${out}`);
