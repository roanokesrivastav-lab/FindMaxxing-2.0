/**
 * Not a test: loads synthetic places into PGlite and prints query plans and
 * timings for the discovery functions. Run with:
 *   npx tsx tests/helpers/measure-discovery.ts [placeCount]
 */
import { createSeededDb, queryAs } from "./pglite";

const COUNT = Number(process.argv[2] ?? 50_000);

async function main() {
  const db = await createSeededDb();
  const creator = (await db.query<{ id: string }>("select id from public.profiles limit 1")).rows[0].id;
  // Spread places over four metro areas, ~12% locals-only, 2% hidden.
  await db.query(
    `insert into public.places (name, description, category_slug, lat, lng, city, creator_id, visibility, status, created_at)
     select 'Synthetic ' || g, 'Generated place number ' || g || ' for load measurement.',
            (array['food','coffee-study','pickup-sports','outdoors','nightlife','sports-bar'])[1 + g % 6],
            c.lat + (random() - 0.5) * 0.4, c.lng + (random() - 0.5) * 0.4, c.city, $1,
            case when g % 8 = 0 then 'locals' else 'public' end,
            case when g % 50 = 0 then 'hidden' else 'published' end,
            now() - (g || ' minutes')::interval
     from generate_series(1, $2::int) g
     cross join lateral (select * from (values (39.96, -83.00, 'Columbus'), (41.50, -81.69, 'Cleveland'),
                                              (39.10, -84.51, 'Cincinnati'), (40.71, -74.00, 'New York')) v(lat, lng, city)
                         offset g % 4 limit 1) c`,
    [creator, COUNT],
  );
  await db.query(
    `insert into public.place_tags (place_id, interest_slug)
     select id, (array['coffee','food','hiking','studying','sports'])[1 + (abs(hashtext(id::text)) % 5)] from public.places
     on conflict do nothing`,
  );
  await db.exec("analyze;");
  console.log(`places: ${(await db.query<{ n: number }>("select count(*)::int n from public.places")).rows[0].n}`);

  const box = "p_north => 40.00, p_south => 39.92, p_east => -82.95, p_west => -83.05";
  const cases: [string, string][] = [
    ["list: bbox, newest first, 31 rows", `select id from public.discover_places(${box}) order by created_at desc, id desc limit 31`],
    ["list: no filters, newest first, 31 rows", `select id from public.discover_places() order by created_at desc, id desc limit 31`],
    ["list: no filters, deep keyset page", `select id from public.discover_places(p_after_created_at => now() - interval '20000 minutes', p_after_id => '00000000-0000-4000-8000-000000000000') order by created_at desc, id desc limit 31`],
    ["map: bbox, notable first, 301 rows", `select id from public.discover_places(${box}) order by rating_count desc, save_count desc, id limit 301`],
    ["map: whole world, notable first, 301 rows", `select id from public.discover_places() order by rating_count desc, save_count desc, id limit 301`],
    ["list: text only (full scan)", `select id from public.discover_places(p_text => 'number 4242') order by created_at desc, id desc limit 31`],
    ["list: bbox + text", `select id from public.discover_places(${box}, p_text => 'number 42') order by created_at desc, id desc limit 31`],
    ["list: bbox, deep keyset page", `select id from public.discover_places(${box}, p_after_created_at => now() - interval '20000 minutes', p_after_id => '00000000-0000-4000-8000-000000000000') order by created_at desc, id desc limit 31`],
    ["list: tag filter", `select id from public.discover_places(p_tags => array['hiking']) order by created_at desc, id desc limit 31`],
  ];
  for (const role of [null, creator]) {
    console.log(`\n=== as ${role ? "authenticated" : "anon"} ===`);
    for (const [label, sql] of cases) {
      const plan = await queryAs<{ "QUERY PLAN": string }>(db, role, `explain (analyze, costs off, timing on) ${sql}`);
      const lines = plan.map((r) => r["QUERY PLAN"]);
      const time = lines.find((l) => l.startsWith("Execution Time"));
      const scans = lines.filter((l) => /Scan|Sort/.test(l)).map((l) => l.trim().replace(/\s+\(actual.*$/, "")).slice(0, 3);
      console.log(`${label.padEnd(44)} ${time?.replace("Execution Time: ", "").padStart(12)}   ${scans.join(" | ")}`);
    }
  }
  await db.close();
}

main();
