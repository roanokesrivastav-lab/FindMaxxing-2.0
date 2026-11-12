/**
 * Roadmap 4.1: the event page in the Local editorial order.
 *
 * The wording rules (cost, spots, status, the one action) are tested as a pure
 * function. The page itself is the real server component, run against the demo
 * repository with real events, joins and prices; only browser-only widgets are
 * replaced by markers. Browser behaviour is in scripts/e2e-event-detail.mjs.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import type { Event, NewEventInput } from "../src/lib/data/types";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { eventDetailFacts, sameZoneAt, type EventDetailInput } from "../src/lib/events/detail";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const host = user("theo");
const guest = user("nina");
const other = user("maya_r");

const ctx: { viewer: string | null; repo: DataRepository; payments: "demo" | null; flags: Set<string>; zone: string } = {
  viewer: null,
  repo: createDemoRepository(createIsolatedStore()),
  payments: "demo",
  flags: new Set(["pilotEvents"]),
  zone: "America/New_York",
};
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NOT_FOUND"); }, useRouter: () => ({ push() {}, back() {}, refresh() {} }) }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({
  getViewer: async () => (ctx.viewer ? { id: ctx.viewer, profile: await ctx.repo.profiles.getById(ctx.viewer) } : null),
}));
vi.mock("@/lib/time/server", () => ({ getViewerTime: async () => ({ timeZone: ctx.zone, now: Date.now() }) }));
vi.mock("@/lib/config", async (original) => ({
  ...(await original<typeof import("../src/lib/config")>()),
  featureEnabled: (name: string) => ctx.flags.has(name),
  paymentsMode: () => ctx.payments,
}));
// Browser-only widgets, replaced by markers that keep the props the page decided on.
const marker = (name: string) => (props: Record<string, unknown>) =>
  h("span", { "data-widget": name, "data-props": JSON.stringify(Object.fromEntries(Object.entries(props).filter(([, v]) => typeof v !== "object" && typeof v !== "function"))) }, (props.children as ReactElement) ?? null);
vi.mock("@/components/events/JoinButton", () => ({ JoinButton: marker("join") }));
vi.mock("@/components/payments/TicketButton", () => ({ TicketButton: marker("ticket") }));
vi.mock("@/components/payments/EventPricing", () => ({ EventPricing: marker("pricing") }));
vi.mock("@/components/events/ConfirmSessionButton", () => ({ ConfirmSessionButton: marker("confirm") }));
vi.mock("@/components/shared/OwnerActions", () => ({ OwnerActions: marker("owner") }));
vi.mock("@/components/shared/ShareButton", () => ({ ShareButton: marker("share") }));
vi.mock("@/components/shared/ReportButton", () => ({ ReportButton: marker("report") }));
vi.mock("@/components/shared/NewBanner", () => ({ NewBanner: marker("new") }));
vi.mock("@/components/map/MiniMap", () => ({ MiniMap: marker("map") }));
vi.mock("@/components/ui/BackButton", () => ({ BackButton: marker("back") }));
vi.mock("@/components/interactions/TrackView", () => ({ TrackView: marker("track"), DirectionsLink: marker("directions") }));

const { default: EventPage } = await import("../src/app/events/[id]/page");

const input = (over: Partial<NewEventInput> = {}): NewEventInput => ({
  title: "Riverside evening run",
  description: "A steady loop along the river. Everyone waits at the bridge.",
  placeId: null,
  locationName: "Scioto Mile fountain",
  address: "233 Civic Center Dr",
  lat: 39.96,
  lng: -83.0,
  startsAt: new Date(Date.now() + 3 * 86_400_000).toISOString(),
  endsAt: new Date(Date.now() + 3 * 86_400_000 + 3_600_000).toISOString(),
  categorySlug: "fitness",
  capacity: null,
  tags: ["running"],
  ...over,
});

async function render(eventId: string, viewer: string | null, search: Record<string, string> = {}) {
  ctx.viewer = viewer;
  const page = await EventPage({ params: Promise.resolve({ id: eventId }), searchParams: Promise.resolve(search) } as Parameters<typeof EventPage>[0]);
  return renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: ctx.zone, now: Date.now() }, children: page }));
}
/** Visible text only, so a class name or attribute can never satisfy or break a wording check. */
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const part = (html: string, name: string) => html.indexOf(`data-part="${name}"`);
const widget = (html: string, name: string) => {
  const m = new RegExp(`data-widget="${name}" data-props="([^"]*)"`).exec(html);
  return m ? (JSON.parse(m[1].replace(/&quot;/g, '"')) as Record<string, unknown>) : null;
};

