import "server-only";
import { getDataMode } from "@/lib/config";
import { DataError } from "@/lib/data/types";
import { PLACE_PHOTO_BUCKET } from "@/lib/data/photos";
import { photoObjectPaths } from "@/lib/images/sizes";
import { log, reportError } from "@/lib/observability";

export const WRONG_PASSWORD = "That password isn't right";

/**
 * Deletes an account after re-checking its password. The data goes first
 * (one auth-user delete; the database cascades the rest, see
 * 0012_account_deletion.sql), then the stored images. A failed image removal
 * is reported to monitoring rather than undoing a deletion the user asked for;
 * the paths are in the report so they can be removed by hand.
 */
export async function deleteAccount(userId: string, email: string, password: string): Promise<void> {
  if (getDataMode() === "supabase") await deleteSupabaseAccount(userId, email, password);
  else await deleteDemoAccountWithPassword(userId, password);
  // The id (nothing else) is logged so a restore from an older backup can
  // re-apply deletions made since (docs/runbooks/backup-and-restore.md).
  log("info", "account deleted", { userId });
}

async function deleteDemoAccountWithPassword(userId: string, password: string) {
  const { getDemoStore, verifyPassword } = await import("@/lib/data/demo/store");
  const { deleteDemoAccount } = await import("@/lib/data/demo/account");
  const { createDemoRepository } = await import("@/lib/data/demo/repository");
  const handle = getDemoStore();
  const user = handle.state.authUsers.find((u) => u.id === userId);
  if (!user || !verifyPassword(password, user.passwordHash)) throw new DataError(WRONG_PASSWORD, "forbidden");
  const objects = deleteDemoAccount(handle, userId);
  const repo = createDemoRepository(handle);
  await Promise.allSettled([
    ...objects.placePhotos.map((p) => repo.storage.removeImage("places", p)),
    ...objects.avatars.map((p) => repo.storage.removeImage("avatars", p)),
  ]);
}

async function deleteSupabaseAccount(userId: string, email: string, password: string) {
  const { createSupabaseAdminClient, createSupabaseStatelessClient } = await import("@/lib/supabase/admin");
  // Re-check the password on a client with no cookies, so a typo cannot
  // disturb the session the user is still signed in with.
  const check = await createSupabaseStatelessClient().auth.signInWithPassword({ email, password });
  if (check.error || check.data.user?.id !== userId) throw new DataError(WRONG_PASSWORD, "forbidden");

  const admin = createSupabaseAdminClient();
  const attached = await admin.rpc("account_storage_paths", { p_user_id: userId });
  if (attached.error) throw new DataError("Could not prepare the deletion. Nothing was deleted.", "unavailable");
  const photoPaths = ((attached.data ?? []) as { storage_path: string }[]).flatMap((r) => photoObjectPaths(r.storage_path));
  const folderObjects = async (bucket: string) => {
    const names: string[] = [];
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await admin.storage.from(bucket).list(userId, { limit: 1000, offset });
      if (error) throw error;
      names.push(...(data ?? []).map((o) => `${userId}/${o.name}`));
      if (!data || data.length < 1000) return names;
    }
  };
  const [ownPhotos, ownAvatars] = await Promise.all([folderObjects(PLACE_PHOTO_BUCKET), folderObjects("avatars")]).catch(() => [[], []] as string[][]);

  const deleted = await admin.auth.admin.deleteUser(userId);
  if (deleted.error) throw new DataError("Could not delete the account. Nothing was deleted.", "unavailable");

  const remove = async (bucket: string, paths: string[]) => {
    for (let i = 0; i < paths.length; i += 100) {
      const { error } = await admin.storage.from(bucket).remove(paths.slice(i, i + 100));
      if (error) reportError(error, { where: "account-deletion", bucket, paths: paths.slice(i, i + 100) });
    }
  };
  await remove(PLACE_PHOTO_BUCKET, [...new Set([...photoPaths, ...ownPhotos])]);
  await remove("avatars", ownAvatars);
}
