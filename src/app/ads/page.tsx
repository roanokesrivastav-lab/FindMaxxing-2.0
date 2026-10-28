import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { featureEnabled, paymentsMode } from "@/lib/config";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { formatPrice } from "@/lib/data/payments";
import { eventHasEnded } from "@/lib/utils/format";
import { getViewerTime } from "@/lib/time/server";
import type { CampaignStatus } from "@/lib/data/types";
import { PageHeader } from "@/components/ui/PageHeader";
import { CampaignForm } from "@/components/ads/CampaignForm";
import { CampaignActions } from "@/components/ads/CampaignActions";

export const metadata: Metadata = { title: "Sponsored cards" };
export const dynamic = "force-dynamic";

const STATUS: Record<CampaignStatus, string> = {
  pending_review: "Waiting for review",
  rejected: "Not approved",
  awaiting_payment: "Approved: pay to start",
  active: "Running",
  paused: "Paused",
  ended: "Finished",
};

/** For local businesses and organizers: promote your own listing, labeled, to people browsing nearby. */
export default async function AdsPage({ searchParams }: PageProps<"/ads">) {
  if (!featureEnabled("ads") || !paymentsMode()) notFound();
  const viewer = await requireViewer("/ads");
  const sp = await searchParams;
  const repo = await getRepository();
  const { now } = await getViewerTime();
  const [campaigns, places, events] = await Promise.all([
    repo.ads.mine(viewer.id),
    repo.places.listByCreator(viewer.id, viewer.id),
    repo.events.listByCreator(viewer.id, viewer.id),
  ]);
  const listings = [
    ...places.filter((p) => p.status === "published" && p.visibility === "public").map((p) => ({ kind: "place" as const, id: p.id, label: p.name })),
    ...events.filter((e) => e.status === "published" && !eventHasEnded(e.startsAt, e.endsAt, now)).map((e) => ({ kind: "event" as const, id: e.id, label: e.title })),
  ];
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="For local businesses and organizers" title="Sponsored cards" subtitle="One labeled card in a list, shown to people browsing near you. It never changes how anything else ranks." />
      {sp.paid ? <p role="status" className="card p-3 mb-4 text-sm font-semibold">Payment received. Your card starts running{paymentsMode() === "stripe" ? " as soon as Stripe confirms" : ""}.</p> : null}
      {campaigns.length ? (
        <ul className="card divide-y divide-line mb-6" aria-label="Your campaigns">
          {campaigns.map((c) => (
            <li key={c.id} className="px-4 py-3 flex items-center gap-3">
              <span className="flex-1 min-w-0">
                <span className="block font-semibold truncate">{c.headline}</span>
                <span className="block text-xs text-muted">
                  {STATUS[c.status]} · {c.targetLabel ?? "Listing"} · {formatPrice(c.budgetCents)} · {c.delivered.toLocaleString("en-US")} of {c.impressionBudget.toLocaleString("en-US")} views
                </span>
                {c.status === "rejected" && c.reviewNote ? <span className="block text-xs text-danger">“{c.reviewNote}”</span> : null}
              </span>
              <CampaignActions id={c.id} status={c.status} />
            </li>
          ))}
        </ul>
      ) : null}
      <section className="card p-5" aria-labelledby="new-campaign">
        <h2 id="new-campaign" className="font-bold mb-3">New campaign</h2>
        <CampaignForm listings={listings} />
      </section>
    </div>
  );
}
