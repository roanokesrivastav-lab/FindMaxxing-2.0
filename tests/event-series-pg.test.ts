/**
 * Roadmap 4.5a: 4.0 spec §15 concurrency case 8 on REAL PostgreSQL with two independent connections
 * (tests/helpers/postgres.ts): two generate_series_occurrences runs at once never duplicate a local date.
 * SKIPPED without TEST_DATABASE_URL, which is NOT passing. Results print as [race] lines.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createTestDatabase, testDatabaseUrl, type TestDatabase } from "./helpers/postgres";

const url = testDatabaseUrl();

describe.skipIf(!url)("4.5a series generation: two PostgreSQL connections racing", () => {
  let t: TestDatabase;
  const owner = randomUUID();
  beforeAll(async () => {
    t = await createTestDatabase(url!);
    await t.a.query("insert into auth.users (id, email, raw_user_meta_data) values ($1, 'owner@race.test', $2)", [owner, JSON.stringify({ username: "seriesowner", display_name: "Owner" })]);
  }, 180_000);
  afterAll(async () => { await t?.drop(); });

  it("8. two concurrent generate_series_occurrences runs → no duplicate local dates (10 rounds, 3 series each)", async () => {
    let created = 0;
    for (let round = 0; round < 10; round++) {
      const ids: string[] = [];
      for (let k = 0; k < 3; k++) {
        const [{ id }] = (await t.a.query<{ id: string }>(
          `insert into public.event_series (owner_id, title, description, category_slug, location_name, lat, lng, time_zone, weekdays, start_local, duration_minutes, starts_on)
           values ($1, 'Race series', 'Racing the generator here.', (select slug from public.categories limit 1), 'Court', 40, -83, 'America/New_York', '{1,2,3,4,5,6,7}', '19:00', 60, current_date) returning id`, [owner])).rows;
        await t.a.query("insert into public.event_series_hosts (series_id, user_id, role) values ($1, $2, 'owner')", [id, owner]);
        ids.push(id);
      }
      const [ra, rb] = await Promise.all([
        t.a.query<{ n: number }>("select public.generate_series_occurrences(null, now()) as n"),
        t.b.query<{ n: number }>("select public.generate_series_occurrences(null, now()) as n"),
      ]);
      created += ra.rows[0].n + rb.rows[0].n;
      const dup = await t.a.query("select series_id, series_local_date, count(*) from public.events where series_id = any($1) group by 1, 2 having count(*) > 1", [ids]);
      expect(dup.rows).toEqual([]);
      const per = await t.a.query<{ n: number }>("select count(*)::int as n from public.events where series_id = any($1)", [ids]);
      // Both runs together created exactly one row per date (each series: 28 or 29 dates in the horizon).
      expect(ra.rows[0].n + rb.rows[0].n).toBe(per.rows[0].n);
      expect(per.rows[0].n).toBeGreaterThanOrEqual(3 * 28);
    }
    console.log(`[race] case 8: 10 rounds × 3 series, two generators at once → ${created} occurrences created, 0 duplicate local dates`);
  }, 300_000);
});
