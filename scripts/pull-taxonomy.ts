/**
 * Prints the live categories and interests from the database (Supabase mode,
 * service role) as TypeScript entries to paste into src/lib/data/taxonomy.ts,
 * so admin edits reach the app's pickers at the next deploy. Hints and search
 * keywords are code-only and are kept from the current file.
 *
 *   SUPABASE_SERVICE_ROLE_KEY=… NEXT_PUBLIC_SUPABASE_URL=… npx tsx scripts/pull-taxonomy.ts
 */
import { createClient } from "@supabase/supabase-js";
import { CATEGORY_MAP, INTEREST_MAP } from "../src/lib/data/taxonomy";

async function main() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    console.error("pull-taxonomy: set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });
  const [cats, ints] = await Promise.all([
    db.from("categories").select("*").order("sort_order"),
    db.from("interests").select("*").order("sort_order"),
  ]);
  if (cats.error || ints.error) throw new Error(cats.error?.message ?? ints.error?.message);
  console.log("// CATEGORIES (retired entries are commented out)");
  for (const c of cats.data ?? []) {
    const known = CATEGORY_MAP[c.slug];
    const line = `  { slug: ${JSON.stringify(c.slug)}, label: ${JSON.stringify(c.label)}, emoji: ${JSON.stringify(c.emoji)}, color: ${JSON.stringify(c.color)}, scope: ${JSON.stringify(c.scope)}, hint: ${JSON.stringify(known?.hint ?? "")}, keywords: ${JSON.stringify(known?.keywords ?? [])} },`;
    console.log(c.retired ? `//${line}` : line);
  }
  console.log("\n// INTERESTS");
  for (const t of ints.data ?? []) {
    const known = INTEREST_MAP[t.slug];
    const line = `  { slug: ${JSON.stringify(t.slug)}, label: ${JSON.stringify(t.label)}, emoji: ${JSON.stringify(t.emoji)}${known?.keywords ? `, keywords: ${JSON.stringify(known.keywords)}` : ""} },`;
    console.log(t.retired ? `//${line}` : line);
  }
}

void main();
