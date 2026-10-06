/**
 * "For you" (Session 13): rule-based recommendations computed under RLS, so
 * they never surface what the viewer cannot see; explained; identical in SQL
 * and the demo store; and an optional Claude rerank that cannot add anything
 * or leak anyone else's data, and falls back to the rule order on failure.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { SEED_USERS } from "../src/lib/seed/seed-data";
import type { Place, Recommendation } from "../src/lib/data/types";

vi.mock("server-only", () => ({}));
const { applyOrder, candidatePayload, rerankPlaces } = await import("../src/server/recommendations/rerank");

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, nina, jules, theo] = ["maya_r", "nina", "jules", "theo"].map(user);
const NOW = new Date(Date.now() + 3600_000).toISOString();

type Row = { id: string; score: string; reason_kind: string; reason_text: string; reason_ref: string | null };

describe("recommendations in the database", () => {
  let db: PGlite;
  const as = <T>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const places = (viewer: string, limit = 50) =>
    as<Row>(viewer, "select place_id as id, score, reason_kind, reason_text, reason_ref from public.recommend_places(null, null, $1)", [limit]);
  beforeAll(async () => {
    db = await createSeededDb();
  });

  it("is for signed-in people only", async () => {
    await expect(as(null, "select * from public.recommend_places()")).rejects.toThrow(/permission denied/);
  });

  it("leaves out what you added, saved or rated, and explains everything", async () => {
    const recs = await places(maya);
    expect(recs.length).toBeGreaterThan(0);
    const excluded = (await db.query<{ id: string }>(
      `select id from public.places where creator_id = $1
       union select place_id from public.saved_places where user_id = $1
       union select place_id from public.place_ratings where user_id = $1`, [maya])).rows.map((r) => r.id);
    for (const r of recs) {
      expect(excluded).not.toContain(r.id);
      expect(r.reason_text.length).toBeGreaterThan(5);
    }
    // Strongest first, ties by id.
    const scores = recs.map((r) => Number(r.score));
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it("never recommends something the viewer cannot see", async () => {
    // A locals-only place that matches nina's interests perfectly.
    await as(jules, "select public.create_place_with_details('Locals coffee', 'A long enough description', null, 'coffee-study', 39.96, -83.0, null, null, 'Columbus', 'locals', array['coffee','food','art'], '[]')");
    const ninaRecs = await places(nina);
    const names = (await db.query<{ id: string; name: string }>("select id, name from public.places")).rows;
    const localsCoffee = names.find((n) => n.name === "Locals coffee")!.id;
    expect(ninaRecs.map((r) => r.id)).not.toContain(localsCoffee);
    // A local with the same interests does get it.
    await as(theo, "insert into public.profile_interests (profile_id, interest_slug) values ($1, 'coffee') on conflict do nothing", [theo]);
    expect((await places(theo)).map((r) => r.id)).toContain(localsCoffee);
  });

  it("explains a followed person's place by naming them", async () => {
    const recs = await places(maya);
    const theosPlaces = (await db.query<{ id: string }>("select id from public.places where creator_id = $1", [theo])).rows.map((r) => r.id);
    const fromTheo = recs.filter((r) => theosPlaces.includes(r.id));
    expect(fromTheo.length).toBeGreaterThan(0);
    expect(fromTheo.every((r) => r.reason_kind === "followed_added" && r.reason_text === "Added by @theo, who you follow")).toBe(true);
  });

  it("recommends upcoming events you have not joined, with reasons", async () => {
    const recs = await as<Row>(maya, "select event_id as id, score, reason_kind, reason_text from public.recommend_events(null, null, 50, $1::timestamptz)", [NOW]);
    const joined = (await db.query<{ event_id: string }>("select event_id from public.event_attendees where user_id = $1", [maya])).rows.map((r) => r.event_id);
    for (const r of recs) expect(joined).not.toContain(r.id);
    expect(recs.every((r) => r.reason_text.length > 5)).toBe(true);
  });
});

describe("recommendation parity", () => {
  it("returns the same places and events, scores and reasons in SQL and the demo store", async () => {
    const db = await createSeededDb();
    const store = createIsolatedStore();
    const repo = createDemoRepository(store);
    // Same timestamps on both sides: "the most recent save" picks the explanation.
    for (const s of store.state.savedPlaces) await db.query("update public.saved_places set created_at = $3 where user_id = $1 and place_id = $2", [s.userId, s.placeId, s.createdAt]);
    // The updated_at trigger would stamp now() over the value being copied in.
    await db.exec("alter table public.place_ratings disable trigger place_ratings_updated_at;");
    for (const r of store.state.placeRatings) await db.query("update public.place_ratings set updated_at = $3 where user_id = $1 and place_id = $2", [r.userId, r.placeId, r.updatedAt]);
    await db.exec("alter table public.place_ratings enable trigger place_ratings_updated_at;");
    await db.exec("alter table public.events disable trigger guard_owner_event_change;");
    for (const e of store.state.events) await db.query("update public.events set starts_at = $2, ends_at = $3 where id = $1", [e.id, e.startsAt, e.endsAt]);
    await db.exec("alter table public.events enable trigger guard_owner_event_change;");
    const near = { lat: 39.9612, lng: -82.9988 };
    for (const viewer of SEED_USERS.map((u) => u.id)) {
      for (const n of [null, near]) {
        const sql = await queryAs<Row>(db, viewer, "select place_id as id, score, reason_kind, reason_text, reason_ref from public.recommend_places($1::float8, $2::float8, 50)", [n?.lat ?? null, n?.lng ?? null]);
        const demo = await repo.recommendations.places(viewer, { near: n, limit: 50 });
        expect([viewer, n, demo.map((r) => [r.item.id, r.score, r.reason.text, r.reason.ref])])
          .toEqual([viewer, n, sql.map((r) => [r.id, Number(r.score), r.reason_text, r.reason_ref])]);
      }
      const sqlEvents = await queryAs<Row>(db, viewer, "select event_id as id, score, reason_kind, reason_text from public.recommend_events(null, null, 50, $1::timestamptz)", [NOW]);
      const demoEvents = await repo.recommendations.events(viewer, { limit: 50, now: NOW });
      expect([viewer, demoEvents.map((r) => [r.item.id, r.score, r.reason.text])]).toEqual([viewer, sqlEvents.map((r) => [r.id, Number(r.score), r.reason_text])]);
    }
  }, 120_000);
});

describe("AI rerank", () => {
  const recs = async () => (await createDemoRepository(createIsolatedStore()).recommendations.places(maya, { limit: 6 })) as Recommendation<Place>[];
  const fakeClient = (impl: (body: Record<string, unknown>) => unknown) => ({ messages: { parse: vi.fn(async (body: Record<string, unknown>) => impl(body)) } }) as never;

  it("reorders and rewrites reasons, but only for places it was given", async () => {
    const list = await recs();
    const [a, b, ...rest] = list;
    const order = [{ id: b.item.id, why: "  Quiet   corner you'd like " }, { id: "00000000-0000-4000-8000-000000000000", why: "made up" }, { id: b.item.id, why: "dupe" }, { id: a.item.id, why: "" }];
    const out = applyOrder(list, order);
    expect(out.map((r) => r.item.id)).toEqual([b.item.id, a.item.id, ...rest.map((r) => r.item.id)]);
    expect(out[0].reason.text).toBe("Quiet corner you'd like");
    expect(out[1].reason.text).toBe(a.reason.text); // an empty reason keeps the rule-based one
  });

  it("falls back to the rule order on an error, a refusal or no parsed output", async () => {
    const list = await recs();
    const ids = list.map((r) => r.item.id);
    for (const impl of [
      () => { throw new Error("timeout"); },
      () => ({ stop_reason: "refusal", parsed_output: null }),
      () => ({ stop_reason: "end_turn", parsed_output: null }),
    ]) {
      expect((await rerankPlaces(list, { interests: ["coffee"], savedPlaceNames: [] }, fakeClient(impl))).map((r) => r.item.id)).toEqual(ids);
    }
  });

  it("sends only the viewer's own signals and public place fields, on the configured model with a cached system prompt", async () => {
    const list = await recs();
    let sent: Record<string, unknown> = {};
    await rerankPlaces(list, { interests: ["coffee", "hiking"], savedPlaceNames: ["Meeple Cellar"] }, fakeClient((body) => {
      sent = body;
      return { stop_reason: "end_turn", parsed_output: { order: [...list].reverse().map((r) => ({ id: r.item.id, why: "fits" })) } };
    }));
    expect(sent.model).toBe("claude-sonnet-5");
    expect((sent.system as { cache_control?: unknown }[])[0].cache_control).toEqual({ type: "ephemeral" });
    const payload = JSON.stringify(sent.messages);
    // No usernames or other people's activity: rule-based reason texts (which can name people) are not sent.
    for (const u of SEED_USERS) expect(payload).not.toContain(`@${u.username}`);
    for (const r of list) expect(payload).not.toContain(r.reason.text.replace(/"/g, '\\"'));
    expect(Object.keys(candidatePayload(list)[0]).sort()).toEqual(["category", "id", "localTip", "name", "neighborhood", "rating", "suggestedBecause", "tags"]);
  });
});
