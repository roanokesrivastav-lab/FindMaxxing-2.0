/**
 * Roadmap 4.5b: the permanent series page (pilotEvents) on the demo repository's seed series: next
 * (confirmed) session, coming up, hosts, the newcomer note, follow (updates only; never an RSVP), host
 * tools (backup hosts by the owner only; attendance after a session), the occurrence → series link, and
 * followed series counting as "events you usually go to" on the Events tab.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_SERIES, SEED_USERS, seriesOccurrenceId } from "../src/lib/seed/seed-data";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { ToastProvider } from "../src/components/ui/Toast";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const hana = user("hana_host"), marcus = user("marcus"), pat = user("pat_participant"), nina = user("nina");
const S = SEED_SERIES[0];

const ctx: { viewer: string | null; repo: DataRepository; store: ReturnType<typeof createIsolatedStore> } = { viewer: nina, ...(() => { const store = createIsolatedStore(); return { store, repo: createDemoRepository(store) }; })() };
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null) }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/time/server", () => ({ getViewerTime: async () => ({ timeZone: "America/New_York", now: Date.now() }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {}, back() {} }),
  usePathname: () => "/series",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }); },
  redirect: (to: string) => { throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` }); },
}));

const wrap = (el: unknown) => renderToStaticMarkup(h(ToastProvider, null, h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: el as never })));
const renderSeries = async (id = S.id) => {
  const { default: Page } = await import("../src/app/series/[id]/page");
  return wrap(await Page({ params: Promise.resolve({ id }) } as never));
};

beforeEach(() => { ctx.store = createIsolatedStore(); ctx.repo = createDemoRepository(ctx.store); ctx.viewer = nina; });
afterEach(() => vi.unstubAllEnvs());

describe("/series/[id]", () => {
  it("only with pilotEvents; unknown or malformed ids are not found", async () => {
    await expect(renderSeries("not-a-uuid")).rejects.toThrow(/NEXT_NOT_FOUND/);
    await expect(renderSeries("00000000-0000-4000-8000-000000000000")).rejects.toThrow(/NEXT_NOT_FOUND/);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    await expect(renderSeries()).rejects.toThrow(/NEXT_NOT_FOUND/);
  });

  it("shows the schedule, next session with its Readiness row, coming up, hosts, the newcomer note and Follow", async () => {
    const html = await renderSeries();
    expect(html).toContain("Saturday morning pickleball");
    expect(html).toMatch(/(Mondays|Tuesdays|Wednesdays|Thursdays|Fridays|Saturdays|Sundays) at 9:00 AM/);
    expect(html).toContain(">Next session<"); // min 4, not confirmed yet
    expect(html).toContain("Not confirmed yet");
    expect(html).toContain("data-readiness");
    expect(html).toContain(">Coming up<");
    expect(html).toContain("Hana");
    expect(html).toContain("backup host");
    expect(html).toContain("New here?");
    expect(html).toContain("The bench by court 2");
    expect(html).toContain("Level: Casual");
    expect(html).toMatch(/aria-pressed="false"[^>]*>.*Follow/);
    expect(html).toContain("It never signs you up.");
    expect(html).toContain("No past sessions yet.");
    expect(html).not.toContain("Add a backup host");
  });

  it("a host confirm turns it into the next confirmed session", async () => {
    await ctx.repo.events.confirmSession(hana, seriesOccurrenceId(S, 0));
    expect(await renderSeries()).toContain(">Next confirmed session<");
  });

  it("follow is updates only: no attendee or participant row; the button and the Events tab reflect it", async () => {
    const { followSeriesAction } = await import("../src/server/actions/events");
    expect(await followSeriesAction(S.id, true)).toMatchObject({ ok: true, data: { following: true } });
    for (let k = 0; k < S.occurrences; k++) {
      const ev = (await ctx.repo.events.get(seriesOccurrenceId(S, k), nina))!;
      expect(ev.viewerJoined).toBe(false);
      expect(ev.viewerParticipant).toBeNull();
    }
    expect(await renderSeries()).toMatch(/aria-pressed="true"[^>]*>.*Following/);
    // The Events tab: occurrences of a followed series are "events you usually go to".
    const { default: Events } = await import("../src/app/events/page");
    const tab = wrap(await Events());
    expect(tab).toContain("From Saturday morning pickleball, which you follow");
  });

  it("host tools: only the owner manages backup hosts; removal is immediate", async () => {
    ctx.viewer = hana;
    expect(await renderSeries()).toContain("Add a backup host");
    ctx.viewer = marcus;
    expect(await renderSeries()).not.toContain("Add a backup host");
    const { setSeriesHostAction, seriesHostAction } = await import("../src/server/actions/events");
    expect(await setSeriesHostAction(S.id, "@nina", true)).toMatchObject({ ok: false });
    ctx.viewer = hana;
    expect(await setSeriesHostAction(S.id, "@nina", true)).toMatchObject({ ok: true });
    expect(await setSeriesHostAction(S.id, "@nobody_here", true)).toMatchObject({ ok: false, fieldErrors: { hostUsername: "No one with that username" } });
    expect((await ctx.repo.series.get(S.id, nina))!.viewerIsHost).toBe(true);
    await setSeriesHostAction(S.id, nina, false);
    ctx.viewer = nina;
    expect(await seriesHostAction("cancel-occurrence", seriesOccurrenceId(S, 1))).toMatchObject({ ok: false });
  });

  it("past sessions: hosts record who came after the end; others cannot", async () => {
    const first = ctx.store.state.events.find((e) => e.id === seriesOccurrenceId(S, 0))!;
    first.startsAt = new Date(Date.now() - 3 * 3_600_000).toISOString();
    first.endsAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    ctx.viewer = hana;
    const html = await renderSeries();
    expect(html).toContain("Who came?");
    expect(html).toContain("Pat");
    const { setAttendedAction } = await import("../src/server/actions/events");
    expect(await setAttendedAction(first.id, pat, true)).toMatchObject({ ok: true });
    expect(await ctx.repo.series.attendance(hana, first.id)).toContainEqual({ userId: pat, attended: true });
    ctx.viewer = nina;
    expect(await setAttendedAction(first.id, pat, false)).toMatchObject({ ok: false });
    expect(await renderSeries()).not.toContain("Who came?");
  });

  it("an occurrence's page links to its series", async () => {
    const { default: EventPage } = await import("../src/app/events/[id]/page");
    const html = wrap(await EventPage({ params: Promise.resolve({ id: seriesOccurrenceId(S, 1) }), searchParams: Promise.resolve({}) } as never));
    expect(html).toContain(`href="/series/${S.id}"`);
    expect(html).toContain("Part of a weekly series: Saturday morning pickleball");
  });
});
