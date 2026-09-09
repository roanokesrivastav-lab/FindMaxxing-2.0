import type { Metadata } from "next";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { PersonCard } from "@/components/profile/PersonCard";
import { FollowButton } from "@/components/profile/FollowButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import Link from "next/link";

export const metadata: Metadata = { title: "People" };
export const dynamic = "force-dynamic";

export default async function PeoplePage() {
  const [repo, viewer] = await Promise.all([getRepository(), getViewer()]);
  const [suggested, following] = await Promise.all([
    repo.profiles.suggest(viewer?.id ?? null, 12),
    viewer ? repo.profiles.listFollowing(viewer.id) : Promise.resolve([]),
  ]);
  const mine = new Set(viewer?.profile.interests ?? []);
  const followingProfiles = (await Promise.all(following.map((f) => repo.profiles.getById(f.id)))).filter((p): p is NonNullable<typeof p> => !!p);

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Meet locals" title="People" subtitle={viewer ? "Matched on shared interests. Follow to keep up with what they add." : "Sign in to get suggestions based on your interests."} />

      {!viewer ? (
        <div className="mb-5">
          <EmptyState
            emoji="🤝"
            title="Find your people"
            body="Add your interests and we'll show you locals who are into the same things."
            action={
              <Link href="/auth/sign-up?next=/people" className="chip" data-active="true">
                Create account
              </Link>
            }
          />
        </div>
      ) : null}

      <section>
        <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">Suggested</h2>
        <div className="flex flex-col gap-2">
          {suggested.map((p) => (
            <PersonCard
              key={p.id}
              profile={p}
              sharedInterests={p.interests.filter((i) => mine.has(i))}
              action={<FollowButton userId={p.id} following={false} signedIn={!!viewer} size="sm" />}
            />
          ))}
          {suggested.length === 0 ? <p className="text-sm text-muted">You&apos;re following everyone we&apos;d suggest. Nice.</p> : null}
        </div>
      </section>

      {viewer && followingProfiles.length ? (
        <section className="mt-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">Following · {followingProfiles.length}</h2>
          <div className="flex flex-col gap-2">
            {followingProfiles.map((p) => (
              <PersonCard key={p.id} profile={p} action={<FollowButton userId={p.id} following signedIn size="sm" />} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
