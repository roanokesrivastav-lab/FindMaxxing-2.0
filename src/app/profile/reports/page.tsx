import Link from "next/link";
import type { Metadata } from "next";
import { Flag, Inbox } from "lucide-react";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { BackButton } from "@/components/ui/BackButton";
import { ReportList } from "@/components/shared/ReportList";

export const metadata: Metadata = { title: "Reports" };
export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const viewer = await requireViewer("/profile/reports");
  const repo = await getRepository();
  const [filed, against] = await Promise.all([
    repo.reports.listFiledBy(viewer.id),
    repo.reports.listAgainstMyContent(viewer.id),
  ]);

  const openAgainst = against.filter((r) => r.status === "open").length;

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="mb-4">
        <BackButton fallback="/profile" />
      </div>
      <PageHeader
        eyebrow="Moderation"
        title="Reports"
        subtitle="What you've flagged, and anything flagged on what you've added."
      />

      <section className="mb-8">
        <div className="flex items-center gap-2 mb-2">
          <Inbox size={16} className="text-flare" />
          <h2 className="text-lg font-bold">About your listings</h2>
          {openAgainst > 0 ? (
            <span className="rounded-full bg-danger-100 text-danger text-xs font-bold px-2 py-0.5">{openAgainst} open</span>
          ) : null}
        </div>
        {against.length ? (
          <>
            <p className="text-sm text-muted mb-3">
              Reports are anonymous. If something here is fair, edit the listing or hide it from its page.
            </p>
            <ReportList entries={against} perspective="owner" />
          </>
        ) : (
          <EmptyState
            emoji="✅"
            title="Nothing reported"
            body="No one has flagged a place or event you added."
          />
        )}
      </section>

      <section>
        <div className="flex items-center gap-2 mb-2">
          <Flag size={16} className="text-muted" />
          <h2 className="text-lg font-bold">Reports you filed</h2>
        </div>
        {filed.length ? (
          <ReportList entries={filed} perspective="reporter" />
        ) : (
          <EmptyState
            emoji="🕊️"
            title="You haven't reported anything"
            body="Use the report link on a place or event if something is wrong, closed, or unsafe."
            action={
              <Link href="/" className="chip" data-active="true">
                Explore the map
              </Link>
            }
          />
        )}
      </section>
    </div>
  );
}
