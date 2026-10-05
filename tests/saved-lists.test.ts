/**
 * Saved lists (Session 6). saved_places stays the bookmark; lists organize it.
 * The database tests run as the signed-in user, the way PostgREST would, so
 * they prove what RLS and the foreign keys refuse; the demo tests hold the
 * demo repository to the same rules; the parity test runs one sequence through
 * both and compares what each reports.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_SAVES, SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { createIsolatedStore, migrateDemoState, STATE_VERSION } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { MAX_SAVED_LISTS, normalizeListName } from "../src/lib/data/savedLists";
import { DataError } from "../src/lib/data/types";
import type { DataRepository } from "../src/lib/data/repository";

const user = (username: string) => SEED_USERS.find((u) => u.username === username)!.id;
const maya = user("maya_r");
const theo = user("theo");
const nina = user("nina"); // not a Columbus local
const place = (name: string) => stableId(`place:${name}`);
const cannon = place("Cannon & Crown"); // saved by maya
const meeple = place("Meeple Cellar"); // saved by maya and theo
const tuttle = place("Tuttle Lot Fields"); // public, not saved by maya
const basement = place("Fourth Street Basement"); // locals-only

async function expectDbError(p: Promise<unknown>, pattern: RegExp) {
  await expect(p).rejects.toThrow(pattern);
}

// ----------------------------------------------------------------------------
// Database
// ----------------------------------------------------------------------------
describe("saved lists in the database", () => {
  let db: PGlite;
  const as = <T>(userId: string | null, sql: string, params: unknown[] = []) => queryAs<T>(db, userId, sql, params);
  const newList = async (owner: string, name: string) =>
    (await as<{ id: string }>(owner, "insert into public.saved_lists (owner_id, name) values ($1, $2) returning id", [owner, name]))[0].id;
  const items = (listId: string) =>
    db.query<{ place_id: string }>("select place_id from public.saved_list_items where list_id = $1 order by place_id", [listId]).then((r) => r.rows.map((x) => x.place_id));
  const saved = (owner: string, placeId: string) =>
    db.query("select 1 from public.saved_places where user_id = $1 and place_id = $2", [owner, placeId]).then((r) => r.rows.length === 1);

  beforeAll(async () => {
    db = await createSeededDb();
  });

  it("keeps every existing bookmark and save total intact", async () => {
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from public.saved_places");
    expect(rows[0].n).toBe(SEED_SAVES.length);
    const totals = await db.query<{ place_id: string; save_count: number; actual: number }>(
      `select p.id as place_id, p.save_count, (select count(*)::int from public.saved_places s where s.place_id = p.id) as actual
       from public.places p`,
    );
    for (const row of totals.rows) expect(row.save_count).toBe(row.actual);
    // Bookmarks start in no list.
    expect((await db.query("select 1 from public.saved_list_items")).rows).toHaveLength(0);
  });

  it("lets an owner organize a bookmark into several lists, and keep others in none", async () => {
    const date = await newList(maya, "Date night");
    const rainy = await newList(maya, "Rainy day");
    await as(maya, "select public.add_to_saved_list($1, $2)", [date, cannon]);
    await as(maya, "select public.add_to_saved_list($1, $2)", [rainy, cannon]);
    await as(maya, "select public.add_to_saved_list($1, $2)", [rainy, meeple]);
    // Idempotent.
    await as(maya, "select public.add_to_saved_list($1, $2)", [rainy, meeple]);
    expect(await items(date)).toEqual([cannon]);
    expect(await items(rainy)).toEqual([cannon, meeple].sort());
    expect(await saved(maya, place("Boulder & Bramble"))).toBe(true); // still saved, in no list
  });

  it("bookmarks a place when adding it to a list", async () => {
    const list = await newList(maya, "Pickup spots");
    expect(await saved(maya, tuttle)).toBe(false);
    await as(maya, "select public.add_to_saved_list($1, $2)", [list, tuttle]);
    expect(await saved(maya, tuttle)).toBe(true);
    expect(await items(list)).toEqual([tuttle]);
  });

  describe("cross-user access fails", () => {
    let mayaList: string;
    beforeAll(async () => {
      mayaList = await newList(maya, "Private picks");
      await as(maya, "select public.add_to_saved_list($1, $2)", [mayaList, meeple]);
    });

    it("hides another user's lists and items", async () => {
      expect(await as(theo, "select * from public.saved_lists where id = $1", [mayaList])).toHaveLength(0);
      expect(await as(theo, "select * from public.saved_list_items where list_id = $1", [mayaList])).toHaveLength(0);
      expect(await as(null, "select * from public.saved_lists")).toHaveLength(0);
      expect((await as<{ id: string }>(theo, "select id from public.saved_list_summaries()")).map((r) => r.id)).not.toContain(mayaList);
    });

    it("refuses creating a list for someone else", async () => {
      await expectDbError(as(theo, "insert into public.saved_lists (owner_id, name) values ($1, 'Mine now')", [maya]), /row-level security/);
    });

    it("refuses renaming, re-owning or deleting another user's list", async () => {
      await as(theo, "update public.saved_lists set name = 'Hijacked' where id = $1", [mayaList]);
      await as(theo, "delete from public.saved_lists where id = $1", [mayaList]);
      const { rows } = await db.query<{ name: string }>("select name from public.saved_lists where id = $1", [mayaList]);
      expect(rows).toEqual([{ name: "Private picks" }]);
      // Even the owner cannot hand a list to someone else.
      await expectDbError(as(maya, "update public.saved_lists set owner_id = $2 where id = $1", [mayaList, theo]), /row-level security|Only a list's name/);
    });

    it("refuses putting anything in another user's list, even the intruder's own bookmark", async () => {
      // theo has saved Meeple Cellar himself.
      await expectDbError(as(theo, "select public.add_to_saved_list($1, $2)", [mayaList, meeple]), /List not found/);
      // Straight at the table, with a bookmark theo does have: with his own
      // owner_id the list key does not match; with maya's, RLS refuses.
      const dumpling = place("Little Alley Dumpling");
      await expectDbError(
        as(theo, "insert into public.saved_list_items (list_id, owner_id, place_id) values ($1, $2, $3)", [mayaList, theo, dumpling]),
        /foreign key/,
      );
      await expectDbError(
        as(theo, "insert into public.saved_list_items (list_id, owner_id, place_id) values ($1, $2, $3)", [mayaList, maya, dumpling]),
        /row-level security/,
      );
      expect(await items(mayaList)).toEqual([meeple]);
    });

    it("refuses removing another user's items", async () => {
      await as(theo, "delete from public.saved_list_items where list_id = $1", [mayaList]);
      expect(await items(mayaList)).toEqual([meeple]);
    });
  });

  describe("orphan items fail", () => {
    it("refuses an item for a place its owner has not saved", async () => {
      const list = await newList(maya, "Orphans");
      await expectDbError(
        as(maya, "insert into public.saved_list_items (list_id, owner_id, place_id) values ($1, $2, $3)", [list, maya, place("Grange Night Market")]),
        /foreign key/,
      );
    });

    it("refuses an item in a list that does not exist", async () => {
      await expectDbError(
        as(maya, "insert into public.saved_list_items (list_id, owner_id, place_id) values (gen_random_uuid(), $1, $2)", [maya, cannon]),
        /foreign key/,
      );
      await expectDbError(as(maya, "select public.add_to_saved_list(gen_random_uuid(), $1)", [cannon]), /List not found/);
    });

    it("refuses a place the owner cannot see, like saving does", async () => {
      const list = await newList(nina, "Travel");
      await expectDbError(as(nina, "select public.add_to_saved_list($1, $2)", [list, basement]), /row-level security/);
      expect(await saved(nina, basement)).toBe(false);
    });

    it("removes a place from every list when it is unsaved", async () => {
      const a = await newList(theo, "Game nights");
      const b = await newList(theo, "Weekends");
      await as(theo, "select public.add_to_saved_list($1, $2)", [a, meeple]);
      await as(theo, "select public.add_to_saved_list($1, $2)", [b, meeple]);
      await as(theo, "delete from public.saved_places where user_id = $1 and place_id = $2", [theo, meeple]);
      expect(await items(a)).toEqual([]);
      expect(await items(b)).toEqual([]);
      // The lists themselves stay.
      expect((await as(theo, "select id from public.saved_lists where id = any($1)", [[a, b]])).length).toBe(2);
    });

    it("keeps the bookmarks when a list is deleted", async () => {
      const list = await newList(maya, "Temporary");
      await as(maya, "select public.add_to_saved_list($1, $2)", [list, cannon]);
      await as(maya, "delete from public.saved_lists where id = $1", [list]);
      expect(await items(list)).toEqual([]);
      expect(await saved(maya, cannon)).toBe(true);
    });

    it("drops items when their place is deleted", async () => {
      const lena = user("lena");
      const list = await newList(lena, "Sunsets");
      const steps = place("Brickyard Sunset Steps");
      await as(lena, "select public.add_to_saved_list($1, $2)", [list, steps]);
      await db.query("delete from public.places where id = $1", [steps]);
      expect(await items(list)).toEqual([]);
    });
  });

  describe("uniqueness and limits", () => {
    it("allows a place only once per list", async () => {
      const list = await newList(maya, "Once");
      await as(maya, "select public.add_to_saved_list($1, $2)", [list, cannon]);
      await expectDbError(
        as(maya, "insert into public.saved_list_items (list_id, owner_id, place_id) values ($1, $2, $3)", [list, maya, cannon]),
        /duplicate key/,
      );
    });

    it("makes names unique per owner, ignoring case and surrounding spaces, but not across owners", async () => {
      await newList(maya, "Coffee");
      await expectDbError(newList(maya, "  coffee "), /duplicate key/);
      await expect(newList(theo, "Coffee")).resolves.toBeTruthy();
    });

    it("refuses blank and over-long names", async () => {
      await expectDbError(newList(maya, "   "), /check constraint/);
      await expectDbError(newList(maya, "\t\n"), /check constraint/);
      await expectDbError(newList(maya, "\u00a0\u3000"), /check constraint/);
      await expectDbError(newList(maya, "x".repeat(61)), /check constraint/);
    });

    it("normalizes names exactly as the application does", async () => {
      const samples = [
        "Coffee shop", "  Coffee   shop ", "Coffee\tshop", "Coffee\n\nshop", "Late\u00a0night", "Ideographic\u3000space",
        "Zero\ufeffwidth", "Tabs\v\fand\rfeeds", "x".repeat(60) + "  ", " ", "\t\n", "x".repeat(61), "ok",
      ];
      const { rows } = await db.query<{ raw: string; normalized: string }>(
        "select raw, public.normalize_list_name(raw) as normalized from unnest($1::text[]) as raw",
        [samples],
      );
      for (const { raw, normalized } of rows) {
        let app: string | null;
        try {
          app = normalizeListName(raw);
        } catch {
          app = null;
        }
        const sqlAccepts = normalized.length >= 1 && normalized.length <= 60;
        expect(sqlAccepts ? normalized : null, JSON.stringify(raw)).toBe(app);
      }
    });

    it("stores the normalized name and treats spacing variants as duplicates", async () => {
      const id = await newList(theo, "  Coffee\t shop ");
      const { rows } = await db.query<{ name: string }>("select name from public.saved_lists where id = $1", [id]);
      expect(rows[0].name).toBe("Coffee shop");
      await expectDbError(newList(theo, "Coffee  shop"), /duplicate key/);
      await expectDbError(newList(theo, "coffee\nSHOP"), /duplicate key/);
      // Renames are normalized too.
      const other = await newList(theo, "Tea");
      await as(theo, "update public.saved_lists set name = $2 where id = $1", [other, "  Green\t\ttea "]);
      const renamed = await db.query<{ name: string }>("select name from public.saved_lists where id = $1", [other]);
      expect(renamed.rows[0].name).toBe("Green tea");
    });

    it("caps how many lists one owner can have", async () => {
      const priya = user("priya");
      await db.query(
        "insert into public.saved_lists (owner_id, name) select $1, 'List ' || n from generate_series(1, $2) as n",
        [priya, MAX_SAVED_LISTS],
      );
      await expectDbError(newList(priya, "One too many"), /at most 100 lists/);
    });

    it("summarizes the caller's lists, counting only places they can open", async () => {
      const list = await newList(user("jules"), "Summary check");
      await as(user("jules"), "select public.add_to_saved_list($1, $2)", [list, basement]);
      await as(user("jules"), "select public.add_to_saved_list($1, $2)", [list, tuttle]);
      const summary = async () =>
        (await as<{ id: string; place_count: number }>(user("jules"), "select id, place_count from public.saved_list_summaries()")).find((r) => r.id === list);
      expect((await summary())?.place_count).toBe(2);
      // Hidden by its owner (dev): no longer counted for jules.
      await db.query("update public.places set status = 'hidden' where id = $1", [basement]);
      expect((await summary())?.place_count).toBe(1);
      await db.query("update public.places set status = 'published' where id = $1", [basement]);
    });
  });
});

// ----------------------------------------------------------------------------
// Demo repository
// ----------------------------------------------------------------------------
describe("saved lists in demo mode", () => {
  let repo: DataRepository;
  beforeEach(() => {
    repo = createDemoRepository(createIsolatedStore());
  });

  const code = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (err) {
      expect(err).toBeInstanceOf(DataError);
      return (err as DataError).code;
    }
    return "ok";
  };

  it("organizes bookmarks into lists without changing what is saved", async () => {
    const before = (await repo.places.listSaved(maya)).map((p) => p.id);
    const date = await repo.savedLists.create(maya, "  Date   night ");
    expect(date.name).toBe("Date night");
    await repo.savedLists.addPlace(maya, date.id, cannon);
    const rainy = await repo.savedLists.create(maya, "Rainy day");
    await repo.savedLists.addPlace(maya, rainy.id, cannon);
    expect((await repo.savedLists.memberships(maya, cannon)).sort()).toEqual([date.id, rainy.id].sort());
    expect((await repo.places.listSaved(maya)).map((p) => p.id)).toEqual(before);
    expect((await repo.savedLists.get(maya, date.id))?.places.map((p) => p.id)).toEqual([cannon]);
  });

  it("bookmarks a place when adding it, and unsaving removes it from every list", async () => {
    const list = await repo.savedLists.create(maya, "Pickup");
    await repo.savedLists.addPlace(maya, list.id, tuttle);
    expect((await repo.places.listSaved(maya)).some((p) => p.id === tuttle)).toBe(true);
    await repo.places.unsave(maya, tuttle);
    expect(await repo.savedLists.memberships(maya, tuttle)).toEqual([]);
    expect((await repo.savedLists.get(maya, list.id))?.places).toEqual([]);
  });

  it("keeps bookmarks when a list is deleted", async () => {
    const list = await repo.savedLists.create(maya, "Temp");
    await repo.savedLists.addPlace(maya, list.id, cannon);
    await repo.savedLists.delete(maya, list.id);
    expect(await repo.savedLists.get(maya, list.id)).toBeNull();
    expect((await repo.places.listSaved(maya)).some((p) => p.id === cannon)).toBe(true);
  });

  it("treats another user's list as not found for every operation", async () => {
    const list = await repo.savedLists.create(maya, "Mine");
    await repo.savedLists.addPlace(maya, list.id, meeple);
    expect(await repo.savedLists.get(theo, list.id)).toBeNull();
    expect(await code(repo.savedLists.rename(theo, list.id, "Theirs"))).toBe("not_found");
    expect(await code(repo.savedLists.delete(theo, list.id))).toBe("not_found");
    expect(await code(repo.savedLists.addPlace(theo, list.id, meeple))).toBe("not_found");
    expect(await code(repo.savedLists.removePlace(theo, list.id, meeple))).toBe("not_found");
    expect((await repo.savedLists.list(theo)).map((l) => l.id)).not.toContain(list.id);
    expect((await repo.savedLists.get(maya, list.id))?.places.map((p) => p.id)).toEqual([meeple]);
  });

  it("refuses places the owner cannot see", async () => {
    const list = await repo.savedLists.create(nina, "Travel");
    expect(await code(repo.savedLists.addPlace(nina, list.id, basement))).toBe("not_found");
    expect((await repo.places.listSaved(nina)).some((p) => p.id === basement)).toBe(false);
  });

  it("enforces unique names, valid names and the list cap", async () => {
    await repo.savedLists.create(maya, "Coffee");
    expect(await code(repo.savedLists.create(maya, " COFFEE "))).toBe("conflict");
    expect(await code(repo.savedLists.create(theo, "Coffee"))).toBe("ok");
    expect(await code(repo.savedLists.create(maya, "   "))).toBe("invalid");
    expect(await code(repo.savedLists.create(maya, "x".repeat(61)))).toBe("invalid");
    const other = await repo.savedLists.create(maya, "Tea");
    expect(await code(repo.savedLists.rename(maya, other.id, "coffee"))).toBe("conflict");
    expect(await code(repo.savedLists.rename(maya, other.id, "TEA"))).toBe("ok"); // its own name, recased
    for (let i = (await repo.savedLists.list(maya)).length; i < MAX_SAVED_LISTS; i++) await repo.savedLists.create(maya, `List ${i}`);
    expect(await code(repo.savedLists.create(maya, "One too many"))).toBe("full");
  });

  it("normalizes names the way the database checks them", () => {
    expect(normalizeListName("  Late \n  night  ")).toBe("Late night");
    expect(() => normalizeListName("")).toThrow(DataError);
  });
});

describe("demo store upgrade", () => {
  it("carries a v2 store forward with every bookmark intact and no lists", () => {
    const fresh = createIsolatedStore().state;
    const v2 = JSON.parse(JSON.stringify(fresh)) as Record<string, unknown>;
    v2.version = 2;
    delete v2.savedLists;
    delete v2.savedListItems;
    const result = migrateDemoState(v2);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(2);
    expect(result.state.version).toBe(STATE_VERSION);
    expect(result.state.savedPlaces).toEqual(fresh.savedPlaces);
    expect(result.state.savedLists).toEqual([]);
    expect(result.state.savedListItems).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Parity: one sequence through SQL and demo, compared step by step.
// ----------------------------------------------------------------------------
describe("SQL and demo agree", () => {
  it("reports the same lists, counts, contents and memberships", async () => {
    const db = await createSeededDb();
    const repo = createDemoRepository(createIsolatedStore());
    const sqlIds = new Map<string, string>();
    const demoIds = new Map<string, string>();

    type Step =
      | ["create", string]
      | ["add", string, string]
      | ["remove", string, string]
      | ["unsave", string]
      | ["rename", string, string]
      | ["delete", string];
    const steps: Step[] = [
      ["create", "Date night"],
      ["create", "Rainy day"],
      ["add", "Date night", cannon],
      ["add", "Rainy day", cannon],
      ["add", "Rainy day", meeple],
      ["add", "Rainy day", tuttle], // not yet saved: bookmarked on the way in
      ["add", "Date night", place("Ridgeline Loop")], // locals-only, maya is a local
      ["remove", "Rainy day", meeple],
      ["unsave", cannon],
      ["rename", "Rainy day", "Rainy days"],
      ["create", "Empty"],
      ["delete", "Empty"],
    ];

    const snapshot = async () => {
      const sql = await queryAs<{ id: string; name: string; place_count: number }>(db, maya, "select id, name, place_count from public.saved_list_summaries()");
      const demo = await repo.savedLists.list(maya);
      const byName = (rows: { name: string; count: number; id: string }[], ids: Map<string, string>) =>
        rows.map((r) => ({ name: r.name, count: r.count, key: [...ids.entries()].find(([, id]) => id === r.id)?.[0] })).sort((a, b) => a.name.localeCompare(b.name));
      const sqlItems = await db.query<{ list_id: string; place_id: string }>("select list_id, place_id from public.saved_list_items where owner_id = $1", [maya]);
      const sqlSaved = await db.query<{ place_id: string }>("select place_id from public.saved_places where user_id = $1 order by place_id", [maya]);
      const demoSaved = (await repo.places.listSaved(maya)).map((p) => p.id).sort();
      const members = (rows: { list: string; place: string }[], ids: Map<string, string>) =>
        rows.map((r) => `${[...ids.entries()].find(([, id]) => id === r.list)?.[0]}:${r.place}`).sort();
      const demoItems: { list: string; place: string }[] = [];
      for (const l of demo) for (const p of (await repo.savedLists.get(maya, l.id))!.places) demoItems.push({ list: l.id, place: p.id });
      return {
        sql: {
          lists: byName(sql.map((r) => ({ name: r.name, count: r.place_count, id: r.id })), sqlIds),
          items: members(sqlItems.rows.map((r) => ({ list: r.list_id, place: r.place_id })), sqlIds),
          saved: sqlSaved.rows.map((r) => r.place_id),
        },
        demo: {
          lists: byName(demo.map((l) => ({ name: l.name, count: l.placeCount, id: l.id })), demoIds),
          items: members(demoItems, demoIds),
          saved: demoSaved,
        },
      };
    };

    for (const step of steps) {
      const [op] = step;
      if (op === "create") {
        const [id] = await queryAs<{ id: string }>(db, maya, "insert into public.saved_lists (owner_id, name) values ($1, $2) returning id", [maya, step[1]]);
        sqlIds.set(step[1], id.id);
        demoIds.set(step[1], (await repo.savedLists.create(maya, step[1])).id);
      } else if (op === "add") {
        await queryAs(db, maya, "select public.add_to_saved_list($1, $2)", [sqlIds.get(step[1]), step[2]]);
        await repo.savedLists.addPlace(maya, demoIds.get(step[1])!, step[2]);
      } else if (op === "remove") {
        await queryAs(db, maya, "delete from public.saved_list_items where list_id = $1 and place_id = $2", [sqlIds.get(step[1]), step[2]]);
        await repo.savedLists.removePlace(maya, demoIds.get(step[1])!, step[2]);
      } else if (op === "unsave") {
        await queryAs(db, maya, "delete from public.saved_places where user_id = $1 and place_id = $2", [maya, step[1]]);
        await repo.places.unsave(maya, step[1]);
      } else if (op === "rename") {
        await queryAs(db, maya, "update public.saved_lists set name = $2 where id = $1", [sqlIds.get(step[1]), step[2]]);
        await repo.savedLists.rename(maya, demoIds.get(step[1])!, step[2]);
      } else {
        await queryAs(db, maya, "delete from public.saved_lists where id = $1", [sqlIds.get(step[1])]);
        await repo.savedLists.delete(maya, demoIds.get(step[1])!);
      }
      const { sql, demo } = await snapshot();
      expect(demo, `after ${step.join(" ")}`).toEqual(sql);
    }
  });
});
