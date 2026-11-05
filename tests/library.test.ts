/**
 * Roadmap 3.2: library tools in /saved. Search and filters, bulk edit with undo for
 * every action, owner-only CSV/JSON export, 500 saves paginated, and today's page
 * untouched with pilotLibrary off. Runs the real page, actions and export route
 * against an isolated demo repository.
 */
import { createElement as h, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore, type StoreHandle } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { applyBulk, filterLibrary, parseLibraryFilters, toCsv, type ExportRow, type LibraryItem } from "../src/lib/places/library";
import { ToastProvider } from "../src/components/ui/Toast";
import { ViewerTimeProvider } from "../src/components/time/ViewerTime";

const ctx = vi.hoisted(() => ({ repo: null as unknown as DataRepository, viewer: null as { id: string } | null }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw Object.assign(new Error("NEXT_NOT_FOUND"), { digest: "NEXT_NOT_FOUND" });
  },
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { digest: "NEXT_REDIRECT", to });
  },
  useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {} }),
  usePathname: () => "/saved",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => ctx.viewer }));

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const place = (name: string) => stableId(`place:${name}`);
const maya = user("maya_r");
const theo = user("theo");
const cannon = place("Cannon & Crown");
const meeple = place("Meeple Cellar");
const SECRET = "Ask for Ana, she knows the owner";

let handle: StoreHandle;
beforeEach(() => {
  handle = createIsolatedStore();
  ctx.repo = createDemoRepository(handle);
  ctx.viewer = null;
});
afterEach(() => vi.unstubAllEnvs());

async function renderSaved(sp: Record<string, string> = {}) {
  const { default: SavedPage } = await import("../src/app/saved/page");
  const el = (await SavedPage({ params: Promise.resolve({}), searchParams: Promise.resolve(sp) } as never)) as ReactElement;
  return renderToStaticMarkup(h(ViewerTimeProvider, { initial: { timeZone: "America/New_York", now: Date.now() }, children: h(ToastProvider, null, el) }));
}

