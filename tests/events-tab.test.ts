/**
 * Roadmap 1.5: the Quiet-utility Events tab (pilotFoundation). Pure rules (day buckets, the "usually go
 * to" rule, availability), the rendered rows, and the real page on the demo repository with the flag
 * on (new tab) and off (today's screen).
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Event } from "../src/lib/data/types";
import { availability, dayBucket, groupByBucket, usualEvents, USUAL_LOOKBACK_DAYS } from "../src/lib/events/tab";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { EventRow } from "../src/components/events/EventRow";
import { EventsTab } from "../src/components/events/EventsTab";

const viewer = vi.hoisted(() => ({ current: null as null | { id: string } }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => viewer.current }));
vi.mock("@/lib/time/server", () => ({ getViewerTime: async () => ({ timeZone: "America/New_York", now: Date.now() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), notFound: () => { throw new Error("NEXT_NOT_FOUND"); } }));

const NY = "America/New_York";
// Wednesday 2026-11-04, 15:00 in New York.
const WED = Date.parse("2026-11-04T20:00:00Z");
const at = (local: string) => new Date(Date.parse(`${local}:00-05:00`)).toISOString();

let n = 0;
const ev = (over: Partial<Event> = {}): Event => ({
  id: `e${++n}`, title: "Pickup run", description: "Bring water.", placeId: "p1", placeName: "Courts", locationName: "Thurman Courts",
  address: null, lat: 40, lng: -83, startsAt: at("2026-11-05T18:00"), endsAt: null, creatorId: "host", creator: null,
  categorySlug: "pickup-sports", capacity: 12, attendeeCount: 8, tags: [], status: "published", createdAt: at("2026-10-01T10:00"), priceCents: null, ...over,
});

describe("day buckets (viewer's zone)", () => {
  const t = { timeZone: NY, now: WED };
  it("Today, Tomorrow, This weekend (coming Sat/Sun), Later", () => {
    expect(dayBucket(at("2026-11-04T09:00"), t)).toBe("Today"); // started earlier today
    expect(dayBucket(at("2026-11-04T23:30"), t)).toBe("Today");
    expect(dayBucket(at("2026-11-05T00:30"), t)).toBe("Tomorrow");
    expect(dayBucket(at("2026-11-06T19:00"), t)).toBe("Later"); // Friday is not the weekend
    expect(dayBucket(at("2026-11-07T10:00"), t)).toBe("This weekend");
    expect(dayBucket(at("2026-11-08T22:00"), t)).toBe("This weekend");
    expect(dayBucket(at("2026-11-09T08:00"), t)).toBe("Later");
    expect(dayBucket(at("2026-11-14T10:00"), t)).toBe("Later"); // next Saturday
  });
  it("on Friday, Saturday is Tomorrow and Sunday is This weekend; on Sunday the next Saturday is Later", () => {
    const fri = { timeZone: NY, now: Date.parse("2026-11-06T17:00:00Z") };
    expect(dayBucket(at("2026-11-07T10:00"), fri)).toBe("Tomorrow");
    expect(dayBucket(at("2026-11-08T10:00"), fri)).toBe("This weekend");
    const sun = { timeZone: NY, now: Date.parse("2026-11-08T17:00:00Z") };
    expect(dayBucket(at("2026-11-14T10:00"), sun)).toBe("Later");
    expect(dayBucket(at("2026-11-09T10:00"), sun)).toBe("Tomorrow");
  });
  it("uses the viewer's zone, not UTC: 23:30 NY on Wednesday is Today, though it is Thursday in UTC", () => {
    expect(dayBucket("2026-11-05T04:30:00Z", t)).toBe("Today");
    expect(dayBucket("2026-11-05T04:30:00Z", { timeZone: "Europe/Berlin", now: WED })).toBe("Tomorrow");
  });
  it("groups in bucket order, soonest first, leaving out empty buckets", () => {
    const a = ev({ startsAt: at("2026-11-09T10:00") }), b = ev({ startsAt: at("2026-11-04T18:00") }), c = ev({ startsAt: at("2026-11-04T17:00") });
    expect(groupByBucket([a, b, c], t).map((g) => [g.bucket, g.events.map((e) => e.id)])).toEqual([["Today", [c.id, b.id]], ["Later", [a.id]]]);
  });
});

describe("events you usually go to (1.5 rule)", () => {
  const past = (over: Partial<Event> = {}) => ev({ title: "Last run", startsAt: at("2026-10-28T18:00"), endsAt: at("2026-10-28T20:00"), ...over });
  it("same category and the same venue or the same host as an ended event the viewer went to", () => {
    const went = past();
    const sameVenue = ev({ creatorId: "other" });
    const sameHost = ev({ placeId: "elsewhere" });
    const otherCategory = ev({ categorySlug: "music" });
    const neither = ev({ placeId: "elsewhere", creatorId: "other" });
    const got = usualEvents([went], [sameVenue, sameHost, otherCategory, neither], WED);
    expect(got.map((u) => u.event.id)).toEqual([sameVenue.id, sameHost.id]);
    expect(got[0].like).toEqual({ id: went.id, title: "Last run" });
  });
  it("ignores cancelled history, history older than the lookback, upcoming joins and events already joined", () => {
    const upcoming = ev();
    expect(usualEvents([past({ status: "cancelled" })], [ev()], WED)).toEqual([]);
    const old = past({ startsAt: new Date(WED - (USUAL_LOOKBACK_DAYS + 1) * 86_400_000).toISOString(), endsAt: null });
    expect(usualEvents([old], [ev()], WED)).toEqual([]);
    // A joined event that hasn't happened yet is not history.
    expect(usualEvents([upcoming], [ev()], WED)).toEqual([]);
    // Already joined: shown as going, never as "usual".
    expect(usualEvents([past(), upcoming], [upcoming], WED)).toEqual([]);
  });
  it("never offers a cancelled or finished candidate, and a null venue or host never matches", () => {
    expect(usualEvents([past()], [ev({ status: "cancelled" }), ev({ startsAt: at("2026-11-01T10:00") })], WED)).toEqual([]);
    expect(usualEvents([past({ placeId: null, creatorId: null })], [ev({ placeId: null, creatorId: null })], WED)).toEqual([]);
  });
});

describe("availability text", () => {
  it("spots, full, open and cancelled, from capacity and the going count only", () => {
    expect(availability({ status: "published", capacity: 12, attendeeCount: 8 })).toMatchObject({ kind: "spots", text: "4 spots" });
    expect(availability({ status: "published", capacity: 9, attendeeCount: 8 }).text).toBe("1 spot");
    expect(availability({ status: "published", capacity: 8, attendeeCount: 8 }).text).toBe("Full");
    expect(availability({ status: "published", capacity: null, attendeeCount: 8 }).text).toBe("Open");
    expect(availability({ status: "cancelled", capacity: 8, attendeeCount: 2 }).text).toBe("Cancelled");
  });
});

const wrap = (el: ReturnType<typeof h>, now = WED) => renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: NY, now }, children: el }));

describe("EventRow", () => {
  it("time on the left edge, title, venue, availability; price, Full and Cancelled without expanding", () => {
    const html = wrap(h("ul", null, h(EventRow, { event: ev({ title: "A".repeat(140) }), price: 1200 })));
    expect(html).toMatch(/6:00 PM/);
    expect(html).toContain("A".repeat(140));
    expect(html).toContain("Thurman Courts");
    expect(html).toContain("4 spots");
    expect(html).toContain("$12");
    expect(html).toMatch(/aria-expanded="false"/);
    // The panel (meeting point, host note, link) is present but hidden until expanded.
    expect(html).toMatch(/<div id="[^"]+" hidden=""/);
    expect(html).toContain('href="/events/');
    expect(html).toContain("From the host: </span>Bring water.");
    // A visible link to the event, outside the hidden panel (the e2e suite and keyboard users follow it).
    const panelAt = html.search(/<div id="[^"]+" hidden=""/);
    const visibleLink = html.indexOf('aria-label="Open event: ');
    expect(visibleLink).toBeGreaterThan(-1);
    expect(visibleLink).toBeLessThan(panelAt);
    const full = wrap(h("ul", null, h(EventRow, { event: ev({ capacity: 8 }) })));
    expect(full).toMatch(/data-status="warning"[^>]*>.*Full/);
    const cancelled = wrap(h("ul", null, h(EventRow, { event: ev({ status: "cancelled" }), price: 500 })));
    expect(cancelled).toMatch(/data-status="negative"[^>]*>.*Cancelled/);
    expect(cancelled).toContain("$5");
  });
  it("is a real button (keyboard reachable) and the expanded panel is labelled by aria-controls", () => {
    const html = wrap(h("ul", null, h(EventRow, { event: ev() })));
    const controls = /aria-controls="([^"]+)"/.exec(html)?.[1];
    expect(html).toMatch(/<button type="button"/);
    expect(controls).toBeTruthy();
    expect(html).toContain(`id="${controls}"`);
  });
});

describe("EventsTab", () => {
  const page = (items: Event[]) => ({ items, nextCursor: null });
  it("your events first (going + usual, grouped), then more upcoming without repeats", () => {
    const going = ev({ title: "My run" });
    const usual = ev({ title: "Usual run", startsAt: at("2026-11-07T10:00") });
    const other = ev({ title: "Some other thing", startsAt: at("2026-11-20T10:00") });
    const html = wrap(h(EventsTab, { initial: page([going, usual, other]), joined: [going], usual: [{ event: usual, like: { id: "x", title: "Last run" } }], signedIn: true, showPrices: false }));
    const yours = html.indexOf("Your events"), more = html.indexOf("More upcoming");
    expect(yours).toBeGreaterThan(-1);
    expect(more).toBeGreaterThan(yours);
    const section = html.slice(yours, more);
    expect(section).toContain("My run");
    expect(section).toContain("Usual run");
    expect(section).toContain("Like Last run, which you went to");
    expect(section).toMatch(/>Tomorrow<[\s\S]*>This weekend</);
    expect(html.slice(more)).toContain("Some other thing");
    expect(html.slice(more)).not.toContain("My run");
    expect(html.slice(more)).not.toContain("Usual run");
  });
  it("signed out: a sign-in prompt instead of your events; empty feed: an empty state", () => {
    const html = wrap(h(EventsTab, { initial: page([]), joined: [], usual: [], signedIn: false, showPrices: false }));
    expect(html).toContain("Sign in</a> to see the events you signed up for");
    expect(html).toContain("No other events coming up");
    expect(html).not.toContain("Been to");
  });
  it("prices only when payments are on", () => {
    const priced = ev({ priceCents: 1500 });
    expect(wrap(h(EventsTab, { initial: page([priced]), joined: [], usual: [], signedIn: true, showPrices: true }))).toContain("$15");
    expect(wrap(h(EventsTab, { initial: page([priced]), joined: [], usual: [], signedIn: true, showPrices: false }))).not.toContain("$15");
  });
});

describe("/events page (real demo repository)", () => {
  beforeEach(() => { vi.resetModules(); });
  afterEach(() => { vi.unstubAllEnvs(); viewer.current = null; });
  const render = async () => {
    const { default: Page } = await import("../src/app/events/page");
    // After resetModules the page has its own copy of the time context module.
    const { ViewerTimeProvider: Provider } = await import("../src/components/time/ViewerTime");
    const el = await Page();
    return renderToStaticMarkup(h(Provider, { initial: { timeZone: NY, now: Date.now() }, children: el as ReturnType<typeof h> }));
  };

  it("pilotFoundation on: the Quiet-utility tab; lena sees the 3v3 run as a usual event from her history", async () => {
    const { getRepository } = await import("../src/lib/data");
    const repo = await getRepository();
    const lena = await repo.profiles.getByUsername("lena");
    viewer.current = { id: lena!.id };
    const html = await render();
    expect(html).toContain("Your events");
    expect(html).toContain("treatment-utility");
    expect(html).toContain("Like Last week&#x27;s 3v3 basketball run, which you went to");
    expect(html).not.toContain("Events for you");
  });

  it("pilotFoundation off: today's screen (EventsClient with filter chips), unchanged", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    const html = await render();
    expect(html).not.toContain("Your events");
    expect(html).toContain("Do things with people");
    expect(html).toContain(">Upcoming<");
    expect(html).toContain(">This week<");
  });
});
