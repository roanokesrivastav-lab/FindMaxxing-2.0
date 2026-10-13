// Renders the PWA icons from src/app/icon.svg: `node scripts/generate-icons.mjs`.
// Regular icons keep the rounded square; the maskable one fills a full-bleed
// background with the pin inside the 80% safe zone; Apple's is opaque.
import sharp from "sharp";
import { readFileSync } from "node:fs";

const svg = readFileSync("src/app/icon.svg");
const BG = "#17181d";
for (const size of [192, 512]) {
  await sharp(svg, { density: 1024 }).resize(size, size).png().toFile(`public/icons/icon-${size}.png`);
}
const inner = Math.round(512 * 0.7);
const glyph = await sharp(svg, { density: 1024 }).resize(inner, inner).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: BG } })
  .composite([{ input: glyph, gravity: "center" }]).png().toFile("public/icons/maskable-512.png");
await sharp({ create: { width: 180, height: 180, channels: 4, background: BG } })
  .composite([{ input: await sharp(svg, { density: 1024 }).resize(180, 180).png().toBuffer() }]).flatten({ background: BG }).png().toFile("public/icons/apple-touch-icon.png");
console.log("icons written to public/icons");
