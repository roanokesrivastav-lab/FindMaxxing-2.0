import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type Stripe from "stripe";
import { getDataMode } from "@/lib/config";
import { reportError, log } from "@/lib/observability";
import { getStripe, cancelSubscription, type StripeLike } from "@/server/payments/stripe";

export interface DeletionJob {
  user_id: string;
  storage_paths: { bucket: string; path: string }[];
  removed_storage_paths?: { bucket: string; path: string }[];
  stripe_customer_id: string | null;
  stripe_subscription_ids: string[];
  canceled_subscription_ids?: string[];
  billing_complete: boolean;
  storage_complete: boolean;
  lease_token: string;
}
export interface DeletionPatch {
  subscriptions?: string[];
  canceled?: string[];
  removed?: { bucket: string; path: string }[];
  billing?: boolean;
  storage?: boolean;
  complete?: boolean;
  release?: boolean;
}
/** Small boundary for failure-injection tests; production uses service-role APIs. */
export interface DeletionPort {
  claim(userId: string): Promise<DeletionJob | null>;
  save(job: DeletionJob, patch: DeletionPatch): Promise<void>;
  closeBilling(job: DeletionJob): Promise<void>;
  remove(bucket: string, paths: string[]): Promise<void>;
  deleteAuth(userId: string): Promise<void>;
}

/** Retry the persisted steps; no password or user session is stored in the job. */
export async function runAccountDeletion(userId: string, port: DeletionPort): Promise<boolean> {
  const job = await port.claim(userId);
  if (!job) return false; // another worker owns it, or it is already complete
  try {
    if (!job.billing_complete) {
      await port.closeBilling(job);
      await port.save(job, { billing: true });
    }
    if (!job.storage_complete) {
      const buckets = new Map<string, string[]>();
      const done = new Set((job.removed_storage_paths ?? []).map((p) => JSON.stringify([p.bucket, p.path])));
      for (const { bucket, path } of job.storage_paths) {
        if (done.has(JSON.stringify([bucket, path]))) continue;
        const paths = buckets.get(bucket);
        if (paths) paths.push(path); else buckets.set(bucket, [path]);
      }
      for (const [bucket, paths] of buckets) {
        for (let i = 0; i < paths.length; i += 100) {
          const batch = paths.slice(i, i + 100);
          await port.remove(bucket, batch);
          // Persist completion and renew the fenced lease after each bounded batch.
          await port.save(job, { removed: batch.map((path) => ({ bucket, path })) });
        }
      }
      await port.save(job, { storage: true });
    }
    await port.deleteAuth(userId);
    await port.save(job, { complete: true });
    log("info", "account deleted", { userId });
    return true;
  } finally {
    // A failed release still has a finite lease; cron can recover after expiry.
    await port.save(job, { release: true }).catch(() => undefined);
  }
}

export function supabaseDeletionPort(admin: SupabaseClient): DeletionPort {
  const save = async (job: DeletionJob, patch: DeletionPatch) => {
    const { error } = await admin.rpc("save_account_deletion_progress", { p_user: job.user_id, p_lease: job.lease_token, p_patch: patch });
    if (error) throw error;
  };
  return {
    async claim(userId) {
      const { data, error } = await admin.rpc("claim_account_deletion", { p_user: userId });
      if (error) throw error;
      return (data as DeletionJob[] | null)?.[0] ?? null;
    },
    save,
    async closeBilling(job) {
      if (!job.stripe_customer_id && !job.stripe_subscription_ids.length) return;
      const stripe = await getStripe();
      if (!stripe) throw new Error("Stripe credentials are required to stop this account's billing");
      await closeAccountBilling(job, stripe, (subscriptions) => save(job, { subscriptions }), (id) => save(job, { canceled: [id] }));
    },
    async remove(bucket, paths) {
      const { error } = await admin.storage.from(bucket).remove(paths);
      if (error) throw error;
    },
    async deleteAuth(userId) {
      const check = await admin.auth.admin.getUserById(userId);
      if (check.error?.code === "user_not_found") return; // previous attempt succeeded but its response was lost
      if (check.error) throw check.error;
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error && error.code !== "user_not_found") throw error;
    },
  };
}

/** Inventory ALL subscriptions, including duplicates not represented by one entitlement row. */
export async function closeAccountBilling(job: DeletionJob, stripe: StripeLike, persist: (subscriptions: string[]) => Promise<void>, checkpoint: (id: string) => Promise<void> = async () => {}): Promise<void> {
  const ids = new Set(job.stripe_subscription_ids);
  if (job.stripe_customer_id) {
    // Expire open subscription checkouts so they cannot start billing later.
    let after: string | undefined;
    do {
      const page: Stripe.ApiList<Stripe.Checkout.Session> = await stripe.checkout.sessions.list({ customer: job.stripe_customer_id, status: "open", limit: 100, ...(after ? { starting_after: after } : {}) });
      for (const session of page.data) if (session.mode === "subscription") {
        try { await stripe.checkout.sessions.expire(session.id); }
        catch (err) {
          const current = await stripe.checkout.sessions.retrieve(session.id);
          if (current.status === "complete" && current.subscription) ids.add(typeof current.subscription === "string" ? current.subscription : current.subscription.id);
          else if (current.status !== "expired") throw err;
        }
      }
      after = page.has_more ? page.data.at(-1)?.id : undefined;
      if (page.has_more && !after) throw new Error("Incomplete checkout inventory");
    } while (after);
    after = undefined;
    do {
      const page: Stripe.ApiList<Stripe.Subscription> = await stripe.subscriptions.list({ customer: job.stripe_customer_id, status: "all", limit: 100, ...(after ? { starting_after: after } : {}) });
      for (const sub of page.data) ids.add(sub.id);
      after = page.has_more ? page.data.at(-1)?.id : undefined;
      if (page.has_more && !after) throw new Error("Incomplete subscription inventory");
    } while (after);
  }
  await persist([...ids]); // durable before cancellation; keep identifiers on a timeout
  const done = new Set(job.canceled_subscription_ids ?? []);
  for (const id of ids) {
    if (done.has(id)) continue;
    await cancelSubscription(stripe, id, job.user_id);
    await checkpoint(id);
  }
}

/** Uses the existing authenticated payments cron even when feature flags are off. */
export async function resumeAccountDeletions(): Promise<{ completed: number; failed: number }> {
  if (getDataMode() !== "supabase") return { completed: 0, failed: 0 };
  const { createSupabaseAdminClient } = await import("@/lib/supabase/admin");
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin.from("account_deletion_jobs").select("user_id").is("completed_at", null)
    .order("updated_at").limit(10);
  if (error) throw error;
  const result = { completed: 0, failed: 0 };
  for (const row of data ?? []) {
    try {
      if (await runAccountDeletion(row.user_id, supabaseDeletionPort(admin))) result.completed += 1;
    } catch (err) {
      result.failed += 1;
      reportError(err, { where: "account-deletion-retry", userId: row.user_id });
    }
  }
  return result;
}
