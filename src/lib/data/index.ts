import "server-only";
import { getDataMode } from "@/lib/config";
import type { DataRepository } from "./repository";

/**
 * Resolve the repository for the current request.
 *   - supabase mode: a request-scoped client bound to the viewer's session
 *   - demo mode:     the process-wide file-backed store
 */
export async function getRepository(): Promise<DataRepository> {
  if (getDataMode() === "supabase") {
    const [{ createSupabaseServerClient }, { createSupabaseRepository }] = await Promise.all([
      import("@/lib/supabase/server"),
      import("./supabase/repository"),
    ]);
    return createSupabaseRepository(await createSupabaseServerClient());
  }
  const { createDemoRepository } = await import("./demo/repository");
  return createDemoRepository();
}

export type { DataRepository } from "./repository";
export * from "./types";
