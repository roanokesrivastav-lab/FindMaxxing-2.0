import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { DEFAULT_CENTER, featureEnabled } from "@/lib/config";
import { EVENT_CATEGORIES } from "@/lib/data/taxonomy";
import { BackButton } from "@/components/ui/BackButton";
import { NeedPlayersForm } from "@/components/events/NeedPlayersForm";

export const metadata: Metadata = { title: "Need-players alerts" };
export const dynamic = "force-dynamic";

/** Roadmap R2 (pilotEvents): opt in to alerts when a nearby session still needs players. */
export default async function NeedPlayersAlertsPage() {
  if (!featureEnabled("pilotEvents")) notFound();
  const viewer = await requireViewer("/events/alerts");
  const repo = await getRepository();
  const settings = await repo.events.needPlayerAlerts(viewer.id);
  return (
    <div className="treatment-utility max-w-2xl mx-auto px-edge md:px-6 pt-row pb-nav md:pb-10">
      <BackButton fallback="/events" />
      <h1 className="type-page-title text-ink mt-row">Need-players alerts</h1>
      <p className="type-body text-ink-2 mt-hair mb-section">Hear when a session near you is close to happening and still needs a few more people. Off unless you turn it on.</p>
      <NeedPlayersForm initial={settings} categories={EVENT_CATEGORIES.map((c) => ({ slug: c.slug, label: c.label }))} defaultCenter={DEFAULT_CENTER} />
    </div>
  );
}
