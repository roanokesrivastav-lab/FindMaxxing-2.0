import type { Metadata } from "next";
import { Search, X } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { PersonCard } from "@/components/profile/PersonCard";
import { FollowButton } from "@/components/profile/FollowButton";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { searchQuerySchema } from "@/lib/validation/schemas";
import Link from "next/link";

export const metadata: Metadata = { title: "People" };
export const dynamic = "force-dynamic";

export default async function PeoplePage({ searchParams }: PageProps<"/people">) {
  const [repo, viewer, sp] = await Promise.all([getRepository(), getViewer(), searchParams]);
  const q = searchQuerySchema.parse(typeof sp.q === "string" ? sp.q : "");
  const [suggested, following, results] = await Promise.all([
    repo.profiles.suggest(viewer?.id ?? null, 12),
    viewer ? repo.profiles.listFollowing(viewer.id) : Promise.resolve([]),
    q ? repo.profiles.search(q, 30) : Promise.resolve([]),
  ]);
  const mine = new Set(viewer?.profile.interests ?? []);
  const followingIds = new Set(following.map((f) => f.id));
  const followingProfiles = (await Promise.all(following.map((f) => repo.profiles.getById(f.id)))).filter((p): p is NonNullable<typeof p> => !!p);

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Meet locals" title="People" subtitle={viewer ? "Matched on shared interests. Follow to keep up with what they add." : "Sign in to get suggestions based on your interests."} />

      <form action="/people" method="get" role="search" className="mb-6">
        <label className="flex items-center gap-2 h-12 rounded-full bg-surface border border-line shadow-card px-4 focus-within:border-ink transition-colors">
          <Search size={18} className="text-muted shrink-0" aria-hidden />
          <input
            type="search"
            name="q"
            defaultValue={q}
            maxLength={60}
            placeholder="Search by name, username or city"
            aria-label="Search people"
            className="flex-1 bg-transparent outline-none text-[15px] placeholder:text-muted min-w-0"
            autoComplete="off"
          />
          {q ? (
            <Link href="/people" aria-label="Clear search" className="text-muted hover:text-ink">
              <X size={16} />
            </Link>
          ) : null}
          <button type="submit" className="h-8 px-3 rounded-full bg-ink text-white text-sm font-semibold shrink-0">
            Search
          </button>
        </label>
      </form>

      {q ? (
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">
            {results.length ? `${results.length} ${results.length === 1 ? "match" : "matches"} for “${q}”` : `Results for “${q}”`}
          </h2>
          {results.length ? (
            <div className="flex flex-col gap-2">
              {results.map((p) => (
                <PersonCard
                  key={p.id}
                  profile={p}
                  sharedInterests={p.interests.filter((i) => mine.has(i))}
                  action={
                    viewer?.id === p.id ? (
                      <Link href="/profile" className="text-xs font-semibold text-muted shrink-0">
                        You
                      </Link>
                    ) : (
                      <FollowButton userId={p.id} following={followingIds.has(p.id)} signedIn={!!viewer} size="sm" />
                    )
                  }
                />
              ))}
            </div>
          ) : (
            <EmptyState
              emoji="🔍"
              title={`Nobody matches “${q}”`}
              body="Try a shorter name, a username, or a city."
              action={
                <Link href="/people" className="chip" data-active="true">
                  Clear search
                </Link>
              }
            />
          )}
        </section>
      ) : null}

      {!viewer && !q ? (
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
