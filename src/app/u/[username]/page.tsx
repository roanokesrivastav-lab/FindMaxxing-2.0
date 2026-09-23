import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { ProfileView } from "@/components/profile/ProfileView";
import { shareMetadata } from "@/lib/utils/share-metadata";
import { getInterest } from "@/lib/data/taxonomy";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/u/[username]">): Promise<Metadata> {
  const { username } = await params;
  const repo = await getRepository();
  const profile = await repo.profiles.getByUsername(username);
  if (!profile) return { title: `@${username}` };
  const into = profile.interests.slice(0, 4).map((slug) => getInterest(slug).label).join(", ");
  const facts = [profile.homeCity ? `Local in ${profile.homeCity}` : null, into ? `Into ${into}` : null].filter(Boolean).join(" · ");
  const description = profile.bio || facts || `@${profile.username} on FindMaxxing`;
  return shareMetadata({
    title: `${profile.displayName} (@${profile.username})`,
    description,
    path: `/u/${profile.username}`,
    image: profile.avatarUrl,
    type: "profile",
  });
}

export default async function UserPage({ params }: PageProps<"/u/[username]">) {
  const [{ username }, viewer, repo] = await Promise.all([params, getViewer(), getRepository()]);
  const profile = await repo.profiles.getByUsername(username);
  if (!profile) notFound();
  if (viewer && profile.id === viewer.id) redirect("/profile");
  const [stats, activity, follows] = await Promise.all([
    repo.profiles.stats(profile.id),
    repo.profiles.activity(profile.id, viewer?.id ?? null),
    viewer ? repo.profiles.isFollowing(viewer.id, profile.id) : Promise.resolve(false),
  ]);
  return <ProfileView profile={profile} stats={stats} activity={activity} isSelf={false} viewerSignedIn={!!viewer} viewerFollows={follows} />;
}
