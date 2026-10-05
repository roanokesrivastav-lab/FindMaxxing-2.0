/**
 * PostgREST returns at most SUPABASE_PAGE_ROWS rows per request and says
 * nothing when it stops there. Unbounded reads (a user's bookmarks, a list's
 * places) page until a short page, so nothing past the cap goes missing.
 */
import { describe, it, expect } from "vitest";
import type { PostgrestError } from "@supabase/supabase-js";
import { SUPABASE_PAGE_ROWS, fetchAllRows } from "../src/lib/data/supabase/repository";

/** A table of `total` rows behind a server that caps every response. */
function cappedServer(total: number) {
  const rows = Array.from({ length: total }, (_, i) => ({ n: i }));
  const requests: [number, number][] = [];
  const page = async (from: number, to: number) => {
    requests.push([from, to]);
    // Like PostgREST: the requested range, never more than the cap.
    return { data: rows.slice(from, Math.min(to + 1, from + SUPABASE_PAGE_ROWS)), error: null };
  };
  return { page, requests };
}

describe("fetchAllRows", () => {
  it.each([0, 1, SUPABASE_PAGE_ROWS - 1, SUPABASE_PAGE_ROWS, SUPABASE_PAGE_ROWS + 5, 2 * SUPABASE_PAGE_ROWS + 5])(
    "returns all %i rows, each exactly once",
    async (total) => {
      const server = cappedServer(total);
      const rows = await fetchAllRows(server.page);
      expect(rows.map((r) => r.n)).toEqual(Array.from({ length: total }, (_, i) => i));
      // One extra (short or empty) page at most, to learn there is nothing more.
      expect(server.requests.length).toBe(Math.floor(total / SUPABASE_PAGE_ROWS) + 1);
    },
  );

  it("surfaces an error from any page", async () => {
    let calls = 0;
    const timeout = { code: "57014", message: "canceling statement due to statement timeout", details: "", hint: "" } as unknown as PostgrestError;
    const page = async (): Promise<{ data: { n: number }[] | null; error: PostgrestError | null }> => {
      calls += 1;
      return calls === 1 ? { data: Array.from({ length: SUPABASE_PAGE_ROWS }, (_, n) => ({ n })), error: null } : { data: null, error: timeout };
    };
    await expect(fetchAllRows(page)).rejects.toThrow(/statement timeout/);
  });
});