describe("library helpers (pure)", () => {
  const item = (name: string, extra: Partial<LibraryItem["save"]> = {}, categorySlug = "food"): LibraryItem => ({
    place: { id: name, name, categorySlug, neighborhood: "Short North", city: "Columbus", tags: [] } as unknown as LibraryItem["place"],
    save: { placeId: name, note: null, tags: [], sourceUrl: null, recommendedBy: null, status: "want_to_go", createdAt: "2026-01-01", updatedAt: "2026-01-01", ...extra },
    listIds: [],
  });
  it("filters by text across place and own fields, tag, status and category", () => {
    const items = [item("Alpha", { note: "great dumplings" }), item("Beta", { tags: ["date night"], status: "visited" }, "coffee-study")];
    expect(filterLibrary(items, parseLibraryFilters({ q: "dumpl" })).map((i) => i.place.name)).toEqual(["Alpha"]);
    expect(filterLibrary(items, parseLibraryFilters({ tag: "Date Night" })).map((i) => i.place.name)).toEqual(["Beta"]);
    expect(filterLibrary(items, parseLibraryFilters({ status: "visited" })).map((i) => i.place.name)).toEqual(["Beta"]);
    expect(filterLibrary(items, parseLibraryFilters({ category: "coffee-study" })).map((i) => i.place.name)).toEqual(["Beta"]);
    expect(parseLibraryFilters({ status: "bogus" }).status).toBeNull();
  });
  it("bulk patches are minimal and idempotent", () => {
    const s = item("A", { tags: ["x"] }).save;
    expect(applyBulk(s, { kind: "addTag", tag: "x" })).toBeNull();
    expect(applyBulk(s, { kind: "addTag", tag: "y" })).toEqual({ tags: ["x", "y"] });
    expect(applyBulk(s, { kind: "status", status: "want_to_go" })).toBeNull();
  });
  it("CSV quotes, keeps numbers, and defuses spreadsheet formulas", () => {
    const row = { name: '=HYPERLINK("x")', category: "Food", neighborhood: null, city: "Columbus", address: "1, Main", lat: 39.9, lng: -83.0, link: "l", status: "visited", tags: ["a", "b"], note: 'say "hi"', recommended_by: null, source_url: null, lists: [], saved_at: "2026" } as ExportRow;
    const csv = toCsv([row]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(",-83,");
    expect(csv).toContain('"1, Main"');
    expect(csv).toContain('"say ""hi"""');
    expect(csv).toContain("a; b");
  });
});

describe("bulk edit and undo (demo repository)", () => {
  it("every bulk action can be undone exactly", async () => {
    const repo = ctx.repo;
    const list = await repo.savedLists.create(maya, "Date night");
    const other = await repo.savedLists.create(maya, "Rainy day");
    await repo.savedLists.addPlace(maya, other.id, cannon);
    await repo.saves.update(maya, cannon, { note: SECRET, tags: ["wings"] });
    const before = JSON.stringify(await repo.saves.library(maya));
    const ops = [
      { kind: "status", status: "visited" },
      { kind: "addTag", tag: "Date Night" },
      { kind: "removeTag", tag: "wings" },
      { kind: "moveToList", listId: list.id },
      { kind: "remove" },
    ] as const;
    for (const op of ops) {
      const snapshots = await repo.saves.bulk(maya, [cannon, meeple], op);
      expect(snapshots.map((s) => s.placeId).sort()).toEqual([cannon, meeple].sort());
      expect(JSON.stringify(await repo.saves.library(maya))).not.toEqual(before);
      await repo.saves.restore(maya, snapshots);
      const after = (await repo.saves.library(maya)).map((i) => ({ ...i, save: { ...i.save, createdAt: "", updatedAt: "" } }));
      const expected = (JSON.parse(before) as LibraryItem[]).map((i) => ({ ...i, save: { ...i.save, createdAt: "", updatedAt: "" } }));
      expect(after.sort((a, b) => a.place.id.localeCompare(b.place.id))).toEqual(expected.sort((a, b) => a.place.id.localeCompare(b.place.id)));
    }
  });

  it("acts only on the owner's own saves and lists", async () => {
    const repo = ctx.repo;
    const theos = new Set((await repo.saves.library(theo)).map((i) => i.place.id));
    const notTheirs = (await repo.saves.library(maya)).map((i) => i.place.id).filter((id) => !theos.has(id));
    expect(notTheirs.length).toBeGreaterThan(0);
    await expect(repo.saves.bulk(theo, notTheirs, { kind: "status", status: "visited" })).rejects.toMatchObject({ code: "not_found" });
    const theosList = await repo.savedLists.create(theo, "Mine");
    await expect(repo.saves.bulk(maya, [cannon], { kind: "moveToList", listId: theosList.id })).rejects.toMatchObject({ code: "not_found" });
    // A crafted undo cannot reach someone else's save or list.
    await repo.saves.restore(maya, [{ placeId: cannon, saved: true, details: null, listIds: [theosList.id] }]);
    expect((await repo.savedLists.get(theo, theosList.id))?.places).toEqual([]);
    if (!theos.has(cannon)) expect(await repo.saves.get(theo, cannon)).toBeNull();
  });
});

describe("actions, export and the page", () => {
  it("bulk and undo actions need a signed-in viewer and return a summary", async () => {
    const { bulkSavesAction, undoBulkSavesAction } = await import("../src/server/actions/saves");
    expect(await bulkSavesAction([cannon], { kind: "status", status: "visited" })).toMatchObject({ ok: false, code: "unauthenticated" });
    ctx.viewer = { id: maya };
    const res = await bulkSavesAction([cannon, meeple], { kind: "status", status: "visited" });
    expect(res).toMatchObject({ ok: true, data: { summary: "Marked 2 places as visited" } });
    expect(await undoBulkSavesAction(res.ok ? res.data.snapshots : [])).toEqual({ ok: true, data: undefined });
    expect((await ctx.repo.saves.get(maya, cannon))?.status).toBe("want_to_go");
    expect(await bulkSavesAction(["not-a-uuid"], { kind: "remove" })).toMatchObject({ ok: false, code: "invalid" });
  });

  it("export is owner only, in CSV and JSON, and contains only the viewer's own saves", async () => {
    const { GET } = await import("../src/app/saved/export/route");
    await ctx.repo.saves.update(maya, cannon, { note: SECRET });
    expect((await GET(new Request("http://x/saved/export"))).status).toBe(401);
    ctx.viewer = { id: theo };
    const theirs = await (await GET(new Request("http://x/saved/export?format=csv"))).text();
    expect(theirs).not.toContain(SECRET);
    ctx.viewer = { id: maya };
    const csv = await GET(new Request("http://x/saved/export?format=csv"));
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toMatch(/attachment; filename="findmaxxing-saves-.*\.csv"/);
    expect(csv.headers.get("cache-control")).toMatch(/no-store/);
    expect(await csv.text()).toContain(SECRET);
    const json = (await (await GET(new Request("http://x/saved/export?format=json"))).json()) as { saves: { name: string; note: string | null }[] };
    expect(json.saves.find((s) => s.name === "Cannon & Crown")?.note).toBe(SECRET);
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "pilotExplore");
    expect((await GET(new Request("http://x/saved/export"))).status).toBe(404);
  });

  it("the page shows the library with filters, keeps what the place is apart from why you saved it, and says when nothing matches", async () => {
    await ctx.repo.saves.update(maya, cannon, { note: SECRET, tags: ["wings"], status: "visited" });
    ctx.viewer = { id: maya };
    const html = await renderSaved();
    expect(html).toContain('data-block="library"');
    expect(html).toContain('href="/saved/export?format=csv"');
    const row = html.slice(html.indexOf(`data-library-row="${cannon}"`));
    expect(row.indexOf("Cannon &amp; Crown")).toBeLessThan(row.indexOf("data-why"));
    expect(row).toContain(SECRET);
    const none = await renderSaved({ q: "zzzz-nothing" });
    expect(none).toContain("No saves match these filters.");
    expect(none).toContain("Clear filters");
    const tagged = await renderSaved({ tag: "wings" });
    expect((tagged.match(/data-library-row=/g) ?? []).length).toBe(1);
  });

  it("500 saves stay fast: one page of 50 rows with Show more", async () => {
    const state = handle.state;
    const template = state.places.find((p) => p.id === cannon)!;
    const now = Date.now();
    for (let i = 0; i < 500; i++) {
      const id = `00000000-0000-4000-a000-${String(i).padStart(12, "0")}`;
      state.places.push({ ...template, id, name: `Bulk place ${i}` });
      state.savedPlaces.push({ userId: maya, placeId: id, createdAt: new Date(now - i * 1000).toISOString() });
    }
    ctx.viewer = { id: maya };
    const t0 = performance.now();
    const html = await renderSaved();
    const ms = performance.now() - t0;
    expect((html.match(/data-library-row=/g) ?? []).length).toBe(50);
    expect(html).toMatch(/Show more \(\d+ left\)/);
    expect(ms).toBeLessThan(3000);
    const page3 = await renderSaved({ page: "3" });
    expect((page3.match(/data-library-row=/g) ?? []).length).toBe(150);
  });

  it("with pilotLibrary off the saved page is today's page", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "pilotExplore");
    ctx.viewer = { id: maya };
    const html = await renderSaved();
    expect(html).not.toContain('data-block="library"');
    expect(html).toContain("All saved");
  });
});
