/**
 * Not a test: a repeatable load check for discovery. Loads synthetic places
 * (and events) into PGlite, runs every hot discovery query repeatedly as anon
 * and as a signed-in local, and prints p50/p95 timings with the plan's scan
 * nodes. A sequential scan on `places` or `events` in a hot path is flagged.
 *
 *   npx tsx tests/helpers/measure-discovery.ts [placeCount=50000] [--runs 20] [--spread] [--json out.json]
 *
 * By default every place is in one city (Columbus), the dense case the map has
 * to survive; --spread splits them over four metro areas instead.
 */
import { writeFileSync } from "node:fs";
import { createSeededDb, queryAs } from "./pglite";

const argv = process.argv.slice(2);
const flag = (name: string) => argv.indexOf(name);
const COUNT = Number(argv.find((a) => /^\d+$/.test(a)) ?? 50_000);
const RUNS = flag("--runs") >= 0 ? Number(argv[flag("--runs") + 1]) : 20;
const SPREAD = argv.includes("--spread");
const JSON_OUT = flag("--json") >= 0 ? argv[flag("--json") + 1] : null;
/** Print the full EXPLAIN ANALYZE for queries whose label contains this text. */
const EXPLAIN = flag("--explain") >= 0 ? argv[flag("--explain") + 1] : null;

