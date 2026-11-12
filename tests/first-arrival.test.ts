/**
 * Roadmap 1.3: the first Explore visit after onboarding.
 *
 * The strip shows the interests the map is filtered to, each removable, with
 * "Show everything" beside them. When an interest has nothing in the area, or
 * location is off, it says so and offers ONE widening. It never relaxes a
 * filter itself, and says nothing about an interest it cannot know about.
 *
 * Rules are tested as pure functions; the strip as rendered markup; and the
 * "no nearby matches" case through the real onboarding actions, the real
 * Explore page function and the demo repository. Browser behaviour (taps, the
 * map actually widening, a refused location prompt) is in
 * scripts/e2e-onboarding.mjs.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { INTERESTS } from "../src/lib/data/taxonomy";
import { firstMapHref } from "../src/lib/onboarding/interests";
import { arrivalNotice, interestsWithoutMatches, orList, widerBounds, type ArrivalInput } from "../src/components/explore/arrivalNotice";
import { FirstArrival } from "../src/components/explore/FirstArrival";

const newcomer = "00000000-0000-4000-8000-0000000000c3";
const ctx: { viewer: string | null; repo: DataRepository } = { viewer: null, repo: createDemoRepository(createIsolatedStore()) };
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("next/navigation", () => ({ redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); } }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({
  getViewer: async () => (ctx.viewer ? { id: ctx.viewer, profile: await ctx.repo.profiles.getById(ctx.viewer) } : null),
}));
vi.mock("@/components/explore/ExploreClient", () => ({ ExploreClient: () => null }));
vi.mock("@/components/recommendations/ForYouRail", () => ({ ForYouRail: () => null }));
vi.mock("@/server/recommendations", () => ({ forYouPlaces: async () => [] }));

const base: ArrivalInput = { interests: ["coffee", "hiking"], settled: true, failed: false, total: 3, loadedTags: [["coffee"], ["coffee", "studying"], ["hiking"]], complete: true, locationDenied: false, widened: false };
const notice = (over: Partial<ArrivalInput>) => arrivalNotice({ ...base, ...over });

describe("what the first map may say", () => {
  it("says nothing extra when every selected interest has results", () => {
    expect(notice({})).toEqual({ emptyInterests: [], nothingMatches: false, stillEmptyAfterWidening: false, locationDenied: false, widening: null });
  });

  it("no nearby matches at all: says so and offers exactly one widening, the wider area", () => {
    const n = notice({ total: 0, loadedTags: [] });
    expect(n).toMatchObject({ emptyInterests: ["coffee", "hiking"], nothingMatches: true, stillEmptyAfterWidening: false, widening: "wider-area" });
  });

  it("one interest with nothing: names that interest only", () => {
    const n = notice({ loadedTags: [["coffee"], ["coffee"]], total: 2 });
    expect(n).toMatchObject({ emptyInterests: ["hiking"], nothingMatches: false, widening: "wider-area" });
  });

  it("does not call an interest empty when more results exist than are loaded: unknown stays unknown", () => {
    expect(interestsWithoutMatches(["coffee", "hiking"], [["coffee"]], false)).toBeNull();
    const n = notice({ loadedTags: [["coffee"]], total: 40, complete: false });
    expect(n).toMatchObject({ emptyInterests: [], nothingMatches: false, widening: null });
  });

  it("says nothing about matches while loading or after a failed query", () => {
    expect(notice({ settled: false, total: 0, loadedTags: [] })).toMatchObject({ emptyInterests: [], nothingMatches: false, widening: null });
    expect(notice({ failed: true, total: 0, loadedTags: [] })).toMatchObject({ emptyInterests: [], nothingMatches: false, widening: null });
  });

  it("after the widening is used it is not offered again, and a still-empty result is reported as such", () => {
    const n = notice({ total: 0, loadedTags: [], widened: true });
    expect(n).toMatchObject({ emptyInterests: ["coffee", "hiking"], nothingMatches: true, stillEmptyAfterWidening: true, widening: null });
    // Widening found them: nothing is reported.
    expect(notice({ widened: true })).toMatchObject({ emptyInterests: [], stillEmptyAfterWidening: false, widening: null });
  });

  it("denied location: says the area is a default one and offers the one widening, with results or without", () => {
    expect(notice({ locationDenied: true })).toMatchObject({ locationDenied: true, emptyInterests: [], widening: "wider-area" });
    expect(notice({ locationDenied: true, total: 0, loadedTags: [] })).toMatchObject({ locationDenied: true, nothingMatches: true, widening: "wider-area" });
    expect(notice({ locationDenied: true, widened: true })).toMatchObject({ locationDenied: true, widening: null });
    // Still loading: the note stands, but no action is offered on unknown results.
    expect(notice({ locationDenied: true, settled: false })).toMatchObject({ locationDenied: true, widening: null });
  });

  it("with no interest filter there is nothing to report about interests", () => {
    expect(notice({ interests: [], total: 0, loadedTags: [] })).toMatchObject({ emptyInterests: [], nothingMatches: false, widening: null });
  });

  it("never returns changed filters: the input interests are untouched", () => {
    const interests = Object.freeze(["coffee", "hiking"]) as readonly string[];
    const n = arrivalNotice({ ...base, interests, total: 0, loadedTags: [] });
    expect(interests).toEqual(["coffee", "hiking"]);
    expect(Object.keys(n).sort()).toEqual(["emptyInterests", "locationDenied", "nothingMatches", "stillEmptyAfterWidening", "widening"]);
  });
});

describe("the wider area", () => {
  it("doubles the span around the same centre", () => {
    const b = widerBounds({ north: 40.04, south: 39.9, east: -82.88, west: -83.12 });
    expect(b.north).toBeCloseTo(40.11, 5);
    expect(b.south).toBeCloseTo(39.83, 5);
    expect(b.east).toBeCloseTo(-82.76, 5);
    expect(b.west).toBeCloseTo(-83.24, 5);
  });
  it("stays inside the map and becomes the whole world rather than wrapping", () => {
    expect(widerBounds({ north: 80, south: 10, east: 10, west: -10 }).north).toBe(85);
    expect(widerBounds({ north: 10, south: -80, east: 10, west: -10 }).south).toBe(-85);
    expect(widerBounds({ north: 10, south: -10, east: 100, west: -100 })).toMatchObject({ east: 180, west: -180 });
  });
  it("handles a box across the antimeridian", () => {
    const b = widerBounds({ north: 1, south: -1, east: -179, west: 179 });
    expect(b.east - b.west).toBeCloseTo(4, 5);
  });
  it("words a list the way a person would", () => {
    expect(orList(["Coffee"])).toBe("Coffee");
    expect(orList(["Coffee", "Hiking"])).toBe("Coffee or Hiking");
    expect(orList(["Coffee", "Hiking", "Dogs"])).toBe("Coffee, Hiking or Dogs");
  });
});

describe("the strip as rendered", () => {
  const noop = () => {};
  const render = (interests: string[], over: Partial<ArrivalInput> = {}) =>
    renderToStaticMarkup(h(FirstArrival, { interests, notice: arrivalNotice({ ...base, interests, ...over }), onRemove: noop, onShowEverything: noop, onWiden: noop, onDismiss: noop }));
  const count = (html: string, re: RegExp) => (html.match(re) ?? []).length;

  it("shows each interest as a removable filter with Show everything beside them", () => {
    const html = render(["coffee", "hiking"]);
    expect(html).toContain('aria-label="Your first map"');
    expect(html).toContain('data-surface="raised"');
    expect(html).toContain('aria-label="Remove Coffee"');
    expect(html).toContain('aria-label="Remove Hiking"');
    expect(count(html, />Show everything</g)).toBe(1);
    expect(html).toContain("The map is showing your interests.");
    expect(html).not.toContain("data-notice=");
    expect(html).not.toContain("data-widening=");
    expect(html).toMatch(/>Got it</);
  });

  it("all twelve interests are listed, none dropped", () => {
    const twelve = INTERESTS.slice(0, 12).map((i) => i.slug);
    const html = render(twelve, { loadedTags: [twelve] });
    expect(count(html, /aria-label="Remove /g)).toBe(12);
    for (const i of INTERESTS.slice(0, 12)) expect(html).toContain(`aria-label="Remove ${i.label}"`);
  });

  it("no matches: one message, one widening button, filters still shown", () => {
    const html = render(["volunteering"], { total: 0, loadedTags: [] });
    expect(html).toContain("Nothing in this area matches your interests yet. Your filters are unchanged.");
    expect(count(html, /data-widening="wider-area"/g)).toBe(1);
    expect(count(html, />Search a wider area</g)).toBe(1);
    expect(html).toContain('aria-label="Remove Volunteering"');
    expect(html).toMatch(/role="status"/);
  });

  it("one empty interest is named", () => {
    const html = render(["coffee", "cycling"], { total: 2, loadedTags: [["coffee"], ["coffee"]] });
    expect(html).toContain("Nothing for Cycling in this area yet.");
    expect(count(html, /data-widening=/g)).toBe(1);
  });

  it("after widening with nothing found: says so and offers no second widening", () => {
    const html = render(["volunteering"], { total: 0, loadedTags: [], widened: true });
    expect(html).toContain("Still nothing for your interests in the wider area.");
    expect(html).toContain("Your filters are unchanged");
    expect(html).not.toContain("data-widening=");
  });

  it("denied location: the note and a single widening, even together with no matches", () => {
    const html = render(["volunteering"], { total: 0, loadedTags: [], locationDenied: true });
    expect(html).toContain("Location is off, so the map starts in the default area, not where you are.");
    expect(html).toContain("Nothing in this area matches your interests yet.");
    expect(count(html, /data-widening=/g)).toBe(1);
  });

  it("with no interests it says the map shows everything and has no filter chips", () => {
    const html = render([]);
    expect(html).toContain("The map is showing everything.");
    expect(html).not.toContain("Show everything<");
    expect(html).not.toContain('aria-label="Remove ');
  });
});

describe("no nearby matches through the real save and Explore paths (demo repository)", async () => {
  const { saveOnboardingStepAction, finishOnboardingAction } = await import("../src/server/actions/onboarding");
  const { default: ExplorePage } = await import("../src/app/(explore)/page");
  type Props = { welcome: boolean; initialRequest: { tags: string[]; bounds: unknown }; initial: { places: { items: { tags: string[] }[]; nextCursor: string | null }; events: { items: { tags: string[] }[]; nextCursor: string | null }; placeMarkers: { items: unknown[]; truncated: boolean }; eventMarkers: { items: unknown[]; truncated: boolean } } };
  const arrive = async (interests: string[]) => {
    expect(await saveOnboardingStepAction({ interests })).toMatchObject({ ok: true });
    const done = await finishOnboardingAction();
    if (!done.ok) throw new Error("finish failed");
    const search = Object.fromEntries(new URL(firstMapHref(done.data.interests, true), "http://x").searchParams);
    return ((await ExplorePage({ params: Promise.resolve({}), searchParams: Promise.resolve(search) } as Parameters<typeof ExplorePage>[0])) as { props: Props }).props;
  };
  const noticeFor = (p: Props) =>
    arrivalNotice({
      interests: p.initialRequest.tags,
      settled: true,
      failed: false,
      total: p.initial.placeMarkers.items.length + p.initial.eventMarkers.items.length,
      loadedTags: [...p.initial.places.items.map((x) => x.tags), ...p.initial.events.items.map((x) => x.tags)],
      complete: !p.initial.placeMarkers.truncated && !p.initial.eventMarkers.truncated && !p.initial.places.nextCursor && !p.initial.events.nextCursor,
      locationDenied: false,
      widened: false,
    });

  beforeEach(() => {
    const store = createIsolatedStore();
    ctx.repo = createDemoRepository(store);
    const now = new Date().toISOString();
    store.state.profiles.push({ id: newcomer, username: "arrival", displayName: "First Arrival", avatarUrl: null, bio: null, homeCity: null, homeCityChangedAt: null, onboardedAt: null, analyticsOptOut: false, reputationLevel: "new", createdAt: now, updatedAt: now });
    ctx.viewer = newcomer;
  });

  it("an interest nothing is tagged with: the first map is empty, still filtered, and the notice offers the widening", async () => {
    // Nothing in the seed carries "volunteering"; if that changes this guard fails first.
    const everything = await ctx.repo.places.search({ viewerId: newcomer, tags: ["volunteering"], limit: 100 });
    expect(everything.items).toHaveLength(0);
    const props = await arrive(["volunteering"]);
    expect(props.welcome).toBe(true);
    // Not relaxed: the page still asks for exactly that interest and shows nothing else.
    expect(props.initialRequest.tags).toEqual(["volunteering"]);
    expect(props.initial.placeMarkers.items).toHaveLength(0);
    expect(props.initial.places.items).toHaveLength(0);
    expect(noticeFor(props)).toMatchObject({ nothingMatches: true, emptyInterests: ["volunteering"], widening: "wider-area" });
  });

  it("one empty interest beside one with results: results are shown and only the empty one is named", async () => {
    const props = await arrive(["pickup-sports", "volunteering"]);
    expect(props.initialRequest.tags).toEqual(["pickup-sports", "volunteering"]);
    expect(props.initial.placeMarkers.items.length + props.initial.eventMarkers.items.length).toBeGreaterThan(0);
    const n = noticeFor(props);
    expect(n.nothingMatches).toBe(false);
    // Named only when the first page is the whole result; otherwise unknown and unnamed.
    const complete = !props.initial.placeMarkers.truncated && !props.initial.eventMarkers.truncated && !props.initial.places.nextCursor && !props.initial.events.nextCursor;
    expect(n.emptyInterests).toEqual(complete ? ["volunteering"] : []);
  });
});
