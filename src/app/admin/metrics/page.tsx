import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { featureEnabled } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";

export const metadata: Metadata = { title: "Metrics" };
export const dynamic = "force-dynamic";

const STEP_LABEL: Record<string, string> = {
  view_place: "Viewed a place",
  save_place: "Saved a place",
  add_to_list: "Added to a list",
  contribute_place: "Added a place",
  create_event: "Created an event",
  join_event: "Joined an event",
  follow: "Followed someone",
};

/** One value per row, its bar scaled to the largest; the number is always printed. */
function BarTable({ caption, rows, unit }: { caption: string; rows: { label: string; value: number; detail?: string }[]; unit: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <table className="w-full text-sm border-separate border-spacing-y-1.5">
      <caption className="sr-only">{caption}</caption>
      <thead className="sr-only">
        <tr><th scope="col">Step</th><th scope="col">{unit}</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.label}>
            <th scope="row" className="text-left font-medium text-ink-2 pr-3 w-40 align-middle">{r.label}</th>
            <td className="align-middle">
              <div className="flex items-center gap-2">
                <span className="h-3 rounded-[4px] bg-ink/70" style={{ width: `${(r.value / max) * 100}%`, minWidth: r.value ? 4 : 0 }} aria-hidden />
                <span className="tabular-nums font-semibold">{r.value}</span>
                {r.detail ? <span className="text-xs text-muted whitespace-nowrap">{r.detail}</span> : null}
              </div>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Admins only (404 for everyone else). First-party, pseudonymous: no one is identifiable here. */
export default async function MetricsPage() {
  const viewer = await requireViewer("/admin/metrics");
  const repo = await getRepository();
  if (!(await repo.admin.isAdmin(viewer.id))) notFound();
  const to = new Date();
  const from = new Date(to.getTime() - 30 * 86_400_000);
  const [funnel, weekly, sources, hits] = await Promise.all([
    repo.analytics.funnel(viewer.id, from.toISOString(), to.toISOString()),
    repo.analytics.weeklyContributors(viewer.id, 12),
    repo.analytics.saveSources(viewer.id, from.toISOString(), to.toISOString()),
    repo.admin.rateLimitHits(viewer.id),
  ]);
  const totalSaves = sources.community + sources.seed;
  const share = totalSaves ? Math.round((sources.community / totalSaves) * 100) : null;
  const tracking = featureEnabled("analytics");

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Admin" title="Metrics" subtitle="Last 30 days. People appear only as anonymous counts." />
      {!tracking ? (
        <p className="card p-4 text-sm text-ink-2 mb-5">Analytics is switched off (NEXT_PUBLIC_FEATURES), so the funnel and contributors stay empty. The save split below comes from saves themselves.</p>
      ) : null}

      <section className="card p-5" aria-labelledby="thesis-heading">
        <h2 id="thesis-heading" className="text-sm font-semibold text-muted">Saves that went to community-added places</h2>
        <p className="font-display text-4xl font-bold mt-1">{share === null ? "—" : `${share}%`}</p>
        <p className="text-sm text-ink-2 mt-1">
          {sources.community} of {totalSaves} saves went to places people added; {sources.seed} to seed data. This is the thesis metric: local knowledge should win.
        </p>
      </section>

      <section className="card p-5 mt-5" aria-labelledby="funnel-heading">
        <h2 id="funnel-heading" className="font-bold mb-2">Core loop</h2>
        <p className="text-xs text-muted mb-2">Distinct people who did each step at least once.</p>
        <BarTable caption="Core loop funnel" unit="People" rows={funnel.map((f) => ({ label: STEP_LABEL[f.step] ?? f.step, value: f.actors, detail: `${f.events} event${f.events === 1 ? "" : "s"}` }))} />
      </section>

      <section className="card p-5 mt-5" aria-labelledby="weekly-heading">
        <h2 id="weekly-heading" className="font-bold mb-2">Weekly active contributors</h2>
        <p className="text-xs text-muted mb-2">People who added a place, created an event or rated, per week (Monday start).</p>
        <BarTable caption="Weekly active contributors" unit="Contributors" rows={weekly.map((w) => ({ label: `Week of ${w.weekStart}`, value: w.contributors }))} />
      </section>

      <section className="card p-5 mt-5" aria-labelledby="limits-heading">
        <h2 id="limits-heading" className="font-bold mb-2">Rate-limit hits right now</h2>
        <p className="text-xs text-muted mb-2">People who have used up the current window for each kind of write. A steady number here is a limit set too low, or someone hammering it.</p>
        <BarTable caption="People at their rate limit" unit="People" rows={hits.map((h) => ({ label: h.action, value: h.usersAtLimit, detail: `limit ${h.maxCount} per ${h.windowSeconds >= 86400 ? "day" : "hour"}` }))} />
      </section>
    </div>
  );
}
