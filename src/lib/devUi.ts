import { featureEnabled, getDataMode } from "@/lib/config";

/**
 * Roadmap 1.1: the /dev/ui primitives page is demo only. It is available only when
 * the app runs in demo mode AND the pilotFoundation flag is on, so it never appears
 * on a Supabase deployment.
 */
export function devUiAvailable(env: Record<string, string | undefined> = process.env): boolean {
  return getDataMode() === "demo" && featureEnabled("pilotFoundation", env);
}
