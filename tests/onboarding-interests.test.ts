/**
 * Roadmap 1.2: the pilot interest picker. Pure rules (toggle, limit, visible rows, map hand-off),
 * the picker and the whole Welcome flow rendered on the server with the flag on and off, the real
 * onboarding actions against an isolated demo repository, and the Explore page honouring every pick.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { INTERESTS } from "../src/lib/data/taxonomy";
import { discoveryQuerySchema } from "../src/lib/validation/schemas";
import {
  FEATURED_INTERESTS,
  INTEREST_GLYPH,
  MAP_INTEREST_LIMIT,
  mapInterests,
  toggleInterest,
  visibleInterests,
  welcomeMapHref,
} from "../src/lib/onboarding/interests";

const maya = SEED_USERS.find((u) => u.username === "maya_r")!.id;
const ctx: { viewer: string | null; repo: DataRepository; store: ReturnType<typeof createIsolatedStore> } = (() => {
  const store = createIsolatedStore();
  return { viewer: maya, repo: createDemoRepository(store), store };
})();
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { destination: to });
  },
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
const viewerOf = async (id: string | null) => {
  if (!id) return null;
  const profile = await ctx.repo.profiles.getById(id);
  return profile ? { id, profile } : null;
};
vi.mock("@/lib/auth/server", () => ({
  getViewer: async () => viewerOf(ctx.viewer),
  requireViewer: async () => {
    const v = await viewerOf(ctx.viewer);
    if (!v) throw Object.assign(new Error("NEXT_REDIRECT"), { destination: "/auth/sign-in" });
    return v;
  },
}));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/server/analytics", () => ({ track: async () => {} }));

const { saveOnboardingStepAction, finishOnboardingAction } = await import("../src/server/actions/onboarding");
const { InterestPicker } = await import("../src/components/onboarding/InterestPicker");
const { WelcomeFlow } = await import("../src/components/onboarding/WelcomeFlow");
const { ViewerTimeProvider } = await import("../src/components/time/ViewerTime");
const { default: WelcomePage } = await import("../src/app/welcome/page");
const { default: ExplorePage } = await import("../src/app/(explore)/page");

beforeEach(() => {
  ctx.viewer = maya;
  ctx.store = createIsolatedStore();
  ctx.repo = createDemoRepository(ctx.store);
  revalidatePath.mockClear();
  vi.unstubAllEnvs();
});

const picker = (selected: string[], expanded = false) =>
  renderToStaticMarkup(h(InterestPicker, { selected, expanded, onToggle: () => {}, onExpandedChange: () => {} }));
const flow = (pilotFoundation: boolean, initialInterests: string[] = []) =>
  renderToStaticMarkup(
    h(ViewerTimeProvider, {
      initial: { timeZone: "America/New_York", now: Date.parse("2026-11-05T12:00:00Z") },
      children: h(WelcomeFlow, {
        displayName: "Maya Rivera",
        initialInterests,
        initialHomeCity: null,
        localFrom: "2026-12-05T12:00:00Z",
        localDays: 30,
        people: [],
        pilotFoundation,
      }),
    }),
  );
const rowSlugs = (html: string) => [...html.matchAll(/data-interest="([^"]+)"/g)].map((m) => m[1]);
const pressed = (html: string) => [...html.matchAll(/aria-pressed="true"[^>]*data-interest="([^"]+)"/g)].map((m) => m[1]);
const eight = INTERESTS.slice(0, 8).map((i) => i.slug);
const twelve = INTERESTS.slice(0, 12).map((i) => i.slug);

describe("picker rules", () => {
  it("the limit is the one the map's discovery query honours", () => {
    const parsed = discoveryQuerySchema.parse({ tags: twelve.join(",") });
    expect(parsed.tags).toHaveLength(MAP_INTEREST_LIMIT);
  });

  it("six featured interests, each with a real glyph category", () => {
    expect(FEATURED_INTERESTS).toHaveLength(6);
    for (const slug of INTERESTS.map((i) => i.slug)) expect(INTEREST_GLYPH[slug], slug).toBeTruthy();
  });

  it("toggle adds, removes, ignores unknown slugs and stops at the limit", () => {
    expect(toggleInterest([], "coffee")).toEqual(["coffee"]);
    expect(toggleInterest(["coffee"], "coffee")).toEqual([]);
    expect(toggleInterest([], "not-a-thing")).toEqual([]);
    expect(toggleInterest(eight, "social")).toEqual(eight); // max choices: nothing silently dropped later
    expect(toggleInterest(eight, eight[0])).toEqual(eight.slice(1)); // unpicking frees a slot
  });

  it("collapsed shows the six plus any pick outside them; expanded shows everything", () => {
    expect(visibleInterests([], false)).toEqual([...FEATURED_INTERESTS]);
    expect(visibleInterests(["climbing"], false)).toEqual([...FEATURED_INTERESTS, "climbing"]);
    expect(visibleInterests([], true)).toHaveLength(INTERESTS.length);
  });

  it("the map hand-off carries exactly what was picked", () => {
    expect(welcomeMapHref([])).toBe("/?welcome=1"); // zero choices
    expect(welcomeMapHref(["coffee", "hiking"])).toBe(`/?tags=${encodeURIComponent("coffee,hiking")}&welcome=1`);
    expect(mapInterests(eight)).toEqual(eight);
    expect(mapInterests(twelve)).toEqual(eight); // only reachable from a profile saved elsewhere; the UI says so
  });
});

describe("InterestPicker", () => {
  it("six thumbnail rows with an unchecked shape, More interests collapsed", () => {
    const html = picker([]);
    expect(rowSlugs(html)).toEqual([...FEATURED_INTERESTS]);
    expect(html.match(/data-glyph=/g)).toHaveLength(6);
    expect(html.match(/data-check="off"/g)).toHaveLength(6);
    expect(html).toMatch(/aria-expanded="false"[^>]*>.*More interests/);
    expect(html).toContain("Pick any, up to 8, or none.");
  });

  it("a pick shows a filled check and aria-pressed", () => {
    const html = picker(["coffee"]);
    expect(pressed(html)).toEqual(["coffee"]);
    expect(html.match(/data-check="on"/g)).toHaveLength(1);
  });

  it("More interests reveals every interest", () => {
    const html = picker([], true);
    expect(rowSlugs(html)).toHaveLength(INTERESTS.length);
    expect(html).toMatch(/aria-expanded="true"[^>]*>.*Fewer interests/);
  });

  it("at the limit the others refuse and the status says why", () => {
    const html = picker(eight, true);
    expect(html).toContain("That&#x27;s 8, the most the map can show at once");
    expect(html.match(/aria-disabled="true"/g)).toHaveLength(INTERESTS.length - 8);
  });

  it("a returning profile with more than 8 is told which 8 the map uses", () => {
    const html = picker(twelve);
    expect(html).toContain("Your map starts with these 8: Sports, Pickup games, Fitness, Hiking, Outdoors, Food, Coffee, Studying.");
  });

  it("keyboard only: every control is a native button, in reading order", () => {
    const html = picker(["coffee"]);
    expect(html).not.toMatch(/tabindex="-1"/);
    const buttons = [...html.matchAll(/<button type="button"/g)];
    expect(buttons).toHaveLength(7); // six rows + More interests
    expect(html.indexOf("More interests")).toBeGreaterThan(html.lastIndexOf("data-interest="));
  });
});

describe("Welcome flow", () => {
  it("flag on: the new question, rows, Skip and Continue", () => {
    const html = flow(true);
    expect(html).toContain("What would you go out for?");
    expect(html).toMatch(/>Skip</);
    expect(html).toMatch(/>Continue</);
    expect(html).not.toMatch(/>Next without interests</);
    expect(rowSlugs(html)).toEqual([...FEATURED_INTERESTS]);
  });

  it("flag on, returning user: earlier picks are checked", () => {
    expect(pressed(flow(true, ["coffee", "climbing"]))).toEqual(["coffee", "climbing"]);
  });

  it("flag off: today's chip picker and Next, unchanged", () => {
    const html = flow(false);
    expect(html).toContain("What are you into?");
    expect(html).toMatch(/>Next without interests</);
    expect(html).not.toContain("What would you go out for?");
    expect(html).not.toContain("data-interest=");
    expect(html.match(/class="chip"/g)?.length).toBe(INTERESTS.length);
  });

  it("the page passes the flag, and sends an onboarded (returning) user to the map", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "pilot");
    await expect(WelcomePage()).rejects.toMatchObject({ destination: "/" }); // seed users are onboarded
    ctx.store.state.profiles.find((p) => p.id === maya)!.onboardedAt = null;
    const props = async () => ((await WelcomePage()) as { props: { pilotFoundation: boolean } }).props;
    expect((await props()).pilotFoundation).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    expect((await props()).pilotFoundation).toBe(false);
  });
});

describe("actions and the first map", () => {
  it("zero choices: Continue saves an empty list", async () => {
    await saveOnboardingStepAction({ interests: ["coffee"] });
    expect(await saveOnboardingStepAction({ interests: [] })).toMatchObject({ ok: true });
    expect((await ctx.repo.profiles.getById(maya))?.interests).toEqual([]);
    expect(await finishOnboardingAction()).toMatchObject({ ok: true, data: { interests: [] } });
  });

  it("max choices: all 8 are saved and the first map filters on all 8", async () => {
    expect(await saveOnboardingStepAction({ interests: eight })).toMatchObject({ ok: true });
    const res = await finishOnboardingAction();
    if (!res.ok) throw new Error(res.error);
    const href = welcomeMapHref(res.data.interests);
    const sp = Object.fromEntries(new URL(href, "http://x").searchParams);
    const el = (await ExplorePage({ searchParams: Promise.resolve(sp), params: Promise.resolve({}) } as never)) as {
      props: { initialRequest: { tags: string[] }; welcome: boolean };
    };
    expect(el.props.initialRequest.tags).toEqual(eight);
    expect(el.props.welcome).toBe(true);
  });

  it("signed out: refused", async () => {
    ctx.viewer = null;
    expect(await saveOnboardingStepAction({ interests: ["coffee"] })).toMatchObject({ ok: false, code: "unauthenticated" });
  });
});