beforeEach(() => {
  ctx.repo = createDemoRepository(createIsolatedStore());
  ctx.payments = "demo";
  ctx.flags = new Set(["pilotEvents"]);
  ctx.zone = "America/New_York";
});

describe("cost, spots, status and the one action", () => {
  const ev = (over: Partial<EventDetailInput["event"]> = {}): EventDetailInput["event"] => ({ status: "published", capacity: null, attendeeCount: 3, priceCents: null, creatorId: host, readiness: null, ...over });
  const facts = (over: Partial<EventDetailInput> = {}) => eventDetailFacts({ event: ev(), joined: false, viewerId: guest, ended: false, ticketsOnSale: true, ...over });

  it("a free open event: Free, join, and no spots number when the host set no limit", () => {
    expect(facts()).toMatchObject({ cost: "Free", priced: false, spots: null, full: false, action: "join", status: null, going: "3 going" });
  });

  it("a priced event never says free, with tickets on sale or not", () => {
    for (const ticketsOnSale of [true, false]) {
      for (const joined of [true, false]) {
        for (const full of [true, false]) {
          const f = facts({ event: ev({ priceCents: 1200, capacity: 3, attendeeCount: full ? 3 : 1 }), ticketsOnSale, joined });
          expect(f.cost).toBe("$12.00 per ticket");
          expect(`${f.cost} ${f.note} ${f.spots} ${f.status?.label ?? ""}`).not.toMatch(/free/i);
        }
      }
    }
  });

  it("a priced event offers the ticket action, and nothing when tickets cannot be bought here", () => {
    expect(facts({ event: ev({ priceCents: 500 }) })).toMatchObject({ action: "ticket", note: "Buying a ticket holds your spot for 30 minutes while you pay." });
    expect(facts({ event: ev({ priceCents: 500 }), ticketsOnSale: false })).toMatchObject({ action: "none", note: "Tickets for this event can't be bought here right now." });
  });

  it("the host of a priced event needs no ticket", () => {
    expect(facts({ event: ev({ priceCents: 500 }), viewerId: host, joined: true })).toMatchObject({ action: "leave", status: { label: "You're hosting" } });
    expect(facts({ event: ev({ priceCents: 500 }), viewerId: host, joined: false })).toMatchObject({ action: "join" });
  });

  it("full: says Full, counts held seats, and mentions no queue", () => {
    const byCount = facts({ event: ev({ capacity: 3, attendeeCount: 3 }) });
    expect(byCount).toMatchObject({ full: true, spots: "Full", status: { tone: "warning", label: "Full" }, action: "join" });
    // A seat held by someone paying counts as taken even though they are not going yet.
    const byHold = facts({ event: ev({ capacity: 3, attendeeCount: 2, priceCents: 500, readiness: { going: 2, capacity: 3, spotsOpen: 0 } as Event["readiness"] }) });
    expect(byHold).toMatchObject({ full: true, spots: "Full", action: "ticket", note: "Every spot is taken or being paid for." });
    expect(`${byCount.note} ${byHold.note}`).not.toMatch(/wait ?list|queue|offer|notify/i);
  });

  it("spots left comes from readiness when it is there and from the going count when it is not", () => {
    expect(facts({ event: ev({ capacity: 10, attendeeCount: 4 }) }).spots).toBe("6 of 10 spots left");
    expect(facts({ event: ev({ capacity: 10, attendeeCount: 4, readiness: { going: 4, capacity: 10, spotsOpen: 5 } as Event["readiness"] }) }).spots).toBe("5 of 10 spots left");
    expect(facts({ event: ev({ capacity: 10, attendeeCount: 4, readiness: { going: 4, capacity: 10, spotsOpen: null } as Event["readiness"] }) }).spots).toBe("6 of 10 spots left");
  });

  it("going, cancelled and ended each have one status and one honest action", () => {
    expect(facts({ joined: true })).toMatchObject({ status: { tone: "positive", label: "You're going" }, action: "leave" });
    expect(facts({ event: ev({ status: "cancelled" }) })).toMatchObject({ status: { tone: "negative", label: "Cancelled" }, action: "none" });
    expect(facts({ event: ev({ status: "cancelled" }), joined: true })).toMatchObject({ action: "leave", note: "You were on the list." });
    expect(facts({ event: ev({ status: "cancelled", priceCents: 500 }), joined: true }).note).toBe("You were on the list. Tickets are being refunded.");
    expect(facts({ ended: true, joined: true })).toMatchObject({ status: { tone: "neutral", label: "Ended" }, action: "none" });
  });

  it("the viewer's own clock is shown only when it reads differently from the event's", () => {
    const at = "2026-11-14T20:00:00.000Z";
    expect(sameZoneAt(at, "America/New_York", "America/New_York")).toBe(true);
    expect(sameZoneAt(at, "America/New_York", "America/Detroit")).toBe(true);
    expect(sameZoneAt(at, "America/New_York", "America/Chicago")).toBe(false);
    expect(sameZoneAt(at, "America/New_York", "Not/AZone")).toBe(false);
  });
});

