import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { featureEnabled, DEFAULT_CENTER } from "@/lib/config";
import { requireViewer } from "@/lib/auth/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { TripPlanner } from "@/components/trips/TripPlanner";

export const metadata: Metadata = { title: "Plan my day" };
export const dynamic = "force-dynamic";

/** Hidden unless the tripPlanning flag and ANTHROPIC_API_KEY are both set. */
export default async function PlanPage() {
  if (!featureEnabled("tripPlanning")) notFound();
  const viewer = await requireViewer("/plan");
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Plan" title="Plan my day" subtitle="A plan built from places locals added, starting with the ones you saved. Every stop links to a real listing." />
      <TripPlanner defaultInterests={viewer.profile.interests} start={{ ...{ lat: DEFAULT_CENTER.lat, lng: DEFAULT_CENTER.lng }, label: viewer.profile.homeCity ? `Central ${viewer.profile.homeCity}` : "Downtown" }} />
    </div>
  );
}
