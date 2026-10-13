/**
 * The installable app (Session 19): the manifest and its icons, and the
 * service worker's caching rules (private pages forgotten on sign-out, no
 * API or action responses ever cached).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import sharp from "sharp";
import manifest from "../src/app/manifest";

describe("the web app manifest", () => {
  it("is installable: standalone, scoped, with 192 and 512 icons and a maskable one that exist", async () => {
    const m = manifest();
    expect(m).toMatchObject({ display: "standalone", start_url: "/", scope: "/", id: "/" });
    for (const icon of m.icons!.filter((i) => i.type === "image/png")) {
      const file = `public${icon.src}`;
      expect(existsSync(file)).toBe(true);
      const meta = await sharp(file).metadata();
      expect(`${meta.width}x${meta.height}`).toBe(icon.sizes);
    }
    expect(m.icons!.some((i) => i.purpose === "maskable")).toBe(true);
    expect(m.icons!.some((i) => i.sizes === "192x192")).toBe(true);
  });
});

describe("the service worker", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  it("caches only static assets and saved-list pages, and can forget the pages", () => {
    expect(sw).toMatch(/isSavedPage = \(url\) => url\.pathname === "\/saved" \|\| \/\^\\\/saved\\\/\[0-9a-f-\]\{36\}\$\//);
    expect(sw).toContain('if (req.method !== "GET") return;');
    expect(sw).toContain('if (req.mode !== "navigate") return;');
    expect(sw).not.toMatch(/\/api\//);
    expect(sw).toContain('"forget-private-pages"');
    expect(sw).toContain('addEventListener("push"');
  });
  it("is asked to forget private pages on sign-out and account deletion", () => {
    expect(readFileSync("src/components/auth/SignOutButton.tsx", "utf8")).toContain("forgetPrivatePages()");
    expect(readFileSync("src/components/profile/DeleteAccount.tsx", "utf8")).toContain("forgetPrivatePages()");
  });
});
