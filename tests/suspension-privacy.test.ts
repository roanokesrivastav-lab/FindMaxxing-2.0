import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";

const user = (name: string) => SEED_USERS.find((u) => u.username === name)!.id;
const [admin, maya, nina] = ["dev", "maya_r", "nina"].map(user);

describe("private suspension status", () => {
  let db: PGlite;
  const demo = createDemoRepository(createIsolatedStore());
  beforeAll(async () => {
    db = await createSeededDb();
    await queryAs(db, admin, "select public.admin_set_suspended($1, true, 'Privacy regression')", [nina]);
    await demo.admin.setSuspended(admin, nina, true, "Privacy regression");
  });
  afterAll(async () => { await db?.close(); });

  it("returns self status and masks other users, including for admins, with demo parity", async () => {
    for (const [target, viewer, expected] of [
      [nina, nina, true], [maya, maya, false], [nina, maya, false],
      [maya, nina, false], [nina, admin, false],
    ] as const) {
      const rows = await queryAs<{ suspended: boolean }>(db, viewer,
        "select public.is_suspended($1) as suspended", [target]);
      expect(rows).toEqual([{ suspended: expected }]);
      expect(await demo.admin.isSuspended(target, viewer)).toBe(expected);
    }
    await expect(queryAs(db, null, "select public.is_suspended($1)", [nina])).rejects.toThrow(/permission denied/);
    expect(await demo.admin.isSuspended(nina, null)).toBe(false);
  });

  it("preserves admin-only moderation listings and service-role lookup without a user subject", async () => {
    expect(await queryAs(db, maya, "select id from public.admin_users('nina')")).toEqual([]);
    expect(await queryAs(db, admin, "select id, suspended from public.admin_users('nina')")).toEqual([{ id: nina, suspended: true }]);
    expect((await demo.admin.users(admin, { query: "nina" })).items).toEqual([
      expect.objectContaining({ id: nina, suspended: true }),
    ]);
    await db.exec("set role service_role;");
    try {
      expect((await db.query("select public.is_suspended($1) as suspended", [nina])).rows).toEqual([{ suspended: true }]);
    } finally { await db.exec("reset role;"); }
  });

  it.each([
    ["upload quota", "select public.count_upload('avatars', $1::text || '/test.webp')"],
    ["ticket reservation", "select public.reserve_ticket($1::uuid)"],
    ["event pricing", "select public.set_event_price($1::uuid, 100)"],
    ["messaging", "select public.start_direct($1::uuid)"],
    ["trip quota", "select public.consume_trip_plan() where $1::uuid is not null"],
    ["campaign creation", "select public.create_ad_campaign('place', $1::uuid, 'Test ad', null, null, null, null, null, null, now(), now() + interval '1 day', 2000)"],
    ["ordinary writes", "update public.profiles set bio = 'blocked' where id = $1::uuid"],
  ])("still blocks suspended %s through real SQL entry points", async (_label, sql) => {
    await expect(queryAs(db, nina, sql, [nina])).rejects.toThrow(/account_suspended/);
  });

  it("keeps admin unsuspension functional and self status current", async () => {
    await queryAs(db, admin, "select public.admin_set_suspended($1, false, 'Appeal')", [nina]);
    await demo.admin.setSuspended(admin, nina, false, "Appeal");
    expect(await queryAs(db, nina, "select public.is_suspended($1) as suspended", [nina])).toEqual([{ suspended: false }]);
    expect(await demo.admin.isSuspended(nina, nina)).toBe(false);
    await queryAs(db, nina, "update public.profiles set bio = 'allowed' where id = $1", [nina]);
  });
});
