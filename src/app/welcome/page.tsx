import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { LOCAL_MIN_ACCOUNT_AGE_DAYS } from "@/lib/data/types";
import { localEligibleAt } from "@/lib/data/localTier";
import { WelcomeFlow } from "@/components/onboarding/WelcomeFlow";

export const metadata: Metadata = { title: "Welcome" };
export const dynamic = "force-dynamic";

/** First run, once. Finished or skipped, it sends people straight to the map. */
export default async function WelcomePage() {
  const viewer = await requireViewer("/welcome");
  if (viewer.profile.onboardedAt) redirect("/");
  const repo = await getRepository();
  const people = await repo.profiles.suggest(viewer.id, 12);
  return (
    <WelcomeFlow
      displayName={viewer.profile.displayName}
      initialInterests={viewer.profile.interests}
      initialHomeCity={viewer.profile.homeCity}
      localFrom={localEligibleAt(viewer.profile.createdAt)}
      localDays={LOCAL_MIN_ACCOUNT_AGE_DAYS}
      people={people.map((p) => ({ id: p.id, username: p.username, displayName: p.displayName, avatarUrl: p.avatarUrl, interests: p.interests }))}
    />
  );
}
