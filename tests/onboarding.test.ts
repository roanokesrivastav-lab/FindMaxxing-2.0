/**
 * Roadmap 1.2: the interest picker and the path from it to the first map.
 *
 * The contract: six featured rows with a thumbnail (glyph fallback) and a
 * checkmark, the rest under "More interests", no minimum, a visible Skip and
 * "Continue to home city"; and ONE limit (MAX_INTERESTS) from the picker,
 * through the saved profile and the map link, to the discovery query, so the
 * first map filters by every interest the picker accepted. The old behaviour
 * accepted 12 and applied 8.
 *
 * The save path runs the real server actions against a real demo repository;
 * the Explore page function is called as the server calls it; the SQL
 * discovery function gets the same twelve tags and must agree with the demo.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { discoverArgs } from "../src/lib/data/supabase/repository";
import { normalizeFilters } from "../src/lib/data/discovery";
import type { DataRepository } from "../src/lib/data/repository";
import { FEATURED_INTEREST_SLUGS, INTERESTS, INTEREST_MAP, MAX_INTERESTS, parseInterestTags } from "../src/lib/data/taxonomy";
import { FEATURED_INTERESTS, MORE_INTERESTS, firstMapHref, hasMoreSelected, toggleInterest } from "../src/lib/onboarding/interests";
import { discoveryQuerySchema, profileSchema } from "../src/lib/validation/schemas";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { InterestThumb } from "../src/components/onboarding/InterestThumb";
import { SEED_USERS } from "../src/lib/seed/seed-data";

const maya = SEED_USERS.find((u) => u.username === "maya_r")!.id;
const newcomer = "00000000-0000-4000-8000-0000000000c1";

const ctx: { viewer: string | null; repo: DataRepository } = { viewer: null, repo: createDemoRepository(createIsolatedStore()) };
class Redirect extends Error {
  constructor(public to: string) {
    super(`REDIRECT:${to}`);
  }
}
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirect(to);
  },
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {} }),
}));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => {
  const getViewer = async () => (ctx.viewer ? { id: ctx.viewer, profile: await ctx.repo.profiles.getById(ctx.viewer) } : null);
  return { getViewer, requireViewer: async () => (await getViewer())! };
});
// The page's props are what is under test, not the map or the recommendations rail.
vi.mock("@/components/explore/ExploreClient", () => ({ ExploreClient: () => null }));
vi.mock("@/components/recommendations/ForYouRail", () => ({ ForYouRail: () => null }));
vi.mock("@/server/recommendations", () => ({ forYouPlaces: async () => [] }));

function freshNewcomer() {
  const store = createIsolatedStore();
  ctx.repo = createDemoRepository(store);
  const now = new Date().toISOString();
  store.state.profiles.push({ id: newcomer, username: "newcomer", displayName: "New Comer", avatarUrl: null, bio: null, homeCity: null, homeCityChangedAt: null, onboardedAt: null, analyticsOptOut: false, reputationLevel: "new", createdAt: now, updatedAt: now });
  ctx.viewer = newcomer;
  return store;
}

/**
 * Twelve interests arranged so that a real seeded place carries the ninth and
 * none of the first eight: a map that applied only eight would lose it.
 */
async function twelveWithALateOnlyMatch(repo: DataRepository) {
  const all = await repo.places.search({ viewerId: null, limit: 100 });
  const place = all.items.find((p) => p.tags.length > 0 && p.tags.length <= 4)!;
  const late = place.tags[0];
  const others = INTERESTS.map((i) => i.slug).filter((s) => !place.tags.includes(s));
  const twelve = [...others.slice(0, 8), late, ...others.slice(8, 11)];
  return { place, late, twelve };
}

