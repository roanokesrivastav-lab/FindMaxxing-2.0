import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { featureEnabled } from "@/lib/config";
import { formatPrice } from "@/lib/data/payments";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReviewButtons } from "@/components/ads/CampaignActions";
import { requireAdmin, ADMIN_DATE } from "../guard";
import { LocalDate } from "@/components/time/LocalDate";

export const metadata: Metadata = { title: "Sponsored cards · Admin" };
export const dynamic = "force-dynamic";

/** Campaigns waiting for review, oldest first. Approving lets the advertiser pay; rejecting needs a reason. */
export default async function AdReviewPage() {
  const { viewer, repo } = await requireAdmin("/admin/ads");
  if (!featureEnabled("ads")) notFound();
  const queue = await repo.ads.reviewQueue(viewer.id);
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Admin" title="Sponsored cards" subtitle="Local listings only, honest copy, nothing that imitates an organic result." />
      {queue.length === 0 ? (
        <EmptyState emoji="📣" title="Nothing to review" />
      ) : (
        <ul className="flex flex-col gap-3" aria-label="Campaigns to review">
          {queue.map((c) => (
            <li key={c.id} className="card p-4">
              <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Sponsored</p>
              <p className="font-semibold">{c.headline}</p>
              {c.body ? <p className="text-sm text-ink-2">{c.body}</p> : null}
              <p className="text-xs text-muted mt-1">
                <Link href={c.kind === "place" ? `/places/${c.targetId}` : `/events/${c.targetId}`} className="underline underline-offset-4">{c.targetLabel ?? "Listing"}</Link>
                {" "}· {formatPrice(c.budgetCents)} · <LocalDate value={c.startsAt} format={ADMIN_DATE} /> to <LocalDate value={c.endsAt} format={ADMIN_DATE} />
                {" "}· {c.bounds ? "near the listing" : "anywhere"}{c.categorySlug ? ` · ${c.categorySlug}` : ""}
              </p>
              <ReviewButtons id={c.id} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
