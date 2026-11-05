/**
 * Roadmap R3: lightweight clubs (0056; spec docs/features/R3.md). Series hosts create clubs around
 * series they host; joining never RSVPs; members-only member names (count for others); owner-only
 * removal; moderator removal. RLS on PGlite as anon / owner / member / another user / moderator, demo
 * parity, the real actions and page, flag-off 404.
 */
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_SERIES, SEED_USERS, seriesOccurrenceId } from "../src/lib/seed/seed-data";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";
import { ToastProvider } from "../src/components/ui/Toast";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const hana = user("hana_host"), marcus = user("marcus"), nina = user("nina"), lena = user("lena"), sam = user("sam_k");
const S = SEED_SERIES[0];

const ctx: { viewer: string | null; repo: DataRepository } = { viewer: hana, repo: createDemoRepository(createIsolatedStore()) };
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null) }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/time/server", () => ({ getViewerTime: async () => ({ timeZone: "America/New_York", now: Date.now() }) }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {}, back() {} }),
  usePathname: () => "/clubs",
  useSearchParams: () => new URLSearchParams(),
  notFound: () => { throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" }); },
  redirect: (to: string) => { throw Object.assign(new Error(`NEXT_REDIRECT ${to}`), { digest: `NEXT_REDIRECT;${to}` }); },
}));

describe("database (PGlite)", () => {
  let db: PGlite;
  let club: string;
  beforeAll(async () => {
    db = await createSeededDb();
    club = (await queryAs<{ id: string }>(db, hana, "select public.create_club('Schiller pickleball crew', 'Saturday regulars.', $1) as id", [[S.id]]))[0].id;
  });
  const members = (who: string | null) => queryAs<{ user_id: string }>(db, who, "select user_id from public.club_members where club_id = $1 order by user_id", [club]);

  it("only a host of the series can build a club around it", async () => {
    await expect(queryAs(db, nina, "select public.create_club('Not mine', '', $1)", [[S.id]])).rejects.toThrow(/series you host/);
    // marcus is a backup host of the seed series: allowed.
    expect((await queryAs<{ id: string }>(db, marcus, "select public.create_club('Backup crew', '', $1) as id", [[S.id]]))[0].id).toBeTruthy();
    await expect(queryAs(db, hana, "select public.create_club('Empty', '', '{}')")).rejects.toThrow(/at least one series/);
  });

  it("joining never RSVPs and is open; leaving works; the owner cannot leave", async () => {
    await queryAs(db, nina, "select public.join_club($1, true)", [club]);
    for (let k = 0; k < S.occurrences; k++) {
      const ev = seriesOccurrenceId(S, k);
      expect((await db.query("select 1 from public.event_attendees where event_id = $1 and user_id = $2", [ev, nina])).rows).toEqual([]);
      expect((await db.query("select 1 from public.event_participants where event_id = $1 and user_id = $2", [ev, nina])).rows).toEqual([]);
    }
    expect((await db.query("select 1 from public.event_series_followers where user_id = $1", [nina])).rows).toEqual([]); // no auto-follow
    await expect(queryAs(db, hana, "select public.join_club($1, false)", [club])).rejects.toThrow(/owner cannot leave/);
  });

  it("members-only privacy: members and hosts see names; another user, a moderator and anon see only the count", async () => {
    expect((await members(nina)).map((r) => r.user_id).sort()).toEqual([hana, nina].sort());
    expect((await members(hana)).length).toBe(2);
    expect((await members(marcus)).length).toBe(2); // series backup host = club host
    expect(await members(lena)).toEqual([]);
    expect(await members(sam)).toEqual([]);
    expect(await members(null)).toEqual([]);
    for (const who of [lena, null]) expect((await queryAs<{ n: number }>(db, who, "select public.club_member_count($1) as n", [club]))[0].n).toBe(2);
    expect(await queryAs(db, null, "select id from public.clubs where id = $1", [club])).toHaveLength(1);
  });

  it("no direct writes; only the owner removes members; moderators remove and restore", async () => {
    await expect(queryAs(db, lena, "insert into public.club_members (club_id, user_id) values ($1, $2)", [club, lena])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, hana, "update public.clubs set name = 'x' where id = $1", [club])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, nina, "select public.remove_club_member($1, $2)", [club, hana])).rejects.toThrow(/Only the club owner/);
    await queryAs(db, hana, "select public.remove_club_member($1, $2)", [club, nina]);
    expect((await members(hana)).map((r) => r.user_id)).toEqual([hana]);
    await expect(queryAs(db, nina, "select public.moderate_club($1, true)", [club])).rejects.toThrow(/Moderators only/);
    await queryAs(db, sam, "select public.moderate_club($1, true)", [club]);
    expect(await queryAs(db, null, "select id from public.clubs where id = $1", [club])).toEqual([]);
    expect(await queryAs(db, hana, "select id from public.clubs where id = $1", [club])).toHaveLength(1); // the owner still sees it
    await expect(queryAs(db, lena, "select public.join_club($1, true)", [club])).rejects.toThrow(/not found/);
    await queryAs(db, sam, "select public.moderate_club($1, false)", [club]);
    expect(await queryAs(db, null, "select id from public.clubs where id = $1", [club])).toHaveLength(1);
  });
});

