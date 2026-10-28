import "server-only";
import { getDataMode } from "@/lib/config";
import type { DataRepository } from "@/lib/data/repository";

/**
 * A repository for server jobs with no signed-in user (crons, webhooks): the
 * service-role client in Supabase mode, the demo store otherwise.
 */
export async function serviceRepository(): Promise<DataRepository> {
  if (getDataMode() === "supabase") {
    const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
    const { createSupabaseRepository } = await import("@/lib/data/supabase/repository");
    return createSupabaseRepository(createSupabaseAdminClient());
  }
  const { createDemoRepository } = await import("@/lib/data/demo/repository");
  return createDemoRepository();
}
