import "server-only";
import { getDataMode } from "@/lib/config";
import { DataError } from "@/lib/data/types";
import { log, reportError } from "@/lib/observability";
import { runAccountDeletion, supabaseDeletionPort } from "./accountDeletionJobs";

export const WRONG_PASSWORD = "That password isn't right";

/**
 * Re-checks the password before starting a durable, retryable deletion.
 * Billing and stored objects are cleaned before Auth deletion and cascades.
 */
export async function deleteAccount(userId: string, email: string, password: string): Promise<void> {
  if (getDataMode() === "supabase") await deleteSupabaseAccount(userId, email, password);
  else await deleteDemoAccountWithPassword(userId, password);
  // The id (nothing else) is logged so a restore from an older backup can
  // re-apply deletions made since (docs/runbooks/backup-and-restore.md).
  if (getDataMode() === "demo") log("info", "account deleted", { userId });
}

async function deleteDemoAccountWithPassword(userId: string, password: string) {
  const { getDemoStore, verifyPassword } = await import("@/lib/data/demo/store");
  const { deleteDemoAccount } = await import("@/lib/data/demo/account");
  const { createDemoRepository } = await import("@/lib/data/demo/repository");
  const handle = getDemoStore();
  const user = handle.state.authUsers.find((u) => u.id === userId);
  if (!user || !verifyPassword(password, user.passwordHash)) throw new DataError(WRONG_PASSWORD, "forbidden");
  // Keep the live store's paths until file cleanup succeeds so retries can find them.
  const objects = deleteDemoAccount({ ...handle, state: structuredClone(handle.state), persist: () => {} }, userId);
  const repo = createDemoRepository(handle);
  await Promise.all([
    ...objects.placePhotos.map((p) => repo.storage.removeImage("places", p)),
    ...objects.avatars.map((p) => repo.storage.removeImage("avatars", p)),
  ]);
  deleteDemoAccount(handle, userId);
  // No real money moves in demo mode; settle queued future-event refunds.
  for (const ticket of await repo.payments.ticketsToRefund()) await repo.payments.markRefunded(ticket.paymentIntentId);
}

async function deleteSupabaseAccount(userId: string, email: string, password: string) {
  const { createSupabaseAdminClient, createSupabaseStatelessClient } = await import("@/lib/supabase/admin");
  // Re-check the password on a client with no cookies, so a typo cannot
  // disturb the session the user is still signed in with.
  const check = await createSupabaseStatelessClient().auth.signInWithPassword({ email, password });
  if (check.error || check.data.user?.id !== userId) throw new DataError(WRONG_PASSWORD, "forbidden");

  let started = false;
  try {
    const admin = createSupabaseAdminClient();
    const prepared = await admin.rpc("prepare_account_deletion", { p_user: userId });
    if (prepared.error) throw prepared.error;
    started = true;
    const complete = await runAccountDeletion(userId, supabaseDeletionPort(admin));
    if (!complete) throw new DataError("Account deletion is already in progress. Cleanup will retry automatically.", "unavailable");
  } catch (err) {
    reportError(err, { where: "account-deletion", userId });
    if (err instanceof DataError) throw err;
    throw new DataError(started
      ? "Account deletion could not finish. Cleanup will retry automatically; you can also try again. Some cleanup may already be complete."
      : "Could not confirm that account deletion started. Please try again.", "unavailable");
  }
}
