import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import type { DeletionJob } from "../src/server/accountDeletionJobs";

let db: PGlite;
beforeAll(async () => { db = await createSeededDb(); });
afterAll(async () => { await db?.close(); });
async function person() {
  const id = crypto.randomUUID();
  await db.query("insert into auth.users(id,email,raw_user_meta_data) values ($1,$2,$3)", [id, `${id}@example.test`, JSON.stringify({ username: `d_${id.slice(0, 8)}`, display_name: "Deletion test" })]);
  return id;
}
async function event(host: string, future = true) {
  const [row] = (await db.query<{ id: string }>(`insert into public.events(title,description,location_name,lat,lng,starts_at,creator_id,category_slug,price_cents)
    values ('Deletion event','A long enough description','Test location',39.96,-83,now()+($2::int * interval '1 day'),$1,(select category_slug from public.events limit 1),1500) returning id`, [host, future ? 1 : -1])).rows;
  return row.id;
}
async function ticket(ev: string, buyer: string, status = "paid") {
  const id = crypto.randomUUID();
  await db.query("insert into public.tickets(id,event_id,user_id,status,amount_cents,expires_at,payment_intent_id,checkout_session_id) values ($1,$2,$3,$4,1500,now()+interval '30 minutes',$5,$6)", [id, ev, buyer, status, status === "paid" ? `pi_${id}` : null, `cs_${id}`]);
  return id;
}
const claim = async (id: string) => (await db.query<DeletionJob>("select * from public.claim_account_deletion($1)", [id])).rows[0];