describe("demo parity, actions and page", () => {
  beforeEach(() => { ctx.repo = createDemoRepository(createIsolatedStore()); ctx.viewer = hana; });
  afterEach(() => vi.unstubAllEnvs());
  const render = async (id: string) => {
    const { default: Page } = await import("../src/app/clubs/[id]/page");
    return renderToStaticMarkup(h(ToastProvider, null, h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: await Page({ params: Promise.resolve({ id }) } as never) })));
  };

  it("the real create action (series host only), join/leave actions, and members-only names on the page", async () => {
    const { createClubAction, clubMemberAction } = await import("../src/server/actions/events");
    ctx.viewer = nina;
    expect(await createClubAction(S.id, "Nope club", "")).toMatchObject({ ok: false });
    ctx.viewer = hana;
    expect(await createClubAction(S.id, "ab", "")).toMatchObject({ ok: false, fieldErrors: { name: expect.any(String) } });
    const res = await createClubAction(S.id, "Schiller pickleball crew", "Saturday regulars.");
    expect(res.ok).toBe(true);
    const id = (res as { ok: true; data: { id: string } }).data.id;
    expect(await ctx.repo.clubs.forSeries(S.id)).toEqual([{ id, name: "Schiller pickleball crew" }]);
    ctx.viewer = nina;
    expect(await clubMemberAction(id, "join")).toMatchObject({ ok: true });
    expect((await ctx.repo.events.get(seriesOccurrenceId(S, 1), nina))!.viewerJoined).toBe(false);
    const asMember = await render(id);
    expect(asMember).toContain("Schiller pickleball crew");
    expect(asMember).toContain("Saturday morning pickleball");
    expect(asMember).toContain("Nina");
    expect(asMember).toContain(">Leave club<");
    expect(asMember).toContain("Joining never signs you up for a session.");
    ctx.viewer = lena;
    const asOther = await render(id);
    expect(asOther).toContain("Only members see who");
    expect(asOther).not.toContain("Nina");
    expect(asOther).toContain(">Join club<");
    ctx.viewer = null;
    expect(await render(id)).toContain("2 members");
    ctx.viewer = hana;
    const asOwner = await render(id);
    expect(asOwner).toContain("Remove<span class=\"sr-only\"> Nina");
    expect(await clubMemberAction(id, "remove", nina)).toMatchObject({ ok: true });
    expect((await ctx.repo.clubs.get(id, hana))!.memberCount).toBe(1);
  });

  it("the series page lists its clubs and offers 'Start a club' to hosts only; flag off → 404", async () => {
    const id = await ctx.repo.clubs.create(hana, { name: "Crew", description: "", seriesIds: [S.id] });
    const { default: SeriesPage } = await import("../src/app/series/[id]/page");
    const renderSeries = async () => renderToStaticMarkup(h(ToastProvider, null, h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: await SeriesPage({ params: Promise.resolve({ id: S.id }) } as never) })));
    expect(await renderSeries()).toContain("Start a club around this series");
    ctx.viewer = nina;
    const html = await renderSeries();
    expect(html).toContain(`href="/clubs/${id}"`);
    expect(html).not.toContain("Start a club");
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    await expect(render(id)).rejects.toThrow(/NEXT_NOT_FOUND/);
  });
});