describe("the page, through the real page function and the demo repository", () => {
  it("reads in the editorial order: what, when, where, host, cost, what to expect, then the action", async () => {
    const event = await ctx.repo.events.create(input({ capacity: 12, activityDetails: { kind: "run", distanceMiles: 3, noDrop: true } }), host);
    const html = await render(event.id, null);
    const order = ["what", "when", "where", "host", "cost", "expect", "action"].map((name) => part(html, name));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect((html.match(/data-widget="(join|ticket)"/g) ?? []).length).toBe(1);
    expect(html).toContain('class="treatment-editorial');
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    // The old full-colour hero is gone.
    expect(html).not.toContain("bg-pulse text-white");
  });

  it("gives the date and time as text in the event's own zone, and the viewer's clock only when it differs", async () => {
    const event = await ctx.repo.events.create(input({ startsAt: "2027-01-16T23:30:00.000Z", endsAt: "2027-01-17T01:00:00.000Z", timeZone: "America/New_York" }), host);
    let t = text(await render(event.id, null));
    expect(t).toContain("Saturday, January 16");
    expect(t).toContain("6:30 PM – 8:00 PM EST");
    expect(t).not.toContain("Your time:");
    ctx.zone = "America/Los_Angeles";
    t = text(await render(event.id, null));
    expect(t).toContain("6:30 PM – 8:00 PM EST");
    expect(t).toMatch(/Your time: Sat, Jan 16, 3:30 PM – 5:00 PM PST/);
  });

  it("a free event says Free, offers Join, and shows spots only when the host set a limit", async () => {
    const open = await ctx.repo.events.create(input(), host);
    let html = await render(open.id, guest);
    expect(text(html)).toContain("Free");
    expect(text(html)).toContain("1 going");
    expect(text(html)).not.toMatch(/spots? left/);
    expect(widget(html, "join")).toMatchObject({ joined: false, full: false, signedIn: true });
    const capped = await ctx.repo.events.create(input({ capacity: 5 }), host);
    html = await render(capped.id, guest);
    expect(text(html)).toContain("1 going · 4 of 5 spots left");
  });

  it("a priced event shows its price and never the word free, for a buyer, the host, a signed-out reader, and with tickets off", async () => {
    const event = await ctx.repo.events.create(input({ capacity: 8 }), host);
    await ctx.repo.payments.setEventPrice(host, event.id, 1500);
    for (const viewer of [guest, host, null]) {
      const html = await render(event.id, viewer);
      expect(text(html)).toContain("$15.00 per ticket");
      expect(text(html)).not.toMatch(/\bfree\b/i);
    }
    const buyer = await render(event.id, guest);
    expect(widget(buyer, "ticket")).toMatchObject({ priceCents: 1500, disabled: false });
    expect(widget(buyer, "join")).toBeNull();
    // Payments switched off in this deployment: the price is still shown, and no action is offered that would fail.
    ctx.payments = null;
    const off = await render(event.id, guest);
    expect(text(off)).toContain("$15.00 per ticket");
    expect(text(off)).toContain("Tickets for this event can't be bought here right now.");
    expect(text(off)).not.toMatch(/\bfree\b/i);
    expect(widget(off, "ticket")).toBeNull();
    expect(widget(off, "join")).toBeNull();
  });

  it("a full free event says Full, keeps Join switched off, and offers no waitlist", async () => {
    const event = await ctx.repo.events.create(input({ capacity: 2 }), host);
    await ctx.repo.events.join(other, event.id);
    const html = await render(event.id, guest);
    const t = text(html);
    expect(t).toContain("2 going · Full");
    expect(t).toContain("Every spot is taken. One opens if someone leaves.");
    expect(widget(html, "join")).toMatchObject({ full: true, joined: false });
    expect(t).not.toMatch(/wait ?list|notify me|offer/i);
    // The repository refuses the join as well: the page is not the only guard.
    await expect(ctx.repo.events.join(guest, event.id)).rejects.toThrow(/full/i);
  });

  it("someone going sees that, with Leave as the action; the host sees hosting", async () => {
    const event = await ctx.repo.events.create(input({ capacity: 6 }), host);
    await ctx.repo.events.join(guest, event.id);
    const going = await render(event.id, guest);
    expect(text(going)).toContain("You're going");
    expect(widget(going, "join")).toMatchObject({ joined: true });
    const hosting = await render(event.id, host);
    expect(text(hosting)).toContain("You're hosting");
    expect(widget(hosting, "owner")).not.toBeNull();
  });

  it("a cancelled event says so at the top and at the action; only people who were going can still open it", async () => {
    const event = await ctx.repo.events.create(input(), host);
    await ctx.repo.events.join(guest, event.id);
    await ctx.repo.events.cancel(event.id, host);
    // Existing visibility rule, unchanged: a cancelled event is gone for everyone who was not on it.
    await expect(render(event.id, other)).rejects.toThrow("NOT_FOUND");
    await expect(render(event.id, null)).rejects.toThrow("NOT_FOUND");
    const attendee = await render(event.id, guest);
    expect((text(attendee).match(/Cancelled/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(text(attendee)).toContain("You were on the list.");
    expect(widget(attendee, "join")).toMatchObject({ joined: true, cancelled: true });
    expect(widget(attendee, "ticket")).toBeNull();
  });

  it("with no activity details there is no What to expect section, and the pilot flag hides it and the readiness row", async () => {
    const plain = await ctx.repo.events.create(input(), host);
    expect(part(await render(plain.id, null), "expect")).toBe(-1);
    const run = await ctx.repo.events.create(input({ capacity: 9, activityDetails: { kind: "run", distanceMiles: 3 } }), host);
    expect(text(await render(run.id, null))).toContain("What to expect");
    ctx.flags = new Set();
    const off = await render(run.id, null);
    expect(part(off, "expect")).toBe(-1);
    expect(off).not.toContain('data-testid="readiness-row"');
    // Cost and spots do not depend on the flag.
    expect(text(off)).toContain("1 going · 8 of 9 spots left");
  });

  it("session rules show beside the counts without repeating them", async () => {
    const event = await ctx.repo.events.create(input({ capacity: 10, sessionRules: { minAttendance: 4, decisionDeadline: null, venueStatus: "unconfirmed" } }), host);
    const html = await render(event.id, guest);
    const row = /data-testid="readiness-row">([^<]*)</.exec(html)?.[1] ?? "";
    expect(row).toContain("3 more needed");
    expect(row).toContain("venue not confirmed yet");
    expect(row).not.toMatch(/going|spots? open|Full/);
    expect(text(html)).toContain("1 going · 9 of 10 spots left");
  });

  it("a long title and a long description wrap instead of being cut", async () => {
    const title = "Sunday long run with coffee after at the place by the bridge, all paces, bring a friend along";
    const event = await ctx.repo.events.create(input({ title, description: "Line one.\nLine two with a verylongunbrokenwordthatcouldpushthepagewiderthanthephone." }), host);
    const html = await render(event.id, null);
    expect(html).toMatch(/<h1 class="[^"]*break-words[^"]*">/);
    expect(text(html)).toContain(title);
    expect(html).toMatch(/whitespace-pre-line break-words/);
  });
});
