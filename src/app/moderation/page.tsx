import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { DataError } from "@/lib/data/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { DATE_TIME, TARGET_LABEL, reasonLabel } from "@/components/moderation/labels";

export const metadata: Metadata = { title: "Moderation" };
export const dynamic = "force-dynamic";

/** Open reports grouped by what they are about, oldest first. Moderators only; everyone else gets a 404. */
export default async function ModerationQueuePage({ searchParams }: { searchParams: Promise<{ cursor?: string }> }) {
  const viewer = await requireViewer("/moderation");
  const repo = await getRepository();
  if (!(await repo.moderation.isModerator(viewer.id))) notFound();

  const { cursor } = await searchParams;
  let page;
  try {
    page = await repo.moderation.queue(viewer.id, { cursor: cursor ?? null });
  } catch (err) {
    // A tampered cursor starts over rather than failing the page.
    if (err instanceof DataError && err.code === "invalid") page = await repo.moderation.queue(viewer.id);
    else throw err;
  }

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Moderation" title="Report queue" subtitle="Open reports, grouped by what they're about. Oldest first." />
      {page.items.length ? (
        <ul className="flex flex-col gap-2 list-none p-0 m-0">
          {page.items.map((item) => (
            <li key={`${item.targetType}:${item.targetId}`}>
              <Link href={`/moderation/${item.targetType}/${item.targetId}`} className="card p-4 block hover:border-ink transition-colors">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                      {TARGET_LABEL[item.targetType]}
                      {item.targetStatus && item.targetStatus !== "published" && item.targetStatus !== "active" ? ` · ${item.targetStatus}` : ""}
                    </p>
                    <p className="font-bold break-words">{item.targetLabel ?? "Deleted since it was reported"}</p>
                  </div>
                  <span className="shrink-0 rounded-full bg-danger-100 text-danger px-2.5 py-1 text-xs font-bold">
                    {item.reportCount} open
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {item.reasons.map((r) => (
                    <span key={r} className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-ink-2">{reasonLabel(r)}</span>
                  ))}
                </div>
                <p className="mt-2 text-xs text-muted">
                  First reported {DATE_TIME.format(new Date(item.firstReportedAt))}
                  {item.reportCount > 1 ? ` · latest ${DATE_TIME.format(new Date(item.lastReportedAt))}` : ""}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState emoji="🧹" title={cursor ? "No more open reports" : "Queue is clear"} body="Nothing is waiting for review." />
      )}
      <nav className="mt-6 flex justify-between gap-2" aria-label="Queue pages">
        {cursor ? <Link href="/moderation" className="chip">First page</Link> : <span />}
        {page.nextCursor ? <Link href={`/moderation?cursor=${encodeURIComponent(page.nextCursor)}`} className="chip">Next page</Link> : null}
      </nav>
      <p className="mt-8 text-xs text-muted inline-flex items-center gap-1.5">
        <ShieldCheck size={14} /> Every decision is recorded with your name and reason. Reporters see only that their report was resolved.
      </p>
    </div>
  );
}
