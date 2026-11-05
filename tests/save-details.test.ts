/**
 * Roadmap 3.1: richer saves (0062_save_details.sql). Save first, organise later;
 * every detail is owner-only. Tests the database as anon, the owner, another user
 * and a moderator; the demo twin; the real action; and the privacy promise on the
 * place page, share metadata and recommendations.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { normalizeSaveInput, suggestTags } from "../src/lib/places/saves";
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
const mod = user("mo_moderator");
const cannon = place("Cannon & Crown"); // saved by maya in the seed
const tuttle = place("Tuttle Lot Fields");
const SECRET = "Ask for Ana, she knows the owner";

describe("save details (pure)", () => {
  it("normalizes only the fields given, and refuses bad values", () => {
    expect(normalizeSaveInput({ tags: [" Date Night ", "date night", ""] })).toEqual({ tags: ["date night"] });
    expect(normalizeSaveInput({ note: "  " })).toEqual({ note: null });
    expect(() => normalizeSaveInput({ sourceUrl: "javascript:alert(1)" })).toThrow(/web link/);
    expect(() => normalizeSaveInput({ tags: Array.from({ length: 11 }, (_, i) => `t${i}`) })).toThrow(/10/);
    expect(() => normalizeSaveInput({ status: "loved" as never })).toThrow();
  });
  it("suggests the viewer's own tags first, then the place's community interests; never invents", () => {
    expect(suggestTags([{ tag: "brunch", count: 1 }, { tag: "date night", count: 3 }], ["coffee"], ["brunch"])).toEqual(["date night", "coffee"]);
  });
});

describe("save details in the database", () => {
  let db: PGlite;
  const as = <T>(userId: string | null, sql: string, params: unknown[] = []) => queryAs<T>(db, userId, sql, params);
  beforeAll(async () => {
    db = await createSeededDb();
  });

  it("saving is still one insert with nothing else asked; it starts as want to go with no tags", async () => {
    await as(theo, "insert into public.saved_places (user_id, place_id) values ($1, $2)", [theo, tuttle]);
    const [row] = await as<{ status: string; tags: string[]; note: string | null }>(theo, "select status, tags, note from public.saved_places where user_id = $1 and place_id = $2", [theo, tuttle]);
    expect(row).toEqual({ status: "want_to_go", tags: [], note: null });
  });

  it("the owner edits the details; tags are normalized", async () => {
    await as(maya, "update public.saved_places set note = $3, tags = array[' Date Night ','date night','Wings'], recommended_by = 'Theo', source_url = 'https://example.com/x', status = 'visited' where user_id = $1 and place_id = $2", [maya, cannon, SECRET]);
    const [row] = await as<{ note: string; tags: string[]; status: string }>(maya, "select note, tags, status from public.saved_places where user_id = $1 and place_id = $2", [maya, cannon]);
    expect(row).toEqual({ note: SECRET, tags: ["date night", "wings"], status: "visited" });
  });

  it("anon, another user and a moderator cannot read or change them", async () => {
    for (const viewer of [null, theo, mod]) {
      expect(await as(viewer, "select note from public.saved_places where user_id = $1", [maya])).toHaveLength(0);
    }
    expect(await as(theo, "update public.saved_places set note = 'x' where user_id = $1 returning 1", [maya])).toHaveLength(0);
    expect(await as(mod, "update public.saved_places set status = 'want_to_go' where user_id = $1 returning 1", [maya])).toHaveLength(0);
    await expect(as(maya, "update public.saved_places set user_id = $2 where user_id = $1 and place_id = $3", [maya, theo, cannon])).rejects.toThrow(/permission denied/);
    await expect(as(maya, "update public.saved_places set source_url = 'ftp://x' where user_id = $1 and place_id = $2", [maya, cannon])).rejects.toThrow(/check/);
  });

  it("no view or function anywhere reads the private columns", async () => {
    const { rows } = await db.query<{ proname: string }>(
      "select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.prosrc ~* 'recommended_by|source_url' or (p.prosrc ~* 'saved_places' and p.prosrc ~* '\\mnote\\M'))",
    );
    expect(rows.map((r) => r.proname).filter((n) => n !== "normalize_save_details")).toEqual([]);
    const views = await db.query<{ viewname: string }>("select viewname from pg_views where schemaname = 'public' and definition ~* 'recommended_by|source_url'");
    expect(views.rows).toEqual([]);
  });
});

describe("save details in the demo repository", () => {
  let repo: DataRepository;
  beforeEach(() => {
    repo = createDemoRepository(createIsolatedStore());
  });

  it("owner-only reads and writes; unsave removes the details with the save", async () => {
    expect(await repo.saves.get(maya, cannon)).toMatchObject({ status: "want_to_go", tags: [], note: null });
    const saved = await repo.saves.update(maya, cannon, { note: SECRET, tags: ["Date Night"], status: "visited" });
    expect(saved).toMatchObject({ note: SECRET, tags: ["date night"], status: "visited" });
    expect(await repo.saves.get(theo, cannon)).toBeNull();
    await expect(repo.saves.update(theo, cannon, { note: "x" })).rejects.toMatchObject({ code: "not_found" });
    expect(await repo.saves.tags(maya)).toEqual([{ tag: "date night", count: 1 }]);
    await repo.places.unsave(maya, cannon);
    await repo.places.save(maya, cannon);
    expect(await repo.saves.get(maya, cannon)).toMatchObject({ note: null, tags: [] });
  });

  it("recommendations for someone else never carry the note, tags or recommender", async () => {
    await repo.saves.update(maya, cannon, { note: SECRET, tags: ["zz-private-tag"], recommendedBy: "Secret Sam" });
    const out = JSON.stringify([await repo.recommendations.places(theo), await repo.places.get(cannon, theo), await repo.places.listRatings(cannon, theo)]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain("zz-private-tag");
    expect(out).not.toContain("Secret Sam");
  });
});

describe("the place page and the action", () => {
  beforeEach(() => {
    ctx.repo = createDemoRepository(createIsolatedStore());
    ctx.viewer = null;
  });
  afterEach(() => vi.unstubAllEnvs());

  const render = async (id = cannon) => {
    const { default: PlacePage } = await import("../src/app/places/[id]/page");
    const el = (await PlacePage({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) } as never)) as ReactElement;
    return renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: h(ToastProvider, null, el) }));
  };

  it("the action edits only the viewer's own save", async () => {
    const { updateSaveDetailsAction } = await import("../src/server/actions/saves");
    expect(await updateSaveDetailsAction(cannon, { note: "x" })).toMatchObject({ ok: false, code: "unauthenticated" });
    ctx.viewer = { id: theo };
    expect(await updateSaveDetailsAction(cannon, { note: "x" })).toMatchObject({ ok: false, code: "not_found" });
    ctx.viewer = { id: maya };
    expect(await updateSaveDetailsAction(cannon, { note: SECRET, recommendedBy: "Secret Sam" })).toMatchObject({ ok: true });
  });

  it("the owner sees why they saved it, marked Only you, apart from the place's own information", async () => {
    await ctx.repo.saves.update(maya, cannon, { note: SECRET });
    ctx.viewer = { id: maya };
    const html = await render();
    expect(html).toContain('data-block="my-save"');
    expect(html).toContain(SECRET);
    expect((html.match(/Only you/g) ?? []).length).toBeGreaterThanOrEqual(4);
    expect(html.indexOf('data-block="my-save"')).toBeLessThan(html.indexOf('data-block="community"'));
  });

  it("another user, anon and share metadata never see it", async () => {
    await ctx.repo.saves.update(maya, cannon, { note: SECRET, tags: ["zz-private-tag"], recommendedBy: "Secret Sam" });
    for (const viewer of [null, { id: theo }, { id: mod }]) {
      ctx.viewer = viewer;
      const html = await render();
      expect(html).not.toContain(SECRET);
      expect(html).not.toContain("zz-private-tag");
      expect(html).not.toContain("Secret Sam");
      expect(html).not.toContain('data-block="my-save"');
    }
    const { generateMetadata } = await import("../src/app/places/[id]/page");
    expect(JSON.stringify(await generateMetadata({ params: Promise.resolve({ id: cannon }) } as never))).not.toContain(SECRET);
  });

  it("with pilotLibrary off the section is not shown, and saving still needs nothing else", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "pilotExplore");
    ctx.viewer = { id: maya };
    expect(await render()).not.toContain('data-block="my-save"');
    await ctx.repo.places.save(maya, tuttle);
    expect(await ctx.repo.saves.get(maya, tuttle)).toMatchObject({ tags: [], status: "want_to_go" });
  });
});
