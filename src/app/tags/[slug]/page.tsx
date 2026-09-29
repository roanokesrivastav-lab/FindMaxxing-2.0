import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { INTERESTS, INTEREST_MAP } from "@/lib/data/taxonomy";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { BackButton } from "@/components/ui/BackButton";
import { PagedList } from "@/components/shared/PagedList";
import { PersonCard } from "@/components/profile/PersonCard";
import { FollowButton } from "@/components/profile/FollowButton";
import { pluralize } from "@/lib/utils/format";
import { shareMetadata } from "@/lib/utils/share-metadata";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 20;

export async function generateMetadata({ params }: PageProps<"/tags/[slug]">): Promise<Metadata> {
  const { slug } = await params;
  const interest = INTEREST_MAP[slug];
  if (!interest) return { title: "Interest" };
  return shareMetadata({
    title: `${interest.emoji} ${interest.label}`,
    description: `Places, events and people in the city that are into ${interest.label.toLowerCase()}.`,
    path: `/tags/${interest.slug}`,
  });
}

export default async function TagPage({ params }: PageProps<"/tags/[slug]">) {
  const [{ slug }, viewer, repo] = await Promise.all([params, getViewer(), getRepository()]);
  const interest = INTEREST_MAP[slug];
  if (!interest) notFound();

  const viewerId = viewer?.id ?? null;
  const filters = { tags: [interest.slug], viewerId };
  const [placePage, eventPage, tagCounts, people, following] = await Promise.all([
    repo.places.search({ ...filters, limit: PAGE_SIZE }),
    repo.events.search({ ...filters, limit: PAGE_SIZE }),
    repo.tags.counts({ viewerId }),
    repo.profiles.listByInterest(interest.slug, 30),
    viewer ? repo.profiles.listFollowing(viewer.id) : Promise.resolve([]),
  ]);
  const placeCount = tagCounts[interest.slug]?.places ?? 0;
  const eventCount = tagCounts[interest.slug]?.events ?? 0;
  const query = { tags: interest.slug };
  const followingIds = new Set(following.map((f) => f.id));
  const mine = new Set(viewer?.profile.interests ?? []);
  const isMine = mine.has(interest.slug);
  const total = placeCount + eventCount + people.length;

  // Interests that co-occur with this one, most common first. Counted over the
  // first page of each list (the newest places, the soonest events), not every
  // tagged record: an approximation that is plenty for six suggestion chips.
  const related = new Map<string, number>();
  for (const item of [...placePage.items, ...eventPage.items]) {
    for (const t of item.tags) if (t !== interest.slug && INTEREST_MAP[t]) related.set(t, (related.get(t) ?? 0) + 1);
  }
  const relatedSlugs = [...related.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([s]) => s);
  const chips = relatedSlugs.length ? relatedSlugs : INTERESTS.filter((i) => i.slug !== interest.slug).slice(0, 6).map((i) => i.slug);

  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="mb-4">
        <BackButton fallback="/tags" />
      </div>
      <PageHeader
        eyebrow={
          <Link href="/tags" className="hover:text-flare-600">
            Interests
          </Link>
        }
        title={`${interest.emoji} ${interest.label}`}
        subtitle={
          total
            ? [placeCount ? pluralize(placeCount, "place") : null, eventCount ? pluralize(eventCount, "event") : null, people.length ? pluralize(people.length, "person", "people") : null]
                .filter(Boolean)
                .join(" · ")
            : "Nothing tagged with this yet."
        }
        action={
          isMine ? (
            <span className="chip shrink-0" data-active="true">
              One of yours
            </span>
          ) : viewer ? (
            <Link href="/profile/edit" className="chip shrink-0">
              + Add to my interests
            </Link>
          ) : null
        }
      />

      <div className="flex gap-2 overflow-x-auto scrollbar-none -mx-4 px-4 mb-6 snap-x">
        {chips.map((s) => {
          const i = INTEREST_MAP[s];
          return (
            <Link key={s} href={`/tags/${s}`} className="chip shrink-0 snap-start">
              <span aria-hidden>{i.emoji}</span> {i.label}
            </Link>
          );
        })}
        <span className="shrink-0 w-2" aria-hidden />
      </div>

      {total === 0 ? (
        <EmptyState
          emoji={interest.emoji}
          title={`No ${interest.label.toLowerCase()} spots yet`}
          body="Tag a place or event with this interest and it shows up here."
          action={
            <Link href="/places/new" className="chip" data-active="true">
              + Add a place
            </Link>
          }
        />
      ) : null}

      {eventCount ? (
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">Events · {eventCount}</h2>
          <PagedList initial={eventPage} endpoint="events" query={query} pageSize={PAGE_SIZE} render="event-compact" />
        </section>
      ) : null}

      {placeCount ? (
        <section className="mb-8">
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">Places · {placeCount}</h2>
          <PagedList initial={placePage} endpoint="places" query={query} pageSize={PAGE_SIZE} render="place-compact" />
        </section>
      ) : null}

      {people.length ? (
        <section>
          <h2 className="text-xs font-bold uppercase tracking-wider text-muted mb-2">People into this · {people.length}</h2>
          <div className="flex flex-col gap-2">
            {people.map((p) => (
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
        </section>
      ) : null}
    </div>
  );
}
