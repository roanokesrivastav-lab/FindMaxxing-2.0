/**
 * Roadmap 1.1: design tokens and primitives. Renders each primitive on the server (as the app does)
 * and checks the token rules in globals.css: three type roles in their pixel ranges, the spacing
 * scale, role-based surfaces (shadow only on raised), status as text + shape, the no-photo fallback,
 * no DateBlock, and the demo-only /dev/ui page.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Surface } from "../src/components/ui/Surface";
import { Row } from "../src/components/ui/Row";
import { SectionHeader } from "../src/components/ui/SectionHeader";
import { StatusLabel, type StatusTone } from "../src/components/ui/StatusLabel";
import { PlaceGlyph } from "../src/components/ui/PlaceGlyph";
import { devUiAvailable } from "../src/lib/devUi";

vi.mock("next/navigation", () => ({ notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }); } }));

const root = path.join(__dirname, "..");
const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
const html = (el: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(el);
const token = (name: string) => new RegExp(`--${name}:\\s*([^;]+);`).exec(css)?.[1].trim() ?? "";
/** min/max px of a clamp(a rem, …, b rem) or a plain rem value, at a 16px root. */
const pxRange = (value: string) => {
  const rems = [...value.matchAll(/([\d.]+)rem/g)].map((m) => Number(m[1]) * 16);
  return value.startsWith("clamp(") ? [rems[0], rems[rems.length - 1]] : [rems[0], rems[0]];
};
const block = (selector: string) => new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

afterEach(() => vi.unstubAllEnvs());

