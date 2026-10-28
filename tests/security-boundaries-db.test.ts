import { beforeAll, afterAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import { isWebPushEndpoint } from "../src/lib/security/pushEndpoints";
import { readFileSync } from "node:fs";

const [a, b, unrelated] = ["maya_r", "theo", "jules"].map((name) => SEED_USERS.find((u) => u.username === name)!.id);
let db: PGlite;
beforeAll(async () => { db = await createSeededDb(); });
afterAll(async () => { await db?.close(); });

describe("database security boundaries", () => {
  it("does not reveal another pair's block status through public RPCs", async () => {
    await queryAs(db, a, "insert into public.blocks(blocker_id, blocked_id) values ($1,$2)", [a, b]);
    for (const fn of ["has_blocked", "is_blocked_between"]) {
      expect(await queryAs(db, unrelated, `select public.${fn}($1,$2) as blocked`, [a, b])).toEqual([{ blocked: false }]);
      expect(await queryAs(db, unrelated, `select public.${fn}($1,$2) as blocked`, [b, a])).toEqual([{ blocked: false }]);
      expect(await queryAs(db, a, `select public.${fn}($1,$2) as blocked`, [a, b])).toEqual([{ blocked: true }]);
      await expect(queryAs(db, null, `select public.${fn}($1,$2)`, [a, b])).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, unrelated, `select findmaxxing_private.${fn}($1,$2)`, [a, b])).rejects.toThrow(/permission denied/);
    }
    expect(await queryAs(db, b, "select public.is_blocked_between($1,$2) as blocked", [a, b])).toEqual([{ blocked: true }]);
    expect(await queryAs(db, unrelated, "select * from public.blocks where blocker_id=$1", [a])).toEqual([]);
  });
  it("preserves internal notification suppression when the caller is unrelated or absent", async () => {
    for (const caller of [unrelated, null]) {
      // Database-owner execution of trusted notify(), but a different JWT subject.
      await db.query("select set_config('request.jwt.claim.sub',$1,false)", [caller ?? ""]);
      try {
        await db.query("select public.notify($1,'new_follower',$2,'profile',$2,null)", [a, b]);
      } finally { await db.query("select set_config('request.jwt.claim.sub','',false)"); }
    }
    expect((await db.query("select count(*)::int as n from public.notifications where user_id=$1 and actor_id=$2", [a, b])).rows).toEqual([{ n: 0 }]);
    await db.query("select public.notify($1,'new_follower',$2,'profile',$2,null)", [a, unrelated]);
    expect((await db.query("select count(*)::int as n from public.notifications where user_id=$1 and actor_id=$2", [a, unrelated])).rows).toEqual([{ n: 1 }]);
  });
  it("blocks unsafe endpoints through authenticated direct RPCs and preserves other devices", async () => {
    const valid = "https://fcm.googleapis.com/fcm/send/existing";
    await queryAs(db, a, "select public.save_push_subscription($1,'k','a')", [valid]);
    for (const endpoint of ["https://127.0.0.1/a", "https://[::1]/a", "https://169.254.169.254/a", "https://user@fcm.googleapis.com/a", "https://fcm.googleapis.com:444/a", "https://fcm.googleapis.com.evil.test/a", "https://fcm.googleapis.com/a\\b", null]) {
      await expect(queryAs(db, a, "select public.save_push_subscription($1,'k','a')", [endpoint])).rejects.toThrow(/Invalid push subscription/);
    }
    expect(await queryAs(db, a, "select endpoint from public.push_subscriptions")).toEqual([{ endpoint: valid }]);
    await queryAs(db, a, "select public.save_expo_push_token('ExponentPushToken[audit-test]')");
    expect((await queryAs(db, a, "select kind from public.push_subscriptions order by kind"))).toEqual([{ kind: "expo" }, { kind: "web" }]);
  });
  it("matches application provider validation in SQL, including parser tricks", async () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/token", "https://fcm.googleapis.com:443/wp/token", "https://updates.push.services.mozilla.com/wpush/v2/token",
      "https://web.push.apple.com/Q/token", "https://region.web.push.apple.com/Q/token", "https://push.apple.com.evil.test/a", "https://evilpush.apple.com/a",
      "https://wns2-test.notify.windows.com/w/?token=token", "https://2130706433/a", "https://fcm.googleapis.com/a#frag",
      "https://fcm.googleapis.com/a\n", "https://fcm.googleapis.com/a\\b", "https://fcm.googleapis.com/", "https://fcm.googleapis.com/a" + "a".repeat(1000),
    ]) {
      const [row] = await queryAs<{ ok: boolean }>(db, a, "select public.is_web_push_endpoint($1) as ok", [endpoint]);
      expect(row.ok, endpoint).toBe(isWebPushEndpoint(endpoint));
    }
  });
  it("also enforces the constraint on trusted inserts", async () => {
    await expect(db.query("insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) values ($1,'https://10.1.2.3/a','k','a')", [a])).rejects.toThrow(/push_subscriptions_provider_check/);
  });
  it("upgrades legacy subscriptions without deleting them, while refusing new unsafe rows", async () => {
    await db.exec("alter table public.push_subscriptions drop constraint push_subscriptions_provider_check");
    await db.query("insert into public.push_subscriptions(user_id,endpoint,p256dh,auth) values ($1,'https://old-provider.test/token','k','a')", [a]);
    await db.exec(readFileSync(new URL("../supabase/migrations/0026_security_boundaries.sql", import.meta.url), "utf8"));
    expect((await db.query("select endpoint from public.push_subscriptions where endpoint like '%old-provider%'")).rows).toEqual([{ endpoint: "https://old-provider.test/token" }]);
    await expect(queryAs(db, a, "select public.save_push_subscription('https://old-provider.test/new','k','a')")).rejects.toThrow(/Invalid push subscription/);
  });
});
