import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb } from "./helpers/pglite";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";

const maya = SEED_USERS.find((u) => u.username === "maya_r")!.id;
const jules = SEED_USERS.find((u) => u.username === "jules")!.id;
const place = stableId("place:The Lumen Rooftop");

describe("adversarial direct API writes", () => {
  let db: PGlite;
  const as = async <T>(sql: string, params: unknown[] = []) => {
    await db.exec("savepoint attack");
    try {
      await db.exec("set role authenticated");
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [jules]);
      return (await db.query<T>(sql, params)).rows;
    } catch (err) {
      await db.exec("rollback to savepoint attack");
      throw err;
    } finally {
      await db.exec("reset role");
      await db.query("select set_config('request.jwt.claim.sub','',true)");
      await db.exec("release savepoint attack");
    }
  };
  beforeAll(async () => {
    db = await createSeededDb();
    await db.exec("alter table storage.objects enable row level security; grant usage on schema storage to authenticated; grant select, insert, delete on storage.objects to authenticated;");
  });
  afterAll(async () => { await db.close(); });
  beforeEach(async () => { await db.exec("begin"); });
  afterEach(async () => { await db.exec("rollback"); });

  it("does not let a reporter forge a reviewed outcome and reputation credit", async () => {
    const rows = await as<{ status: string; resolved_at: string | null }>(
      "insert into public.reports(reporter_id,target_type,target_id,reason,status,resolved_at) values($1,'place',$2,'spam','reviewed',now()) returning status,resolved_at", [jules, place]);
    expect(rows[0]).toMatchObject({ status: "open", resolved_at: null });
  });

  it("does not let a place creator backdate contributions to earn trust immediately", async () => {
    const rows = await as<{ fresh: boolean }>(
      "insert into public.places(name,description,category_slug,lat,lng,city,creator_id,created_at) values('Forged age','A sufficiently long description','food',40,-83,'Columbus',$1,now()-interval '60 days') returning created_at >= now() - interval '1 minute' as fresh", [jules]);
    expect(rows[0].fresh).toBe(true);
  });

  it("does not allow orphan variant filenames to bypass the upload quota", async () => {
    await db.query(`insert into public.rate_limit_counters(user_id,action,window_start,count)
      select $1,action,to_timestamp(floor(extract(epoch from now())/window_seconds)*window_seconds),max_count
      from public.rate_limit_rules where action='photos'`, [jules]);
    await expect(as("insert into storage.objects(bucket_id,name,owner) values('place-photos',$1,$2)", [`${jules}/unlimited.sm.webp`, jules])).rejects.toThrow(/rate_limited:photos:/);
  });

  it("prevents moving a rating to a different place and leaving forged aggregates behind", async () => {
    const rows = await as<{ id: string }>("insert into public.place_ratings(place_id,user_id,score) values($1,$2,5) returning id", [place, jules]);
    await expect(as("update public.place_ratings set place_id=$1 where id=$2", [stableId("place:Cannon & Crown"), rows[0].id])).rejects.toThrow(/permission denied|immutable/);
  });

  it("refuses paid AI quota consumption by suspended accounts", async () => {
    await db.query("insert into public.suspensions(user_id,reason) values($1,'Audit suspension')", [jules]);
    await expect(as("select public.consume_trip_plan()")).rejects.toThrow(/account_suspended/);
  });

  it("does not let a crafted place name authorize deleting another owner's photo", async () => {
    const ownPath = `${jules}/own.webp`;
    const victimPath = `${maya}/victim.webp`;
    const owned = await as<{ id: string }>(
      "insert into public.places(name,description,category_slug,lat,lng,city,creator_id) values($1,'A sufficiently long description','food',40,-83,'Columbus',$2) returning id", [ownPath, jules]);
    await db.query("insert into public.place_photos(place_id,url,storage_path,uploader_id) values($1,$2,$2,$3),($4,$5,$5,$6)",
      [owned[0].id, ownPath, jules, place, victimPath, maya]);
    await db.query("insert into storage.objects(bucket_id,name,owner) values('place-photos',$1,$2)", [victimPath, maya]);
    expect(await as("select name from storage.objects where name=$1", [victimPath])).toHaveLength(1);
    expect(await as("delete from storage.objects where name=$1 returning name", [victimPath])).toEqual([]);
  });

  it("keeps other users' saves, lists, tickets and notifications private", async () => {
    for (const [table, column] of [["saved_places", "user_id"], ["saved_lists", "owner_id"], ["tickets", "user_id"], ["notifications", "user_id"]]) {
      expect(await as(`select * from public.${table} where ${column}=$1`, [maya])).toEqual([]);
    }
  });
});
