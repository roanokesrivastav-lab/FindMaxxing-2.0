import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { PersonCard } from "@/components/profile/PersonCard";
import { FollowButton } from "@/components/profile/FollowButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { BackButton } from "@/components/ui/BackButton";

export const dynamic = "force-dynamic";

const KINDS = { followers: "Followers", following: "Following" } as const;
type Kind = keyof typeof KINDS;

function parseKind(v: string): Kind | null {
  return v === "followers" || v === "following" ? v : null;
}

export async function generateMetadata({ params }: PageProps<"/u/[username]/[kind]">): Promise<Metadata> {
  const { username, kind } = await params;
  const parsed = parseKind(kind);
  return { title: parsed ? `@${username} · ${KINDS[parsed]}` : "Not found" };
}

export default async function ConnectionsPage({ params }: PageProps<"/u/[username]/[kind]">) {
  const [{ username, kind }, viewer, repo] = await Promise.all([params, getViewer(), getRepository()]);
  const parsed = parseKind(kind);
  if (!parsed) notFound();

  const profile = await repo.profiles.getByUsername(username);
  if (!profile) notFound();

  const entries = await repo.profiles.connections(profile.id, parsed, viewer?.id ?? null);
  const isSelf = viewer?.id === profile.id;

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="mb-4">
        <BackButton fallback={isSelf ? "/profile" : `/u/${profile.username}`} />
      </div>
      <PageHeader
        eyebrow={
          <Link href={isSelf ? "/profile" : `/u/${profile.username}`} className="hover:text-flare-600">
            @{profile.username}
          </Link>
        }
        title={KINDS[parsed]}
        subtitle={
          entries.length
            ? `${entries.length} ${entries.length === 1 ? "person" : "people"}`
            : undefined
        }
        action={
          <div className="flex gap-2">
            <Link href={`/u/${profile.username}/followers`} className="chip" data-active={parsed === "followers" ? "true" : "false"}>
              Followers
            </Link>
            <Link href={`/u/${profile.username}/following`} className="chip" data-active={parsed === "following" ? "true" : "false"}>
              Following
            </Link>
          </div>
        }
      />

      {entries.length ? (
        <div className="flex flex-col gap-2">
          {entries.map(({ profile: p, viewerFollows, isViewer }) => (
            <PersonCard
              key={p.id}
              profile={p}
              action={
                isViewer ? (
                  <span className="text-xs font-semibold text-muted shrink-0">You</span>
                ) : (
                  <FollowButton userId={p.id} following={viewerFollows} signedIn={!!viewer} size="sm" />
                )
              }
            />
          ))}
        </div>
      ) : (
        <EmptyState
          emoji={parsed === "followers" ? "👋" : "🧭"}
          title={
            parsed === "followers"
              ? isSelf
                ? "No followers yet"
                : `Nobody follows @${profile.username} yet`
              : isSelf
                ? "You're not following anyone"
                : `@${profile.username} isn't following anyone`
          }
          body={
            parsed === "following"
              ? "Following people surfaces the places and events they add."
              : "Add a place or host an event and people will find you."
          }
          action={
            <Link href="/people" className="chip" data-active="true">
              Find people
            </Link>
          }
        />
      )}
    </div>
  );
}