describe("tokens (globals.css)", () => {
  it("three type roles in the phone ranges: page title 28–32, item title 16–18, body 14–16", () => {
    expect(pxRange(token("text-page-title"))).toEqual([28, 32]);
    expect(pxRange(token("text-item-title"))).toEqual([16, 18]);
    expect(pxRange(token("text-body"))).toEqual([14, 16]);
    expect(block(".type-page-title")).toMatch(/var\(--font-display\)/); // Bricolage
    expect(block(".type-item-title")).toMatch(/var\(--font-sans\)/); // Figtree
    expect(block(".type-body")).toMatch(/var\(--font-sans\)/);
  });

  it("spacing scale: 4/8 within an item, 16 between rows, 24–32 between sections, one left edge", () => {
    expect(pxRange(token("spacing-hair"))).toEqual([4, 4]);
    expect(pxRange(token("spacing-item"))).toEqual([8, 8]);
    expect(pxRange(token("spacing-row"))).toEqual([16, 16]);
    expect(pxRange(token("spacing-section"))).toEqual([24, 32]);
    expect(pxRange(token("spacing-edge"))).toEqual([16, 16]);
  });

  it("role-based surfaces: only raised has a shadow; flat has no box; inset is tinted with no border", () => {
    expect(block(".surface-raised")).toMatch(/box-shadow/);
    for (const s of [".surface-flat", ".surface-inset"]) expect(block(s)).not.toMatch(/box-shadow/);
    expect(block(".surface-flat")).not.toMatch(/border-radius|background:\s*var/);
    expect(block(".surface-inset")).toMatch(/background:\s*var\(--color-paper-2\)/);
    expect(block(".surface-inset")).not.toMatch(/border:/);
    expect(css).toMatch(/\.treatment-editorial\s*\{/);
    expect(css).toMatch(/\.treatment-utility\s*\{/);
  });

  it("keeps the warm paper palette and both fonts", () => {
    expect(token("color-paper")).toBe("#f6f4ee");
    expect(token("font-sans")).toMatch(/--font-figtree/);
    expect(token("font-display")).toMatch(/--font-bricolage/);
  });

  it("has no DateBlock primitive (the calendar date block was rejected)", () => {
    expect(existsSync(path.join(root, "src/components/ui/DateBlock.tsx"))).toBe(false);
    const ui = readdirSync(path.join(root, "src/components/ui")).map((f) => readFileSync(path.join(root, "src/components/ui", f), "utf8"));
    expect(ui.some((src) => /DateBlock/.test(src))).toBe(false);
  });
});

describe("primitives", () => {
  it("Surface renders its role class and nothing decorative", () => {
    for (const variant of ["raised", "flat", "inset"] as const) {
      expect(html(h(Surface, { variant }, "x"))).toBe(`<div data-surface="${variant}" class="surface-${variant}">x</div>`);
    }
    expect(html(h(Surface, { variant: "inset", as: "section", className: "p-row" }, "tip"))).toBe('<section data-surface="inset" class="surface-inset p-row">tip</section>');
  });

  it("Row: a photo leads when there is one; PlaceGlyph stands in when there isn't; long titles wrap", () => {
    const withPhoto = html(h(Row, { title: "Corner Tea", meta: "Coffee · 0.4 mi", media: { photo: { src: "/p.webp", alt: "The tea counter" } } }));
    expect(withPhoto).toMatch(/<img src="\/p.webp" alt="The tea counter"/);
    expect(withPhoto).not.toMatch(/data-glyph/);
    const noPhoto = html(h(Row, { title: "Corner Tea", media: { categorySlug: "coffee-study" } }));
    expect(noPhoto).toMatch(/data-glyph="coffee-study"/);
    expect(noPhoto).not.toMatch(/<img/);
    const long = "A".repeat(40) + " " + "B".repeat(120);
    const longRow = html(h(Row, { title: long, meta: long, trailing: "4.6 (31)" }));
    expect(longRow).toMatch(/type-item-title[^"]*line-clamp-2[^"]*break-words/);
    expect(longRow).toContain(long);
    expect(longRow).toMatch(/class="surface-flat"/);
    // 200% text: the row wraps and the text block keeps a usable width instead of breaking mid-word.
    expect(longRow).toMatch(/class="flex flex-wrap items-center/);
    expect(longRow).toMatch(/flex-1 basis-\[10rem\]/);
    expect(html(h(Row, { title: "Go", href: "/places/1", as: "li" }))).toMatch(/^<li data-row="" class="surface-flat"><a [^>]*href="\/places\/1"/);
  });

  it("StatusLabel: every tone pairs its text with its own icon shape", () => {
    const tones: StatusTone[] = ["positive", "pending", "warning", "negative", "neutral"];
    const shapes = tones.map((tone) => {
      const out = html(h(StatusLabel, { tone, children: `label-${tone}` }));
      expect(out).toContain(`<span>label-${tone}</span>`);
      expect(out).toMatch(/<svg[^>]*aria-hidden="true"/);
      return /class="lucide lucide-([a-z0-9-]+)/.exec(out)?.[1];
    });
    expect(new Set(shapes).size).toBe(tones.length);
  });

  it("PlaceGlyph: decorative unless labelled; unknown categories fall back to 'other'", () => {
    expect(html(h(PlaceGlyph, { categorySlug: "food" }))).toMatch(/aria-hidden="true"/);
    const labelled = html(h(PlaceGlyph, { categorySlug: "food", label: "Food" }));
    expect(labelled).toMatch(/role="img" aria-label="Food"/);
    expect(labelled).not.toMatch(/aria-hidden="true" class/);
    expect(html(h(PlaceGlyph, { categorySlug: "no-such-category" }))).toMatch(/data-glyph="other"/);
  });

  it("SectionHeader: a real heading, with the action wrapping beside it", () => {
    const out = html(h(SectionHeader, { title: "Nearby", action: "See all", id: "near" }));
    expect(out).toMatch(/<h2 id="near" class="type-item-title[^"]*">Nearby<\/h2>/);
    expect(out).toMatch(/flex-wrap/);
    expect(html(h(SectionHeader, { title: "x", as: "h3" }))).toMatch(/<h3/);
  });
});

describe("/dev/ui (demo only)", () => {
  it("is available only in demo mode with pilotFoundation on", () => {
    expect(devUiAvailable({ NEXT_PUBLIC_FEATURES: "pilot" })).toBe(true);
    expect(devUiAvailable({ NEXT_PUBLIC_FEATURES: "pilotFoundation" })).toBe(true);
    expect(devUiAvailable({ NEXT_PUBLIC_FEATURES: "all" })).toBe(false);
    expect(devUiAvailable({ NEXT_PUBLIC_FEATURES: "" })).toBe(false);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://x.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "k");
    expect(devUiAvailable({ NEXT_PUBLIC_FEATURES: "pilot" })).toBe(false);
  });

  it("renders every primitive with long text and no photo, and a 200% text view; 404 when unavailable", async () => {
    const { default: Page } = await import("../src/app/dev/ui/page");
    const normal = html(await Page({ searchParams: Promise.resolve({}) }));
    for (const marker of ['data-surface="raised"', 'data-surface="flat"', 'data-surface="inset"', "data-row", "data-status", "data-glyph", "type-page-title", "<h2"]) {
      expect(normal).toContain(marker);
    }
    expect(normal).toMatch(/Kowalczyk-Abernathy/);
    expect(normal).toMatch(/No photo: PlaceGlyph/);
    expect(normal).not.toMatch(/font-size:200%/);
    expect(normal).not.toMatch(/(src|href)="https?:/); // no external image or asset requests
    expect(html(await Page({ searchParams: Promise.resolve({ text: "200" }) }))).toMatch(/html\{font-size:200%!important\}/);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "all");
    await expect(Page({ searchParams: Promise.resolve({}) })).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
  });
});
