/**
 * The saved-list server actions, against a real (isolated) demo repository:
 * auth and input checks, where errors land, and which pages they refresh.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const maya = SEED_USERS.find((u) => u.username === "maya_r")!.id;
const theo = SEED_USERS.find((u) => u.username === "theo")!.id;
const tuttle = stableId("place:Tuttle Lot Fields");
const cannon = stableId("place:Cannon & Crown");

const ctx: { viewer: string | null; repo: DataRepository } = { viewer: maya, repo: createDemoRepository(createIsolatedStore()) };
const revalidatePath = vi.fn();
vi.mock("next/cache", () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (ctx.viewer ? { id: ctx.viewer } : null) }));
vi.mock("@/lib/data", () => ({ getRepository: async () => ctx.repo }));

const { createListAction, renameListAction, deleteListAction, setListMembershipAction } = await import("../src/server/actions/lists");
const { toggleSaveAction } = await import("../src/server/actions/places");

beforeEach(() => {
  ctx.viewer = maya;
  ctx.repo = createDemoRepository(createIsolatedStore());
  revalidatePath.mockClear();
});

const saved = async (placeId: string) => (await ctx.repo.places.listSaved(maya)).some((p) => p.id === placeId);

describe("saved-list actions", () => {
  it("require a signed-in viewer", async () => {
    ctx.viewer = null;
    expect(await createListAction("Date night")).toMatchObject({ ok: false, code: "unauthenticated" });
    expect(await setListMembershipAction(stableId("x"), tuttle, true)).toMatchObject({ ok: false, code: "unauthenticated" });
  });

  it("create a list and put the place in it, saving the place on the way", async () => {
    expect(await saved(tuttle)).toBe(false);
    const res = await createListAction("  Pickup   spots ", tuttle);
    expect(res).toMatchObject({ ok: true, data: { list: { name: "Pickup spots", placeCount: 1 } } });
    expect(await saved(tuttle)).toBe(true);
    // Every page under /saved, and the place's own page.
    expect(revalidatePath).toHaveBeenCalledWith("/saved", "layout");
    expect(revalidatePath).toHaveBeenCalledWith(`/places/${tuttle}`);
  });

  it("put name problems on the name field", async () => {
    await createListAction("Coffee");
    expect(await createListAction("coffee")).toMatchObject({ ok: false, fieldErrors: { name: "You already have a list called “coffee”" } });
    expect(await createListAction(" \t ")).toMatchObject({ ok: false, fieldErrors: { name: "Give the list a name" } });
    const other = await createListAction("Tea");
    if (!other.ok) throw new Error("setup");
    expect(await renameListAction(other.data.list.id, "COFFEE")).toMatchObject({ ok: false, fieldErrors: { name: expect.stringContaining("already have") } });
  });

  it("refuse malformed ids before touching data", async () => {
    expect(await createListAction("Ok", "not-a-uuid")).toMatchObject({ ok: false, error: "Invalid place" });
    expect(await renameListAction("nope", "x")).toMatchObject({ ok: false, error: "Invalid list" });
    expect(await setListMembershipAction("nope", tuttle, true)).toMatchObject({ ok: false });
    expect(await ctx.repo.savedLists.list(maya)).toEqual([]);
  });

  it("treat another user's list as not found", async () => {
    const mine = await createListAction("Mine", cannon);
    if (!mine.ok) throw new Error("setup");
    ctx.viewer = theo;
    expect(await renameListAction(mine.data.list.id, "Theirs")).toMatchObject({ ok: false, code: "not_found" });
    expect(await deleteListAction(mine.data.list.id)).toMatchObject({ ok: false, code: "not_found" });
    expect(await setListMembershipAction(mine.data.list.id, cannon, false)).toMatchObject({ ok: false, code: "not_found" });
    ctx.viewer = maya;
    expect((await ctx.repo.savedLists.get(maya, mine.data.list.id))?.places.map((p) => p.id)).toEqual([cannon]);
  });

  it("take a place out of one list without unsaving it, and delete lists without unsaving", async () => {
    const a = await createListAction("A", cannon);
    const b = await createListAction("B", cannon);
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(await setListMembershipAction(a.data.list.id, cannon, false)).toMatchObject({ ok: true });
    expect(await ctx.repo.savedLists.memberships(maya, cannon)).toEqual([b.data.list.id]);
    expect(await deleteListAction(b.data.list.id)).toMatchObject({ ok: true });
    expect(await saved(cannon)).toBe(true);
  });

  it("unsaving removes the place from every list and refreshes the list pages", async () => {
    const a = await createListAction("A", cannon);
    const b = await createListAction("B", cannon);
    if (!a.ok || !b.ok) throw new Error("setup");
    revalidatePath.mockClear();
    expect(await toggleSaveAction(cannon, false)).toMatchObject({ ok: true });
    expect(await ctx.repo.savedLists.memberships(maya, cannon)).toEqual([]);
    expect(revalidatePath).toHaveBeenCalledWith("/saved", "layout");
  });
});