describe("account deletion database lifecycle", () => {
  it("atomically inventories nested, unattached and other-uploader photos without a list-page limit", async () => {
    const host = await person(), other = await person();
    const [place] = (await db.query<{ id: string }>(`insert into public.places(name,description,category_slug,lat,lng,city,creator_id) values ('Deletion place','Long enough description',(select slug from public.categories where scope in ('place','both') limit 1),39.96,-83,'Columbus',$1) returning id`, [host])).rows;
    await db.query("insert into public.place_photos(place_id,url,storage_path,uploader_id) values ($1,'storage:place-photos/test',$2,$3)", [place.id, `${other}/shared.webp`, other]);
    await db.query("insert into storage.objects(bucket_id,name,owner) select 'place-photos',$1 || '/nested/' || g || '.webp',$2 from generate_series(1,1105) g", [host, host]);
    for (const name of [`${other}/shared.webp`, `${other}/shared.sm.webp`, `${other}/shared.md.webp`, `${other}/unrelated.webp`]) await db.query("insert into storage.objects(bucket_id,name,owner) values ('place-photos',$1,$2)", [name, other]);
    await db.query("insert into storage.objects(bucket_id,name,owner) values ('avatars',$1,$2)", [`${host}/avatar.webp`, host]);
    const job = await claim(host);
    expect(job.storage_paths).toHaveLength(1109);
    expect(job.storage_paths.some((p) => p.path === `${other}/shared.sm.webp`)).toBe(true);
    expect(job.storage_paths.some((p) => p.path === `${other}/unrelated.webp`)).toBe(false);
    await expect(queryAs(db, host, "select public.count_upload('avatars',$1)", [`${host}/new.webp`])).rejects.toThrow(/account_deletion_in_progress/);
    await expect(queryAs(db, host, "update public.profiles set bio='new' where id=auth.uid()")).rejects.toThrow(/account_deletion_in_progress/);
    await expect(db.query("insert into public.place_photos(place_id,url,storage_path,uploader_id) values ($1,'new',$2,$3)", [place.id, `${other}/new.webp`, other])).rejects.toThrow(/account_deletion_in_progress/);
  });
  it("keeps the journal and control RPCs service-only, and fences concurrent workers", async () => {
    const host = await person(), other = await person();
    const job = await claim(host);
    expect((await db.query("select * from public.claim_account_deletion($1)", [host])).rows).toEqual([]);
    for (const me of [host, other, null]) {
      await expect(queryAs(db, me, "select * from public.account_deletion_jobs")).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, me, "select public.prepare_account_deletion($1)", [host])).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, me, "select * from public.claim_account_deletion($1)", [host])).rejects.toThrow(/permission denied/);
      await expect(queryAs(db, me, "select public.save_account_deletion_progress($1,$2,'{}')", [host, job.lease_token])).rejects.toThrow(/permission denied/);
    }
    expect(await queryAs(db, host, "select public.account_is_closing(auth.uid()) as closing")).toEqual([{ closing: true }]);
    expect(await queryAs(db, other, "select public.account_is_closing($1) as closing", [host])).toEqual([{ closing: false }]);
    await expect(db.query("select public.save_account_deletion_progress($1,$2,'{}')", [host, crypto.randomUUID()])).rejects.toThrow(/lease lost/);
    await db.query("select public.save_account_deletion_progress($1,$2,'{\"release\":true}')", [host, job.lease_token]);
    const next = await claim(host); expect(next.lease_token).not.toBe(job.lease_token);
    await expect(db.query("select public.save_account_deletion_progress($1,$2,'{}')", [host, job.lease_token])).rejects.toThrow(/lease lost/);
    await expect(db.query("select public.save_account_deletion_progress($1,$2,'{\"complete\":true}')", [host, next.lease_token])).rejects.toThrow(/not complete/);
  });
  it("queues future paid refunds and expires holds while preserving historical tickets across Auth cascades", async () => {
    const host = await person(), buyer = await person(), other = await person();
    const future = await event(host), past = await event(host, false);
    const paid = await ticket(future, buyer), historical = await ticket(past, buyer), pending = await ticket(future, other, "pending");
    const refunded = await ticket(future, await person());
    const expired = await ticket(future, await person(), "expired");
    await db.query("update public.tickets set status='refunded' where id=$1", [refunded]);
    await db.query("delete from auth.users where id=$1", [host]);
    expect((await db.query("select event_id,status,payment_intent_id from public.tickets where id=$1", [paid])).rows).toEqual([{ event_id: null, status: "refund_pending", payment_intent_id: `pi_${paid}` }]);
    expect((await db.query("select status from public.tickets where id=$1", [historical])).rows).toEqual([{ status: "paid" }]);
    expect((await db.query("select status from public.tickets where id=$1", [pending])).rows).toEqual([{ status: "expired" }]);
    expect((await db.query("select status from public.tickets where id=$1", [expired])).rows).toEqual([{ status: "expired" }]);
    expect((await db.query("select status from public.tickets where id=$1", [refunded])).rows).toEqual([{ status: "refunded" }]);
    expect((await db.query("select public.confirm_ticket($1,$2,1500) as outcome", [`cs_${pending}`, `pi_${pending}`])).rows).toEqual([{ outcome: "refund" }]);
    await db.query("select public.mark_ticket_refunded($1)", [`pi_${paid}`]);
    await db.query("select public.mark_ticket_refunded($1)", [`pi_${paid}`]);
    expect((await db.query("select status from public.tickets where id=$1", [paid])).rows).toEqual([{ status: "refunded" }]);
  });
  it("captures billing IDs before deletion and ignores racing/late writes to closed accounts", async () => {
    const host = await person();
    await db.query("select public.link_stripe_customer($1,'cus_lifecycle')", [host]);
    await db.query("select public.set_entitlement($1,'active',now()+interval '30 days','sub_lifecycle')", [host]);
    const job = await claim(host);
    expect(job.stripe_customer_id).toBe("cus_lifecycle"); expect(job.stripe_subscription_ids).toEqual(["sub_lifecycle"]);
    await db.query("select public.set_entitlement($1,'active',now()+interval '30 days','sub_racing')", [host]);
    expect((await db.query("select stripe_subscription_id from public.entitlements where user_id=$1", [host])).rows).toEqual([{ stripe_subscription_id: "sub_lifecycle" }]);
    await db.query("delete from auth.users where id=$1", [host]);
    await db.query("select public.set_entitlement($1,'active',now()+interval '30 days','sub_late')", [host]);
    await db.query("select public.link_stripe_customer($1,'cus_late')", [host]);
    await db.query("select public.set_host_account($1,'acct_late',true)", [host]);
    expect((await db.query("select user_id from public.entitlements where user_id=$1", [host])).rows).toEqual([]);
    expect((await db.query("select stripe_customer_id from public.account_deletion_jobs where user_id=$1", [host])).rows).toEqual([{ stripe_customer_id: "cus_lifecycle" }]);
    await db.query("select public.save_account_deletion_progress($1,$2,'{\"billing\":true,\"storage\":true,\"complete\":true}')", [host, job.lease_token]);
    const [receipt] = (await db.query<{ storage_paths: unknown[]; stripe_customer_id: string | null; stripe_subscription_ids: string[]; completed_at: string }>("select * from public.account_deletion_jobs where user_id=$1", [host])).rows;
    expect(receipt.storage_paths).toEqual([]); expect(receipt.stripe_customer_id).toBeNull(); expect(receipt.stripe_subscription_ids).toEqual([]); expect(receipt.completed_at).toBeTruthy();
  });
  it("a missing-profile recovery is not classified as account deletion", async () => {
    const id = await person();
    await db.query("delete from public.profiles where id=$1", [id]);
    expect((await db.query("select user_id from public.account_deletion_jobs where user_id=$1", [id])).rows).toEqual([]);
    await queryAs(db, id, "insert into public.profiles(id,username,display_name) values ($1,$2,'Recovered')", [id, `r_${id.slice(0, 8)}`]);
    expect(await queryAs(db, id, "select public.account_is_closing(auth.uid()) as closing")).toEqual([{ closing: false }]);
  });
  it("persists per-step checkpoints and invalidates Storage completion if an object reappears", async () => {
    const id = await person();
    const path = { bucket: "avatars", path: `${id}/avatar.webp` };
    await db.query("insert into storage.objects(bucket_id,name,owner) values ('avatars',$1,$2)", [path.path, id]);
    const job = await claim(id);
    await db.query("delete from storage.objects where name=$1", [path.path]);
    const patch = JSON.stringify({ removed: [path], canceled: ["sub_done"], storage: true, release: true });
    await db.query("select public.save_account_deletion_progress($1,$2,$3::jsonb)", [id, job.lease_token, patch]);
    const resumed = await claim(id);
    expect(resumed.removed_storage_paths).toEqual([path]);
    expect(resumed.canceled_subscription_ids).toEqual(["sub_done"]);
    expect(resumed.storage_complete).toBe(true);
    await db.query("select public.save_account_deletion_progress($1,$2,'{\"release\":true}')", [id, resumed.lease_token]);
    await db.query("insert into storage.objects(bucket_id,name,owner) values ('avatars',$1,$2)", [path.path, id]);
    const reappeared = await claim(id);
    expect(reappeared.storage_complete).toBe(false);
    expect(reappeared.removed_storage_paths).toEqual([]);
    expect(reappeared.storage_paths).toEqual([path]);
    expect(reappeared.canceled_subscription_ids).toEqual(["sub_done"]);
  });
  it("a late payment for a closing buyer is queued for refund, not attendance", async () => {
    const host = await person(), buyer = await person();
    const ev = await event(host), pending = await ticket(ev, buyer, "pending");
    await claim(buyer);
    expect((await db.query("select public.confirm_ticket($1,$2,1500) as outcome", [`cs_${pending}`, `pi_${pending}`])).rows).toEqual([{ outcome: "refund" }]);
    expect((await db.query("select * from public.event_attendees where event_id=$1 and user_id=$2", [ev, buyer])).rows).toEqual([]);
  });
});