describe("picker rules", () => {
  it("leads with six known interests and puts every other one under More interests", () => {
    expect(FEATURED_INTERESTS.map((i) => i.slug)).toEqual([...FEATURED_INTEREST_SLUGS]);
    expect(FEATURED_INTERESTS).toHaveLength(6);
    for (const i of FEATURED_INTERESTS) {
      expect(i.slug in INTEREST_MAP).toBe(true);
      expect(i.blurb.length).toBeGreaterThan(8);
      expect(i.color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(MORE_INTERESTS).toHaveLength(INTERESTS.length - 6);
    const shown = [...FEATURED_INTERESTS, ...MORE_INTERESTS].map((i) => i.slug).sort();
    expect(shown).toEqual(INTERESTS.map((i) => i.slug).sort());
  });

  it("zero is a valid selection; a tap adds, a second tap removes", () => {
    expect(toggleInterest([], "coffee")).toEqual({ selected: ["coffee"], refused: false });
    expect(toggleInterest(["coffee", "hiking"], "coffee")).toEqual({ selected: ["hiking"], refused: false });
  });

  it("stops at the limit and says so, without changing the selection or dropping anything", () => {
    const full = INTERESTS.slice(0, MAX_INTERESTS).map((i) => i.slug);
    const extra = INTERESTS[MAX_INTERESTS].slug;
    expect(toggleInterest(full, extra)).toEqual({ selected: full, refused: true });
    // Removing still works at the limit, and frees a place.
    const fewer = toggleInterest(full, full[0]);
    expect(fewer).toEqual({ selected: full.slice(1), refused: false });
    expect(toggleInterest(fewer.selected, extra).selected).toContain(extra);
  });

  it("knows when a saved choice sits outside the first six", () => {
    expect(hasMoreSelected(["coffee", "outdoors"])).toBe(false);
    expect(hasMoreSelected(["coffee", "hiking"])).toBe(true);
    expect(hasMoreSelected([])).toBe(false);
  });
});

describe("one limit from the picker to the map", () => {
  const twelve = INTERESTS.slice(0, 12).map((i) => i.slug);

  it("the limit is twelve, and the profile schema, the map link and the discovery query all use it", () => {
    expect(MAX_INTERESTS).toBe(12);
    expect(profileSchema.safeParse({ username: "someone", displayName: "Some One", interests: twelve }).success).toBe(true);
    const thirteen = profileSchema.safeParse({ username: "someone", displayName: "Some One", interests: INTERESTS.slice(0, 13).map((i) => i.slug) });
    expect(thirteen.success).toBe(false);
    if (!thirteen.success) expect(thirteen.error.issues[0].message).toBe("Pick up to 12 interests");

    const href = firstMapHref(twelve, true);
    const params = new URL(href, "http://x").searchParams;
    expect(params.get("welcome")).toBe("1");
    expect(params.get("tags")!.split(",")).toEqual(twelve);

    const query = discoveryQuerySchema.parse({ tags: twelve.join(",") });
    expect(query.tags).toEqual(twelve);
  });

  it("the map link has no filter for zero interests or for Skip setup", () => {
    expect(firstMapHref([], true)).toBe("/?welcome=1");
    expect(firstMapHref(twelve, false)).toBe("/?welcome=1");
  });

  it("parses tags the same way everywhere: known slugs only, no duplicates, order kept, capped", () => {
    expect(parseInterestTags(" Coffee ,hiking,coffee,not-a-tag,")).toEqual(["coffee", "hiking"]);
    expect(parseInterestTags(["hiking", "coffee"])).toEqual(["hiking", "coffee"]);
    expect(parseInterestTags(null)).toEqual([]);
    expect(parseInterestTags(INTERESTS.map((i) => i.slug))).toHaveLength(MAX_INTERESTS);
  });
});

describe("save, finish and the first map (real actions, demo repository)", async () => {
  const { saveOnboardingStepAction, finishOnboardingAction } = await import("../src/server/actions/onboarding");
  const { default: ExplorePage } = await import("../src/app/(explore)/page");
  const { default: WelcomePage } = await import("../src/app/welcome/page");
  type PageProps = { initialRequest: { tags: string[] }; initial: { places: { items: { id: string }[] } }; welcome: boolean };
  const explore = async (search: Record<string, string>) =>
    ((await ExplorePage({ params: Promise.resolve({}), searchParams: Promise.resolve(search) } as Parameters<typeof ExplorePage>[0])) as { props: PageProps }).props;

  beforeEach(() => {
    freshNewcomer();
  });

  it("twelve interests: all saved, all in the link, all applied by the first map", async () => {
    const { place, late, twelve } = await twelveWithALateOnlyMatch(ctx.repo);
    expect(twelve).toHaveLength(12);
    expect(twelve.indexOf(late)).toBe(8);
    expect(await saveOnboardingStepAction({ interests: twelve })).toEqual({ ok: true, data: undefined });
    const done = await finishOnboardingAction();
    expect(done).toEqual({ ok: true, data: { interests: twelve } });

    const href = firstMapHref(done.ok ? done.data.interests : [], true);
    const props = await explore(Object.fromEntries(new URL(href, "http://x").searchParams));
    expect(props.welcome).toBe(true);
    expect(props.initialRequest.tags).toEqual(twelve);

    // The place that only the ninth interest matches is on the first map. With eight applied it was not.
    const withAll = await ctx.repo.places.search({ tags: props.initialRequest.tags, viewerId: newcomer, limit: 100 });
    const withEight = await ctx.repo.places.search({ tags: twelve.slice(0, 8), viewerId: newcomer, limit: 100 });
    expect(withAll.items.map((p) => p.id)).toContain(place.id);
    expect(withEight.items.map((p) => p.id)).not.toContain(place.id);
  });

  it("a thirteenth interest is refused at save with the limit named, and nothing is half-saved", async () => {
    const res = await saveOnboardingStepAction({ interests: INTERESTS.slice(0, 13).map((i) => i.slug) });
    expect(res).toMatchObject({ ok: false, fieldErrors: { interests: "Pick up to 12 interests" } });
    expect((await ctx.repo.profiles.getById(newcomer))!.interests).toEqual([]);
  });

  it("zero interests: saving none and continuing leads to an unfiltered first map", async () => {
    expect(await saveOnboardingStepAction({ interests: [] })).toEqual({ ok: true, data: undefined });
    const done = await finishOnboardingAction();
    expect(done).toEqual({ ok: true, data: { interests: [] } });
    const href = firstMapHref(done.ok ? done.data.interests : [], true);
    expect(href).toBe("/?welcome=1");
    const props = await explore({ welcome: "1" });
    expect(props.initialRequest.tags).toEqual([]);
    expect(props.initial.places.items.length).toBeGreaterThan(0);
  });

  it("skipping the step saves nothing, and onboarding still finishes", async () => {
    // Skip is client-only: no save action runs. Finishing then reports what is stored: nothing.
    expect(await finishOnboardingAction()).toEqual({ ok: true, data: { interests: [] } });
    expect((await ctx.repo.profiles.getById(newcomer))!.onboardedAt).not.toBeNull();
  });

  it("a returning user never sees onboarding again, and gets no first-arrival state or filter by default", async () => {
    await saveOnboardingStepAction({ interests: ["coffee"] });
    await finishOnboardingAction();
    await expect(WelcomePage()).rejects.toMatchObject({ to: "/" });
    const props = await explore({});
    expect(props.welcome).toBe(false);
    expect(props.initialRequest.tags).toEqual([]);
  });

  it("someone who has not finished onboarding is sent to it before the map", async () => {
    await expect(explore({})).rejects.toMatchObject({ to: "/welcome" });
  });

  it("an existing member's map ignores unknown tags in the link and keeps the known ones", async () => {
    ctx.viewer = maya;
    const props = await explore({ tags: "coffee,not-a-tag,coffee,hiking" });
    expect(props.initialRequest.tags).toEqual(["coffee", "hiking"]);
    expect(props.welcome).toBe(false);
  });
});

describe("SQL discovery applies the same twelve tags (PGlite)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await createSeededDb();
  });
  afterAll(async () => {
    await db?.close();
  });

  it("discover_places returns the same places as the demo repository for twelve tags", async () => {
    const repo = createDemoRepository(createIsolatedStore());
    const { place, twelve } = await twelveWithALateOnlyMatch(repo);
    const args = discoverArgs(normalizeFilters({ tags: twelve }));
    const CASTS: Record<string, string> = {
      p_north: "float8", p_south: "float8", p_east: "float8", p_west: "float8", p_text: "text", p_text_categories: "text[]",
      p_text_tags: "text[]", p_category: "text", p_tags: "text[]", p_neighborhood: "text", p_created_after: "timestamptz",
    };
    const names = Object.keys(args) as (keyof typeof args)[];
    const rows = await queryAs<{ id: string }>(
      db,
      null,
      `select id from public.discover_places(${names.map((n, i) => `${n} => $${i + 1}::${CASTS[n]}`).join(", ")})`,
      names.map((n) => args[n]),
    );
    const demo = await repo.places.search({ tags: twelve, viewerId: null, limit: 100 });
    expect(demo.nextCursor).toBeNull();
    expect(rows.map((r) => r.id).sort()).toEqual(demo.items.map((p) => p.id).sort());
    expect(rows.map((r) => r.id)).toContain(place.id);
  });
});

