/**
 * Roadmap 2.5: the photo-first place page, behind pilotExplore. Runs the real page
 * route (src/app/places/[id]/page.tsx) against an isolated demo repository and
 * renders it on the server, as Next does: photo first, the blocks in order, friends'
 * actual reviews before everyone else's (never summarized), the disabled Add to
 * outing, claims that open their evidence, a complete no-photo layout, and today's
 * page untouched with the flag off.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { knownFor, splitReviews } from "../src/lib/places/decision";
import type { DataRepository } from "../src/lib/data/repository";
import type { PlaceRating } from "../src/lib/data/types";
import { ToastProvider } from "../src/components/ui/Toast";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";

const ctx = vi.hoisted(() => ({ repo: null as unknown as DataRepository, viewer: null as { id: string } | null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => ctx.viewer }));
vi.mock("@/components/map/MiniMap", () => ({ MiniMap: () => null }));

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const place = (name: string) => stableId(`place:${name}`);
const maya = user("maya_r"); // follows theo, priya, jules
const cannon = place("Cannon & Crown"); // reviews: theo (followed by maya), marcus (not)

async function render(id: string, sp: Record<string, string> = {}) {
  const { default: PlacePage } = await import("../src/app/places/[id]/page");
  const el = (await PlacePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve(sp) } as never)) as ReactElement;
  return renderToStaticMarkup(
    h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.parse("2026-11-05T12:00:00Z") }, children: h(ToastProvider, null, el) }),
  );
}

beforeEach(() => {
  ctx.repo = createDemoRepository(createIsolatedStore());
  ctx.viewer = null;
});
afterEach(() => vi.unstubAllEnvs());

describe("review ordering (pure)", () => {
  const r = (id: string, userId: string, updatedAt: string): PlaceRating => ({
    id, score: 4, note: `note ${id}`, createdAt: updatedAt, updatedAt,
    user: { id: userId, username: userId, displayName: userId, avatarUrl: null },
  });

  it("puts reviews by people the viewer follows first, keeps the viewer's own apart, and never merges them", () => {
    const ratings = [r("a", "stranger", "2026-10-01"), r("b", "friend", "2026-09-01"), r("c", "me", "2026-10-02"), r("d", "friend2", "2026-10-03")];
    const split = splitReviews(ratings, ["friend", "friend2"], "me");
    expect(split.friends.map((x) => x.id)).toEqual(["d", "b"]);
    expect(split.everyone.map((x) => x.id)).toEqual(["a"]);
    expect(split.own?.id).toBe("c");
    // Every review is still a whole, attributed review: nothing aggregated.
    expect([...split.friends, ...split.everyone, split.own].every((x) => x && x.note && x.user)).toBe(true);
  });

  it("signed out, nobody is a friend", () => {
    const split = splitReviews([r("a", "x", "2026-01-01")], [], null);
    expect(split.friends).toEqual([]);
    expect(split.everyone).toHaveLength(1);
  });

  it("takes the known-for line from the contributor's own first sentence, never invents one", () => {
    expect(knownFor("Big screens. Cheap wings.")).toBe("Big screens.");
    expect(knownFor("")).toBeNull();
    expect(knownFor(null)).toBeNull();
    const long = knownFor("word ".repeat(80));
    expect(long!.length).toBeLessThanOrEqual(161);
    expect(long!.endsWith("…")).toBe(true);
  });
});

describe("place page with pilotExplore on", () => {
  it("leads with the photo, then name, category and neighborhood, then the blocks in order", async () => {
    await ctx.repo.places.addPhotos(cannon, [{ url: "https://img.test/cannon.webp", storagePath: null }], maya);
    ctx.viewer = { id: maya };
    const html = await render(cannon);
    expect(html).toContain('data-place-page="decision"');
    expect(html).toContain('data-hero="photo"');
    const at = (needle: string) => {
      const i = html.indexOf(needle);
      expect(i, needle).toBeGreaterThan(-1);
      return i;
    };
    const order = [
      at("https://img.test/cannon.webp"),
      at("<h1"),
      at("data-facts"),
      at("data-rating-claim"),
      at('data-block="you"'),
      at('data-block="friends"'),
      at('data-block="community"'),
      at('data-block="reviews"'),
      at('data-block="actions"'),
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    // Unknowns are said plainly, not left blank.
    expect(html).toContain("Not listed yet");
  });

  it("shows friends' actual reviews first, then everyone else's, each attributed, with no summary", async () => {
    ctx.viewer = { id: maya };
    const html = await render(cannon);
    const friends = html.indexOf('data-review-group="friends"');
    const everyone = html.indexOf('data-review-group="everyone"');
    expect(friends).toBeGreaterThan(-1);
    expect(everyone).toBeGreaterThan(friends);
    const theoReview = html.indexOf("The only bar that turns the sound on.");
    const marcusReview = html.indexOf("Wings are underrated.");
    expect(theoReview).toBeGreaterThan(friends);
    expect(theoReview).toBeLessThan(everyone);
    expect(marcusReview).toBeGreaterThan(everyone);
    // No blended or summarized friend opinion anywhere.
    expect(html).not.toMatch(/friends (think|say|recommend|love)|match score|% match/i);
  });

  it("signed out: no friends section of reviews, and the friends block asks to sign in", async () => {
    const html = await render(cannon);
    expect(html).not.toContain('data-review-group="friends"');
    expect(html).toContain("to see reviews from people you follow");
    expect(html).toContain("The only bar that turns the sound on.");
  });

  it("claims open their evidence, and Add to outing is visibly disabled", async () => {
    const html = await render(cannon);
    expect((html.match(/data-evidence=""/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(html).toMatch(/<details[^>]*data-evidence=""[^>]*><summary/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>.*?Add to outing/);
    expect(html).toContain("Directions");
  });

  it("without a photo it is still a complete layout: the glyph leads and every block is there", async () => {
    const html = await render(cannon);
    expect(html).toContain('data-hero="glyph"');
    expect(html).toContain("data-glyph=");
    expect(html).not.toMatch(/<img[^>]*fetchPriority/i);
    for (const block of ["you", "friends", "community", "reviews", "actions"]) expect(html).toContain(`data-block="${block}"`);
  });

  it("a place with no reviews and no ratings says so instead of showing empty frames", async () => {
    const created = await ctx.repo.places.create(
      { name: "A".repeat(90), description: "", categorySlug: "cafe", lat: 39.97, lng: -83, city: "Columbus", tags: [] },
      maya,
    );
    ctx.viewer = { id: maya };
    const html = await render(created.id);
    expect(html).toContain("No ratings yet.");
    expect(html).toContain("No written reviews yet.");
    expect(html).toContain("Nobody you follow has reviewed this place yet.");
    expect(html).not.toContain("data-known-for");
  });

  it("hidden places stay hidden: another viewer gets a not-found", async () => {
    const created = await ctx.repo.places.create(
      { name: "Secret spot", description: "x.", categorySlug: "cafe", lat: 39.97, lng: -83, city: "Columbus", tags: [], visibility: "private" },
      maya,
    );
    ctx.viewer = { id: user("theo") };
    await expect(render(created.id)).rejects.toMatchObject({ digest: "NEXT_NOT_FOUND" });
  });
});

describe("place page with pilotExplore off", () => {
  it("renders today's page exactly as before", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    ctx.viewer = { id: maya };
    const html = await render(cannon);
    expect(html).not.toContain("data-place-page");
    expect(html).toContain("What people say");
    expect(html).not.toContain("Add to outing");
  });
});
