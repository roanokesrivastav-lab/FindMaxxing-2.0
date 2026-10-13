import Link from "next/link";
import { featureEnabled } from "@/lib/config";
import { ResetReputationControl } from "@/components/moderation/ResetReputationControl";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { uuidSchema } from "@/lib/validation/schemas";
import type { ReportTargetType } from "@/lib/data/types";
import { BackButton } from "@/components/ui/BackButton";
import { ModerationActions } from "@/components/moderation/ModerationActions";
import { LocalStatusControl } from "@/components/moderation/LocalStatusControl";
import { ACTION_LABEL, DATE_TIME, TARGET_LABEL, publicHref, reasonLabel } from "@/components/moderation/labels";

export const metadata: Metadata = { title: "Review report" };
export const dynamic = "force-dynamic";

const TYPES: ReportTargetType[] = ["place", "event", "profile", "message"];

export default async function ModerationTargetPage({ params }: { params: Promise<{ type: string; id: string }> }) {
  const { type, id } = await params;
  const viewer = await requireViewer(`/moderation/${type}/${id}`);
  const repo = await getRepository();
  if (!(await repo.moderation.isModerator(viewer.id))) notFound();
  if (!TYPES.includes(type as ReportTargetType) || !uuidSchema.safeParse(id).success) notFound();
  const targetType = type as ReportTargetType;
  const detail = await repo.moderation.target(viewer.id, targetType, id);
  if (!detail) notFound();

  const { snapshot, reports, history } = detail;
  const level = targetType === "profile" ? (await repo.profiles.getById(id))?.reputationLevel ?? null : null;
  const open = reports.filter((r) => r.status === "open").length;
  const href = snapshot ? publicHref(targetType, id, snapshot.ownerUsername) : null;

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="mb-4">
        <BackButton fallback="/moderation" />
      </div>

      <section className="card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">
          {TARGET_LABEL[targetType]}
          {snapshot ? ` · ${snapshot.status}` : ""}
          {snapshot?.visibility && snapshot.visibility !== "public" ? ` · ${snapshot.visibility === "locals" ? "locals only" : snapshot.visibility}` : ""}
        </p>
        <h1 className="text-2xl font-bold break-words">{snapshot?.label ?? "Deleted since it was reported"}</h1>
        {snapshot ? (
          <>
            {snapshot.ownerUsername ? (
              <p className="text-sm text-muted mt-1">
                {targetType === "profile" ? "" : "By "}
                <Link href={`/u/${snapshot.ownerUsername}`} className="font-semibold hover:text-ink">@{snapshot.ownerUsername}</Link>
                {snapshot.city ? ` · ${snapshot.city}` : ""}
              </p>
            ) : null}
            {snapshot.body ? <p className="mt-3 text-[15px] leading-relaxed whitespace-pre-line break-words">{snapshot.body}</p> : null}
            {snapshot.extra ? <p className="mt-2 text-sm text-ink-2 break-words">{targetType === "place" ? "Local tip: " : "Where: "}{snapshot.extra}</p> : null}
            {href && snapshot.status !== "removed" ? (
              <p className="mt-3 text-sm"><Link href={href} className="font-semibold underline underline-offset-4">Open the public page</Link></p>
            ) : null}
          </>
        ) : null}
      </section>

      {snapshot ? (
        <section className="mt-5">
          {targetType === "profile" ? (
            <div className="flex flex-col gap-3">
              {open ? <ModerationActions targetType={targetType} targetId={id} status={snapshot.status} openReports={open} /> : null}
              <LocalStatusControl userId={id} revoked={snapshot.status === "revoked"} />
              {featureEnabled("reputation") && level ? <ResetReputationControl userId={id} level={level} /> : null}
            </div>
          ) : (
            <ModerationActions targetType={targetType} targetId={id} status={snapshot.status} openReports={open} />
          )}
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-lg font-bold mb-2">Reports ({reports.length})</h2>
        <ul className="flex flex-col gap-2 list-none p-0 m-0">
          {reports.map((r) => (
            <li key={r.id} className="card p-4">
              <div className="flex items-start justify-between gap-3">
                <p className="text-sm font-semibold">{reasonLabel(r.reason)}</p>
                <span className="shrink-0 text-xs font-bold uppercase tracking-wide text-muted">{r.status}</span>
              </div>
              {r.details ? <p className="mt-1 text-sm text-ink-2 break-words">{r.details}</p> : null}
              <p className="mt-2 text-xs text-muted">
                {r.reporter ? <>From <Link href={`/u/${r.reporter.username}`} className="font-semibold hover:text-ink">@{r.reporter.username}</Link> · </> : "From a deleted account · "}
                {DATE_TIME.format(new Date(r.createdAt))}
                {r.resolvedAt ? ` · resolved ${DATE_TIME.format(new Date(r.resolvedAt))}` : ""}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-bold mb-2">History</h2>
        {history.length ? (
          <ol className="flex flex-col gap-2 list-none p-0 m-0">
            {history.map((h) => (
              <li key={h.id} className="rounded-xl bg-surface-2 px-4 py-3">
                <p className="text-sm font-semibold">{ACTION_LABEL[h.action]}</p>
                {h.reason ? <p className="text-sm text-ink-2 mt-0.5 break-words">“{h.reason}”</p> : null}
                <p className="text-xs text-muted mt-1">
                  {h.moderator ? `@${h.moderator.username}` : "A former moderator"} · {DATE_TIME.format(new Date(h.createdAt))}
                  {h.statusBefore !== h.statusAfter ? ` · ${h.statusBefore ?? "—"} → ${h.statusAfter ?? "—"}` : ""}
                  {h.resolvedReports ? ` · ${h.resolvedReports} report${h.resolvedReports === 1 ? "" : "s"} resolved` : ""}
                </p>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">No moderation actions yet.</p>
        )}
      </section>
    </div>
  );
}