describe("the interests step as rendered", async () => {
  const { WelcomeFlow } = await import("../src/components/onboarding/WelcomeFlow");
  const render = (initialInterests: string[]) =>
    renderToStaticMarkup(
      h(ViewerTimeProvider, {
        initial: { timeZone: "UTC", now: Date.UTC(2026, 10, 11) },
        children: h(WelcomeFlow, { displayName: "New Comer", initialInterests, initialHomeCity: null, localFrom: "2026-11-25T00:00:00.000Z", localDays: 14, people: [] }),
      }),
    );
  const rows = (html: string) => [...html.matchAll(/<button[^>]*role="checkbox"[^>]*>/g)].map((m) => m[0]);
  const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

  it("asks the question, shows six thumbnail rows with an unchecked mark, Skip and Continue to home city", () => {
    const html = render([]);
    expect(html).toContain("What would you go out for?");
    expect(html).toContain(`up to ${MAX_INTERESTS}, or none`);
    const featured = rows(html).slice(0, 6);
    expect(featured.map((t) => attr(t, "data-interest"))).toEqual([...FEATURED_INTEREST_SLUGS]);
    expect(featured.every((t) => attr(t, "aria-checked") === "false")).toBe(true);
    // No photo is bundled yet, so each row shows the glyph fallback.
    expect(html.match(/data-thumb="glyph"/g)).toHaveLength(6);
    expect(html.match(/data-check="off"/g)).toHaveLength(6);
    expect(html).toMatch(/<button[^>]*>Skip<\/button>/);
    // Zero selected: the forward button is there, enabled, and says where it goes.
    const forward = /<button[^>]*>Continue to home city<\/button>/.exec(html)![0];
    expect(forward).not.toMatch(/\sdisabled=""/);
    expect(html).toContain("Skip setup");
  });

  it("keeps More interests closed until asked, but still in the page for the button to point at", () => {
    const html = render([]);
    expect(html).toMatch(/aria-expanded="false"[^>]*aria-controls="more-interests"/);
    expect(html).toMatch(/<div id="more-interests" hidden=""/);
    expect(rows(html)).toHaveLength(INTERESTS.length);
  });

  it("returning to the step: saved choices are checked, and More interests opens when one of them lives there", () => {
    const html = render(["coffee", "hiking"]);
    const byslug = Object.fromEntries(rows(html).map((t) => [attr(t, "data-interest"), attr(t, "aria-checked")]));
    expect(byslug.coffee).toBe("true");
    expect(byslug.hiking).toBe("true");
    expect(byslug.outdoors).toBe("false");
    expect(html.match(/data-check="on"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-expanded="true"[^>]*aria-controls="more-interests"/);
    expect(html).not.toMatch(/<div id="more-interests" hidden/);
    expect(html).toContain("(1 selected)");
  });

  it("at the limit: unselected rows are marked unavailable and the limit is stated", () => {
    const html = render(INTERESTS.slice(0, MAX_INTERESTS).map((i) => i.slug));
    const tags = rows(html);
    expect(tags.filter((t) => attr(t, "aria-checked") === "true")).toHaveLength(MAX_INTERESTS);
    const blocked = tags.filter((t) => attr(t, "aria-disabled") === "true");
    expect(blocked).toHaveLength(INTERESTS.length - MAX_INTERESTS);
    expect(blocked.every((t) => attr(t, "aria-describedby") === "interest-limit")).toBe(true);
    expect(html).toContain("the most the map can use at once");
  });
});

describe("row thumbnail", () => {
  it("shows a supplied photo, decoratively, and the glyph when there is none", () => {
    const photo = renderToStaticMarkup(h(InterestThumb, { slug: "coffee", src: "/interests/coffee.webp", color: "#8b5a2b" }));
    expect(photo).toMatch(/<img[^>]*src="\/interests\/coffee\.webp"[^>]*alt=""/);
    expect(photo).toContain('data-thumb="photo"');
    const glyph = renderToStaticMarkup(h(InterestThumb, { slug: "coffee", src: null, color: "#8b5a2b" }));
    expect(glyph).toContain('data-thumb="glyph"');
    expect(glyph).toContain('aria-hidden="true"');
    expect(glyph).toContain("<svg");
  });
});
