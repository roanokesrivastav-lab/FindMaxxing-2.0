/**
 * Roadmap 2.7: best for / less suited for (0061_place_occasions.sql). RLS as anon,
 * the author, another user and a moderator; moderation hide; demo parity; the real
 * action and the place page (attributed notes, top two per side, "see all", nothing
 * summarized).
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_OCCASION_NOTES, normalizeOccasionInput, occasionSentence, orderOccasionNotes, type OccasionNote } from "../src/lib/places/occasions";
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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => ctx.viewer }));
vi.mock("@/components/map/MiniMap", () => ({ MiniMap: () => null }));

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const place = (name: string) => stableId(`place:${name}`);
const maya = user("maya_r");
const theo = user("theo");
const nina = user("nina"); // not a local
const mod = user("mo_moderator");
const cannon = place("Cannon & Crown");
const basement = place("Fourth Street Basement"); // locals-only

describe("occasion rules (pure)", () => {
  it("accepts only listed occasions and short notes; writes attributed sentences, never a summary", () => {
    expect(normalizeOccasionInput({ polarity: "best", occasion: "date", note: "  " })).toEqual({ polarity: "best", occasion: "date", note: null });
    expect(() => normalizeOccasionInput({ polarity: "best", occasion: "brunch" as never })).toThrow(/list/);
    expect(() => normalizeOccasionInput({ polarity: "best", occasion: "date", note: "x".repeat(141) })).toThrow(/140/);
    expect(occasionSentence({ polarity: "best", occasion: "date" })).toBe("Good for a relaxed date");
    expect(occasionSentence({ polarity: "less", occasion: "big-group" })).toBe("Less suited for a big group");
  });
  it("orders notes by people the viewer follows first, then newest, keeping each note whole", () => {
    const n = (id: string, author: string, createdAt: string): OccasionNote => ({ id, placeId: "p", polarity: "best", occasion: "date", note: id, status: "published", createdAt, author: { id: author, username: author, displayName: author, avatarUrl: null } });
    expect(orderOccasionNotes([n("a", "x", "2026-02-01"), n("b", "friend", "2026-01-01"), n("c", "y", "2026-03-01")], ["friend"]).map((x) => x.id)).toEqual(["b", "c", "a"]);
  });
});

describe("occasion notes in the database", () => {
  let db: PGlite;
  const as = <T>(userId: string | null, sql: string, params: unknown[] = []) => queryAs<T>(db, userId, sql, params);
  const add = async (author: string, placeId: string, polarity: string, occasion: string, note: string | null = null) =>
    (await as<{ id: string }>(author, "insert into public.place_occasion_notes (place_id, author_id, polarity, occasion, note) values ($1, $2, $3, $4, $5) returning id", [placeId, author, polarity, occasion, note]))[0].id;

  beforeAll(async () => {
    db = await createSeededDb();
  });

  it("seeds the same notes as the demo store", async () => {
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.place_occasion_notes");
    expect(rows[0].n).toBe(SEED_OCCASION_NOTES.length);
  });

  it("anon reads notes on public places only; a non-local cannot read or write on a locals-only place", async () => {
    expect((await as(null, "select id from public.place_occasion_notes where place_id = $1", [cannon])).length).toBeGreaterThan(0);
    await db.query("insert into public.place_occasion_notes (place_id, author_id, polarity, occasion) values ($1, $2, 'best', 'late-night')", [basement, maya]);
    expect(await as(null, "select id from public.place_occasion_notes where place_id = $1", [basement])).toHaveLength(0);
    expect(await as(nina, "select id from public.place_occasion_notes where place_id = $1", [basement])).toHaveLength(0);
    await expect(add(nina, basement, "less", "kids")).rejects.toThrow();
    await expect(as(null, "insert into public.place_occasion_notes (place_id, author_id, polarity, occasion) values ($1, $2, 'best', 'date')", [cannon, maya])).rejects.toThrow();
  });

  it("many opinions coexist, one per author, occasion and side; nobody writes as someone else", async () => {
    await add(maya, cannon, "best", "date", "Corner booth");
    await add(theo, cannon, "best", "date", "Not on game day though");
    await add(maya, cannon, "less", "date");
    await expect(add(maya, cannon, "best", "date")).rejects.toThrow(/duplicate|unique/);
    await expect(as(maya, "insert into public.place_occasion_notes (place_id, author_id, polarity, occasion) values ($1, $2, 'best', 'kids')", [cannon, theo])).rejects.toThrow();
    await expect(add(maya, cannon, "best", "brunch")).rejects.toThrow(/check/);
  });

  it("authors edit and delete only their own; only moderators hide, and hidden notes vanish for others", async () => {
    const id = await add(maya, cannon, "best", "solo-work", "Quiet before 5");
    expect(await as(theo, "update public.place_occasion_notes set note = 'x' where id = $1 returning id", [id])).toHaveLength(0);
    expect(await as(theo, "delete from public.place_occasion_notes where id = $1 returning id", [id])).toHaveLength(0);
    await expect(as(maya, "update public.place_occasion_notes set status = 'hidden' where id = $1", [id])).rejects.toThrow(/moderators/);
    await expect(as(maya, "update public.place_occasion_notes set author_id = $2 where id = $1", [id, theo])).rejects.toThrow(/permission denied/);
    await as(mod, "update public.place_occasion_notes set status = 'hidden' where id = $1", [id]);
    for (const viewer of [null, theo, nina]) expect(await as(viewer, "select id from public.place_occasion_notes where id = $1", [id])).toHaveLength(0);
    expect(await as(maya, "select id from public.place_occasion_notes where id = $1", [id])).toHaveLength(1);
    expect(await as(mod, "select id from public.place_occasion_notes where id = $1", [id])).toHaveLength(1);
    await expect(as(maya, "update public.place_occasion_notes set status = 'published' where id = $1", [id])).rejects.toThrow(/moderators/);
  });
});

describe("occasion notes in the demo repository", () => {
  let repo: DataRepository;
  beforeEach(() => {
    repo = createDemoRepository(createIsolatedStore());
  });

  it("matches the database rules: seeded notes, visibility, one per side, author-only removal, moderator hide", async () => {
    expect((await repo.occasions.list(cannon, null)).length).toBe(SEED_OCCASION_NOTES.filter((n) => n.place === "Cannon & Crown").length);
    await expect(repo.occasions.add(nina, basement, { polarity: "best", occasion: "kids" })).rejects.toMatchObject({ code: "not_found" });
    const a = await repo.occasions.add(maya, cannon, { polarity: "best", occasion: "date", note: "Corner booth" });
    const again = await repo.occasions.add(maya, cannon, { polarity: "best", occasion: "date", note: "Back booth" });
    expect(again.id).toBe(a.id);
    expect(again.note).toBe("Back booth");
    await expect(repo.occasions.remove(theo, a.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(repo.occasions.setStatus(theo, a.id, "hidden")).rejects.toMatchObject({ code: "forbidden" });
    await repo.occasions.setStatus(mod, a.id, "hidden");
    expect((await repo.occasions.list(cannon, null)).map((n) => n.id)).not.toContain(a.id);
  });
});

describe("occasion action and the place page", () => {
  beforeEach(() => {
    ctx.repo = createDemoRepository(createIsolatedStore());
    ctx.viewer = null;
  });

  const render = async () => {
    const { default: PlacePage } = await import("../src/app/places/[id]/page");
    const el = (await PlacePage({ params: Promise.resolve({ id: cannon }), searchParams: Promise.resolve({}) } as never)) as ReactElement;
    return renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: h(ToastProvider, null, el) }));
  };

  it("adds through the real action, and the page shows the top two per side with attribution and see all", async () => {
    const { addOccasionNoteAction } = await import("../src/server/actions/tips");
    expect(await addOccasionNoteAction({ placeId: cannon, polarity: "best", occasion: "date" })).toMatchObject({ ok: false, code: "unauthenticated" });
    for (const [u, occasion] of [[maya, "date"], [theo, "late-night"]] as const) {
      ctx.viewer = { id: u };
      expect(await addOccasionNoteAction({ placeId: cannon, polarity: "best", occasion, note: `note by ${u}` })).toEqual({ ok: true, data: undefined });
    }
    ctx.viewer = { id: maya };
    const html = await render();
    const best = html.slice(html.indexOf('data-occasion-side="best"'), html.indexOf('data-occasion-side="less"'));
    // Three "best" notes (one seeded): two shown, the third behind "See all 3".
    expect(best).toContain("See all 3");
    expect(best).toContain("Good for a big group");
    expect(html).toContain("Less suited for talking over a drink");
    expect(html).toContain("Jules");
    expect(html).not.toMatch(/most people|everyone agrees|\d+% (say|of)/i);
    // Slot 7: after reviews, before the local tip.
    expect(html.indexOf('data-block="occasions"')).toBeGreaterThan(html.indexOf('data-block="reviews"'));
    expect(html.indexOf('data-block="occasions"')).toBeLessThan(html.indexOf('data-block="tip"'));
  });
});
