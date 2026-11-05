import { afterAll, beforeAll, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import type { StripeEventClaim } from "../src/lib/data/repository";
let db: PGlite;
const member = SEED_USERS.find((u) => u.username === "theo")!.id;
beforeAll(async () => { db = await createSeededDb(); }); afterAll(async () => { await db?.close(); });
async function claim(id: string, who: string | null = member) {
  return (await db.query<{ c: StripeEventClaim }>("select public.claim_stripe_event($1,'customer.subscription.updated','sub_db',$2) as c", [id, who])).rows[0].c;
}
it("event locks and RPCs remain service-only", async () => {
  for (const who of [member, null]) {
    await expect(queryAs(db, who, "select * from public.stripe_processing_locks")).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, who, "select public.claim_stripe_event('probe','type','object',$1)", [member])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, who, "select public.finish_stripe_event('probe',$1,'done',null)", [crypto.randomUUID()])).rejects.toThrow(/permission denied/);
    await expect(queryAs(db, who, "select public.release_stripe_event('probe',$1)", [crypto.randomUUID()])).rejects.toThrow(/permission denied/);
  }
});
it("failed atomic plan application cannot mark the event complete; release/retry succeeds", async () => {
  const c = await claim("evt_atomic"); if (c.state !== "claimed") throw new Error("claim failed");
  const plan = { userId: member, status: "invalid", periodEnd: null, subscriptionId: "sub_db", customerId: "cus_atomic" };
  await expect(db.query("select public.finish_stripe_event($1,$2,'plan_invalid',$3::jsonb)", ["evt_atomic", c.token, JSON.stringify(plan)])).rejects.toThrow(/check constraint/);
  expect((await db.query("select processing_state from public.stripe_events where id='evt_atomic'")).rows).toEqual([{ processing_state: "processing" }]);
  expect((await db.query("select customer_id from public.stripe_customers where user_id=$1", [member])).rows).toEqual([]);
  await db.query("select public.release_stripe_event('evt_atomic',$1)", [c.token]);
  const next = await claim("evt_atomic"); if (next.state !== "claimed") throw new Error("claim failed");
  await db.query("select public.finish_stripe_event($1,$2,'plan_active',$3::jsonb)", ["evt_atomic", next.token, JSON.stringify({ ...plan, status: "active" })]);
  expect(await claim("evt_atomic")).toEqual({ state: "complete", outcome: "plan_active" });
  expect((await db.query("select customer_id from public.stripe_customers where user_id=$1", [member])).rows).toEqual([{ customer_id: "cus_atomic" }]);
  expect((await db.query("select processing_scope,lease_token from public.stripe_events where id='evt_atomic'")).rows).toEqual([{ processing_scope: null, lease_token: null }]);
});
it("serializes all of one user's subscriptions, fences stale workers, and refuses scope mismatches", async () => {
  const old = await claim("evt_old"); if (old.state !== "claimed") throw new Error("claim failed");
  expect(await claim("evt_other_subscription")).toEqual({ state: "busy" });
  await db.query("update public.stripe_processing_locks set leased_until=now()-interval '1 second' where lease_token=$1", [old.token]);
  const next = await claim("evt_other_subscription"); if (next.state !== "claimed") throw new Error("claim failed");
  await expect(db.query("select public.finish_stripe_event('evt_other_subscription',$1,'wrong',$2::jsonb)", [next.token, JSON.stringify({ userId: crypto.randomUUID(), status: "active", subscriptionId: "sub_wrong" })])).rejects.toThrow(/scope mismatch/);
  await db.query("select public.finish_stripe_event('evt_other_subscription',$1,'plan_canceled',$2::jsonb)", [next.token, JSON.stringify({ userId: member, status: "canceled", periodEnd: null, subscriptionId: "sub_db" })]);
  await expect(db.query("select public.finish_stripe_event('evt_old',$1,'plan_active',$2::jsonb)", [old.token, JSON.stringify({ userId: member, status: "active", periodEnd: null, subscriptionId: "sub_db" })])).rejects.toThrow(/lease lost/);
  await db.query("select public.release_stripe_event('evt_old',$1)", [old.token]);
  expect((await db.query("select status from public.entitlements where user_id=$1", [member])).rows).toEqual([{ status: "canceled" }]);
});
it("completion acknowledges a concurrently closing account without restoring its entitlement", async () => {
  const id = crypto.randomUUID();
  await db.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)", [id, `${id}@example.test`, JSON.stringify({ username: `r_${id.slice(0, 8)}`, display_name: "Race test" })]);
  const c = await claim("evt_closing", id); if (c.state !== "claimed") throw new Error("claim failed");
  await db.query("select public.prepare_account_deletion($1)", [id]);
  await db.query("select public.finish_stripe_event('evt_closing',$1,'plan_active',$2::jsonb)", [c.token, JSON.stringify({ userId: id, status: "active", periodEnd: null, subscriptionId: "sub_closing" })]);
  expect((await db.query("select user_id from public.entitlements where user_id=$1", [id])).rows).toEqual([]);
  expect(await claim("evt_closing", id)).toEqual({ state: "complete", outcome: "plan_active" });
});
it.each(["expired", "elapsed"])("settled delayed payment cannot revive a released hold: %s", async (kind) => {
  const host = SEED_USERS.find((u) => u.username === "dev")!.id;
  const ev = (await db.query<{ id: string }>("insert into public.events(title,description,location_name,lat,lng,starts_at,creator_id,category_slug,price_cents) values ('Delayed event','Long enough description','Test venue',39.96,-83,now()+interval '1 day',$1,(select category_slug from public.events limit 1),1500) returning id", [host])).rows[0].id;
  const session = `cs_${kind}`, pi = `pi_${kind}`;
  await db.query("insert into public.tickets(event_id,user_id,status,amount_cents,expires_at,checkout_session_id) values ($1,$2,$3,1500,now()+($4::int*interval '1 minute'),$5)", [ev, member, kind === "expired" ? "expired" : "pending", kind === "elapsed" ? -1 : 30, session]);
  expect((await db.query("select public.confirm_ticket($1,$2,1500) as outcome", [session, pi])).rows).toEqual([{ outcome: "refund" }]);
  expect((await db.query("select status,payment_intent_id from public.tickets where checkout_session_id=$1", [session])).rows).toEqual([{ status: "refund_pending", payment_intent_id: pi }]);
  expect((await db.query("select user_id from public.event_attendees where event_id=$1 and user_id=$2", [ev, member])).rows).toEqual([]);
});
