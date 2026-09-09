import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { ProfileView } from "@/components/profile/ProfileView";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/u/[username]">): Promise<Metadata> {
  const { username } = await params;
  return { title: `@${username}` };
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
