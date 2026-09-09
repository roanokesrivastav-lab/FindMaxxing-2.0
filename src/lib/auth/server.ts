import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getDataMode } from "@/lib/config";
import type { Profile } from "@/lib/data/types";

export interface Viewer {
  id: string;
  email: string | null;
  profile: Profile;
}

/**
 * The signed-in user for this request, or null. Cached per request.
 * In Supabase mode the JWT is validated server-side via auth.getUser().
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  if (getDataMode() === "supabase") return getSupabaseViewer();
  return getDemoViewer();
});

export async function requireViewer(next?: string): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect(`/auth/sign-in${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  return viewer;
}

async function getSupabaseViewer(): Promise<Viewer | null> {
  const { createSupabaseServerClient } = await import("@/lib/supabase/server");
  const { createSupabaseRepository } = await import("@/lib/data/supabase/repository");
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;
  const repo = createSupabaseRepository(supabase);
  let profile = await repo.profiles.getById(user.id);
  if (!profile) {
    // Profile rows are normally created by a DB trigger on sign-up; recover if it's missing.
    const meta = (user.user_metadata ?? {}) as { username?: string; display_name?: string };
    const fallbackUsername = (meta.username ?? `user_${user.id.slice(0, 8)}`).toLowerCase();
    await supabase.from("profiles").insert({
      id: user.id,
      username: fallbackUsername,
      display_name: meta.display_name ?? fallbackUsername,
    });
    profile = await repo.profiles.getById(user.id);
    if (!profile) return null;
  }
  return { id: user.id, email: user.email ?? null, profile };
}

async function getDemoViewer(): Promise<Viewer | null> {
  const { DEMO_SESSION_COOKIE, demoSessionFromCookie } = await import("@/lib/data/demo/auth");
  const { createDemoRepository } = await import("@/lib/data/demo/repository");
  const store = await cookies();
  const session = demoSessionFromCookie(store.get(DEMO_SESSION_COOKIE)?.value);
  if (!session) return null;
  const profile = await createDemoRepository().profiles.getById(session.userId);
  if (!profile) return null;
  return { id: session.userId, email: session.email, profile };
}