export interface Measurement {
  label: string;
  role: "anon" | "local";
  p50: number;
  p95: number;
  rows: number;
  scans: string[];
  seqScanOnHotTable: boolean;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

async function main() {
  const db = await createSeededDb();
  const local = (await db.query<{ id: string }>("select id from public.profiles where username = 'jules'")).rows[0].id;
  const metros = SPREAD
    ? "(values (39.96, -83.00, 'Columbus'), (41.50, -81.69, 'Cleveland'), (39.10, -84.51, 'Cincinnati'), (40.71, -74.00, 'New York'))"
    : "(values (39.96, -83.00, 'Columbus'))";
  const metroCount = SPREAD ? 4 : 1;
  const started = Date.now();
  // ~12% locals-only, 2% hidden, eight neighborhoods, six categories. Text is
  // drawn from a 64-word vocabulary (so a word appears in ~9% of places, like
  // a real common term), plus "zephyr" in one place in 500 (a rare term).
  const vocabulary = "array['quiet','loud','cheap','late','early','patio','rooftop','tacos','ramen','pizza','coffee','espresso','study','wifi','outlets','courts','field','trail','river','park','bar','screens','game','trivia','karaoke','dumplings','bakery','vinyl','books','arcade','pool','darts','hoops','soccer','pickleball','tennis','climbing','yoga','run','bike','dog','friendly','hidden','gem','locals','classic','new','old','cozy','big','small','sunny','shady','view','skyline','alley','basement','corner','market','garden','mural','gallery','stage','open']";
  await db.query(
    `insert into public.places (name, description, local_tip, category_slug, lat, lng, city, neighborhood, creator_id, visibility, status, created_at)
     select 'Synthetic ' || g,
            (select string_agg((${vocabulary})[1 + abs(hashtext(g::text || ':' || i)) % 64], ' ') from generate_series(1, 6) i)
              || case when g % 500 = 0 then ' zephyr' else '' end || ' spot ' || g || '.',
            case when g % 3 = 0 then (select string_agg((${vocabulary})[1 + abs(hashtext('tip' || g || ':' || i)) % 64], ' ') from generate_series(1, 4) i) end,
            (array['food','coffee-study','pickup-sports','outdoors','nightlife','sports-bar'])[1 + g % 6],
            c.lat + (random() - 0.5) * 0.25, c.lng + (random() - 0.5) * 0.25, c.city,
            (array['Short North','German Village','Clintonville','Franklinton','Italian Village','Victorian Village','Old North','Downtown'])[1 + g % 8],
            $1,
            case when g % 8 = 0 then 'locals' else 'public' end,
            case when g % 50 = 0 then 'hidden' else 'published' end,
            now() - (g || ' minutes')::interval
     from generate_series(1, $2::int) g
     cross join lateral (select * from ${metros} v(lat, lng, city) offset g % ${metroCount} limit 1) c`,
    [local, COUNT],
  );
  await db.query(
    `insert into public.place_tags (place_id, interest_slug)
     select id, (array['coffee','food','hiking','studying','sports'])[1 + (abs(hashtext(id::text)) % 5)] from public.places
     on conflict do nothing`,
  );
  // One upcoming event for every ten places, half of them linked to a place.
  await db.query(
    `insert into public.events (title, description, place_id, location_name, lat, lng, starts_at, creator_id, category_slug, created_at)
     select 'Synthetic event ' || g, 'Generated event number ' || g || ' for load measurement.',
            case when g % 2 = 0 then (select id from public.places where name = 'Synthetic ' || (g * 10)) end,
            'Somewhere ' || g, 39.96 + (random() - 0.5) * 0.25, -83.00 + (random() - 0.5) * 0.25,
            now() + (g || ' minutes')::interval, $1, 'outdoors', now()
     from generate_series(1, $2::int) g`,
    [local, Math.floor(COUNT / 10)],
  );
  await db.exec("analyze;");
  const places = (await db.query<{ n: number }>("select count(*)::int n from public.places")).rows[0].n;
  const events = (await db.query<{ n: number }>("select count(*)::int n from public.events")).rows[0].n;
  console.log(`loaded ${places} places and ${events} events (${SPREAD ? "four metros" : "one city"}) in ${((Date.now() - started) / 1000).toFixed(1)}s; ${RUNS} runs per query\n`);

  // A ~2km box in the dense middle (a zoomed-in phone map) and the whole city.
  const zoomed = "p_north => 39.97, p_south => 39.95, p_east => -82.99, p_west => -83.01";
  const city = "p_north => 40.10, p_south => 39.83, p_east => -82.87, p_west => -83.13";
  const deep = "p_after_created_at => now() - interval '20000 minutes', p_after_id => '00000000-0000-4000-8000-000000000000'";
  const cutoff = "p_ends_after => now() - interval '1 hour'";
  const cases: [string, string][] = [
    ["map markers: zoomed box (301)", `select id from public.discover_places(${zoomed}) order by rating_count desc, save_count desc, id limit 301`],
    ["map markers: whole city (301)", `select id from public.discover_places(${city}) order by rating_count desc, save_count desc, id limit 301`],
    ["map markers: events, whole city (301)", `select id from public.discover_events(${city}, ${cutoff}) order by starts_at, id limit 301`],
    ["list page 1: zoomed box", `select id from public.discover_places(${zoomed}) order by created_at desc, id desc limit 31`],
    ["list page 1: no filters", `select id from public.discover_places() order by created_at desc, id desc limit 31`],
    ["list deep page: no filters", `select id from public.discover_places(${deep}) order by created_at desc, id desc limit 31`],
    ["list page 1: category + tag", `select id from public.discover_places(p_category => 'food', p_tags => array['hiking']) order by created_at desc, id desc limit 31`],
    ["list page 1: neighborhood", `select id from public.discover_places(p_neighborhood => 'german village') order by created_at desc, id desc limit 31`],
    ["list page 1: events upcoming", `select id from public.discover_events(${cutoff}) order by starts_at, id limit 31`],
    ["search: rare term, everywhere", `select id from public.discover_places(p_text => 'zephyr') order by created_at desc, id desc limit 31`],
    ["search: common term, everywhere", `select id from public.discover_places(p_text => 'rooftop') order by created_at desc, id desc limit 31`],
    ["search: common term, zoomed box", `select id from public.discover_places(${zoomed}, p_text => 'rooftop') order by created_at desc, id desc limit 31`],
    ["search: no match", `select id from public.discover_places(p_text => 'zzzz-nothing') order by created_at desc, id desc limit 31`],
    ["search: events, rare term", `select id from public.discover_events(${cutoff}, p_text => 'event number 4242') order by starts_at, id limit 31`],
    ["count: whole city", `select count(*) from public.discover_places(${city})`],
    ["count: tag", `select count(*) from public.discover_places(p_tags => array['coffee'])`],
    ["aggregate: neighborhoods", `select * from public.discover_neighborhoods()`],
    ["aggregate: tag counts", `select * from public.discover_tag_counts(now() - interval '1 hour')`],
  ];
  const nearest = await db.query<{ ok: boolean }>("select exists (select 1 from pg_proc where proname = 'discover_places_nearest') as ok");
  if (nearest.rows[0].ok) {
    cases.push(["list page 1: nearest, whole city", `select id from public.discover_places_nearest(39.96, -83.00, ${city}) limit 31`]);
    cases.push(["list page 1: nearest, no box", `select id from public.discover_places_nearest(39.96, -83.00) limit 31`]);
  }

  const results: Measurement[] = [];
  for (const [role, userId] of [["anon", null], ["local", local]] as const) {
    console.log(`=== as ${role === "anon" ? "anon" : "a signed-in local"} ===`);
    console.log(`${"query".padEnd(40)} ${"p50 ms".padStart(8)} ${"p95 ms".padStart(8)} ${"rows".padStart(6)}   plan`);
    for (const [label, sql] of cases) {
      const times: number[] = [];
      let rows = 0;
      for (let i = 0; i < RUNS; i++) {
        const t = performance.now();
        rows = (await queryAs(db, userId, sql)).length;
        times.push(performance.now() - t);
      }
      times.sort((a, b) => a - b);
      const plan = (await queryAs<{ "QUERY PLAN": string }>(db, userId, `explain (costs off) ${sql}`)).map((r) => r["QUERY PLAN"]);
      if (EXPLAIN && label.includes(EXPLAIN)) {
        const analyzed = await queryAs<{ "QUERY PLAN": string }>(db, userId, `explain (analyze, costs off) ${sql}`);
        console.log(`\n--- ${label} (${role}) ---\n${analyzed.map((r) => r["QUERY PLAN"]).join("\n")}\n`);
      }
      const scans = plan.filter((l) => /Scan|Sort/.test(l)).map((l) => l.trim().replace(/^->\s*/, ""));
      const seq = scans.some((s) => /^Seq Scan on (places|events)\b/.test(s));
      results.push({ label, role, p50: percentile(times, 50), p95: percentile(times, 95), rows, scans, seqScanOnHotTable: seq });
      const shown = [...new Set(scans.map((s) => s.replace(/ using | on /, " ").split(" ").slice(0, 4).join(" ")))].slice(0, 3).join(" | ");
      console.log(`${label.padEnd(40)} ${percentile(times, 50).toFixed(1).padStart(8)} ${percentile(times, 95).toFixed(1).padStart(8)} ${String(rows).padStart(6)}   ${seq ? "SEQ SCAN  " : ""}${shown}`);
    }
    console.log("");
  }
  if (JSON_OUT) {
    writeFileSync(JSON_OUT, JSON.stringify({ places, events, runs: RUNS, spread: SPREAD, results }, null, 2));
    console.log(`wrote ${JSON_OUT}`);
  }
  await db.close();
}

void main();
