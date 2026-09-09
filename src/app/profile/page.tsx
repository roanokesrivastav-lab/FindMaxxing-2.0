import type { Metadata } from "next";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { ProfileView } from "@/components/profile/ProfileView";
import { EmptyState } from "@/components/ui/EmptyState";
import { ButtonLink } from "@/components/ui/Button";
import { PageHeader } from "@/components/ui/PageHeader";
import { Logo } from "@/components/layout/Logo";

export const metadata: Metadata = { title: "Profile" };
export const dynamic = "force-dynamic";

export default async function MyProfilePage() {
  const viewer = await getViewer();
  if (!viewer) {
    return (
      <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav">
        <div className="md:hidden mb-6">
          <Logo size={28} />
        </div>
        <PageHeader eyebrow="You" title="Your profile" />
        <EmptyState
          emoji="👋"
          title="Join FindMaxxing"
          body="Save places, add local knowledge, host events and follow people who are into the same things."
          action={
            <div className="flex gap-2">
              <ButtonLink href="/auth/sign-up" variant="primary">
                Create account
              </ButtonLink>
              <ButtonLink href="/auth/sign-in" variant="secondary">
                Sign in
              </ButtonLink>
            </div>
          }
        />
      </div>
    );
  }
  const repo = await getRepository();
  const [stats, activity] = await Promise.all([repo.profiles.stats(viewer.id), repo.profiles.activity(viewer.id, viewer.id)]);
  return <ProfileView profile={viewer.profile} stats={stats} activity={activity} isSelf viewerSignedIn viewerFollows={false} />;
}
