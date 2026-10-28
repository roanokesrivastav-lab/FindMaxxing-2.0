import { afterAll, beforeAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
let db: PGlite;
beforeAll(async () => { db = await createSeededDb(); }); afterAll(async () => { await db?.close(); });
async function person() {
  const id = crypto.randomUUID();
  await db.query("insert into auth.users(id,email,raw_user_meta_data) values($1,$2,$3)", [id, `${id}@example.test`, JSON.stringify({ username: `p_${id.slice(0, 8)}`, display_name: "Push test" })]);
  return id;
}
async function device(id: string, kind: "web" | "expo") {
  const endpoint = kind === "expo" ? `ExponentPushToken[${id}]` : `https://fcm.googleapis.com/fcm/send/${id}`;
  await db.query("insert into public.push_subscriptions(user_id,kind,endpoint,p256dh,auth) values($1,$2,$3,$4,$5)", [id, kind, endpoint, kind === "web" ? "key" : null, kind === "web" ? "auth" : null]);
}
async function notification(id: string, age = 0) {
  return (await db.query<{ id: string }>("insert into public.notifications(user_id,type,push_state,created_at) values($1,'new_follower','pending',now()-($2::int*interval '1 minute')) returning id", [id, age])).rows[0].id;
}
const claims = async (kinds: string[], limit = 100, cap = 5) => (await db.query<{ notification_id: string; devices: { kind: string }[] }>("select * from public.claim_transport_push_batch(now(),$1,$2,$3)", [limit, cap, kinds])).rows;
it("the transport RPC and claim markers cannot be controlled by ordinary API callers", async () => {
  const id = await person();
  for (const who of [id, null]) await expect(queryAs(db, who, "select * from public.claim_transport_push_batch()")).rejects.toThrow(/permission denied/);
  await expect(queryAs(db, id, "update public.notifications set push_claimed_kinds=array['web'] where user_id=auth.uid()")).rejects.toThrow(/permission denied/);
  await expect(claims(["unknown"])).rejects.toThrow(/Unknown push transport/);
  expect(await claims([])).toEqual([]);
});
it("partial readiness preserves mixed-channel work, sends each kind once and charges the daily cap once", async () => {
  const id = await person(); await device(id, "web"); await device(id, "expo"); const n = await notification(id);
  expect((await claims(["expo"], 100, 1)).find((c) => c.notification_id === n)?.devices.map((d) => d.kind)).toEqual(["expo"]);
  expect((await db.query("select push_state,push_claimed_kinds from public.notifications where id=$1", [n])).rows).toEqual([{ push_state: "pending", push_claimed_kinds: ["expo"] }]);
  expect((await claims(["expo"])).some((c) => c.notification_id === n)).toBe(false);
  // Another notification is capped, but the remaining channel of the first is not.
  const capped = await notification(id); await claims(["expo"], 100, 1);
  expect((await db.query("select push_state from public.notifications where id=$1", [capped])).rows).toEqual([{ push_state: "capped" }]);
  expect((await claims(["web"], 100, 1)).find((c) => c.notification_id === n)?.devices.map((d) => d.kind)).toEqual(["web"]);
  expect((await db.query("select push_state from public.notifications where id=$1", [n])).rows).toEqual([{ push_state: "sent" }]);
  expect((await db.query("select count(*)::int as count from public.push_log where notification_id=$1", [n])).rows).toEqual([{ count: 1 }]);
  expect((await claims(["web", "expo"])).some((c) => c.notification_id === n)).toBe(false);
});
it("unsendable oldest entries do not starve a sendable entry behind the batch limit", async () => {
  const browser = await person(), phone = await person(); await device(browser, "web"); await device(phone, "expo");
  const blocked = await notification(browser, 2), ready = await notification(phone);
  expect((await claims(["expo"], 1)).map((c) => c.notification_id)).toEqual([ready]);
  expect((await db.query("select push_state from public.notifications where id=$1", [blocked])).rows).toEqual([{ push_state: "pending" }]);
});
it("quiet hours and notification expiry still apply to ready-only claims", async () => {
  const id = await person(); await device(id, "expo");
  const expired = await notification(id, 1500), quiet = await notification(id);
  const hour = (await db.query<{ hour: number }>("select extract(hour from now() at time zone 'UTC')::int as hour")).rows[0].hour;
  await db.query("insert into public.notification_settings(user_id,quiet_start,quiet_end,time_zone) values($1,$2,$3,'UTC')", [id, hour, (hour + 1) % 24]);
  expect((await claims(["expo"])).some((c) => c.notification_id === quiet)).toBe(false);
  expect((await db.query("select push_state from public.notifications where id=$1", [quiet])).rows).toEqual([{ push_state: "pending" }]);
  expect((await db.query("select push_state from public.notifications where id=$1", [expired])).rows).toEqual([{ push_state: "skipped" }]);
});
