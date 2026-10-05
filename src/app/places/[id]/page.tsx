import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { CalendarPlus, MapPin, Navigation, Lightbulb, Bookmark } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { getCategory, getInterest } from "@/lib/data/taxonomy";
import { PlaceCover } from "@/components/places/PlaceCover";
import { SaveButton } from "@/components/places/SaveButton";
import { RatingControl } from "@/components/places/RatingControl";
import { ReportButton } from "@/components/shared/ReportButton";
import { EventCard } from "@/components/events/EventCard";
import { Avatar } from "@/components/ui/Avatar";
import { BackButton } from "@/components/ui/BackButton";
import { CategoryBadge } from "@/components/ui/Badge";
import { MiniMap } from "@/components/map/MiniMap";
import { NewBanner } from "@/components/shared/NewBanner";
import { ShareButton } from "@/components/shared/ShareButton";
import { pluralize } from "@/lib/utils/format";
import { OwnerActions } from "@/components/shared/OwnerActions";
import { PlacePhotos } from "@/components/places/PlacePhotos";
import { PlaceReviews } from "@/components/places/PlaceReviews";
import { PlaceOwnerControls } from "@/components/places/PlaceOwnerControls";
import { VisibilityNotice } from "@/components/places/VisibilityNotice";
import { shareMetadata } from "@/lib/utils/share-metadata";
import { neighborhoodHref } from "@/lib/utils/neighborhoods";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/places/[id]">): Promise<Metadata> {
  const { id } = await params;
  const repo = await getRepository();
  // No viewer on purpose: crawlers are anonymous, so only public listings unfurl.
  const place = await repo.places.get(id);
  if (!place) return { title: "Place" };
  const where = [place.neighborhood, place.city].filter(Boolean).join(", ");
  return shareMetadata({
    title: place.name,
    description: place.localTip ? `${place.localTip} · ${where}` : `${place.description} · ${where}`,
    path: `/places/${place.id}`,
    image: place.photos[0]?.url ?? null,
    type: "article",
  });
}

export default async function PlacePage({ params, searchParams }: PageProps<"/places/[id]">) {
  const [{ id }, sp, viewer, repo] = await Promise.all([params, searchParams, getViewer(), getRepository()]);
  const place = await repo.places.get(id, viewer?.id ?? null);
  if (!place) notFound();
  const [events, ratings, lists, memberIds] = await Promise.all([
    repo.events.listForPlace(place.id),
    repo.places.listRatings(place.id, viewer?.id ?? null),
    // The viewer's own lists (at most 100) for the Save button's sheet.
    viewer ? repo.savedLists.list(viewer.id) : Promise.resolve([]),
    viewer ? repo.savedLists.memberships(viewer.id, place.id) : Promise.resolve([]),
  ]);
  const isOwner = !!viewer && viewer.id === place.creatorId;
  const category = getCategory(place.categorySlug);
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;

  return (
    <article className="pb-nav md:pb-10">
      {/* Hero */}
      <div className="relative h-[260px] md:h-[360px] md:mx-6 md:mt-6 md:rounded-3xl overflow-hidden">
        <PlaceCover photoUrl={place.photos[0]?.url} categorySlug={place.categorySlug} name={place.name} emojiSize={72} layout="hero" priority />
        <div className="absolute inset-x-0 top-0 p-4 flex items-center justify-between">
          <BackButton fallback="/" />
          <div className="flex items-center gap-2">
            {isOwner ? <OwnerActions kind="place" id={place.id} canEdit canDelete /> : null}
            <ShareButton title={place.name} text={place.localTip ?? place.description} />
            <SaveButton placeId={place.id} saved={place.viewerSaved} signedIn={!!viewer} lists={lists} memberIds={memberIds} variant="icon" />
          </div>
        </div>
        <div className="absolute inset-x-0 bottom-0 h-24 bg-gradient-to-t from-ink/50 to-transparent" aria-hidden />
      </div>

      <div className="max-w-2xl mx-auto px-4 md:px-6 -mt-6 relative">
        {sp.new ? (
          <div className="mb-3">
            <NewBanner kind="place" />
          </div>
        ) : null}
        <div className="card p-5 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <CategoryBadge slug={place.categorySlug} />
            {place.neighborhood ? (
              <Link href={neighborhoodHref(place.neighborhood)} className="text-sm text-muted hover:text-flare-600 underline-offset-4 hover:underline" title={`Browse ${place.neighborhood}`}>
                {place.neighborhood}
              </Link>
            ) : null}
          </div>
          <h1 className="text-3xl leading-tight font-bold">{place.name}</h1>
          <div className="flex items-center gap-3 text-sm text-ink-2 flex-wrap">
            {place.creator ? (
              <Link href={`/u/${place.creator.username}`} className="inline-flex items-center gap-2 hover:text-ink">
                <Avatar name={place.creator.displayName} src={place.creator.avatarUrl} size={24} />
                Added by <b className="text-ink">{place.creator.displayName}</b>
              </Link>
            ) : (
              <span className="text-muted">Community contribution</span>
            )}
            <span className="inline-flex items-center gap-1 text-muted">
              <Bookmark size={14} /> {pluralize(place.saveCount, "save")}
            </span>
          </div>
        </div>

        {place.status !== "published" || place.visibility !== "public" ? (
          <div className="mt-4">
            <VisibilityNotice status={place.status} visibility={place.visibility} city={place.city} isOwner={isOwner} />
          </div>
        ) : null}

        <div className="mt-4">
          <RatingControl placeId={place.id} ratingAvg={place.ratingAvg} ratingCount={place.ratingCount} viewerRating={place.viewerRating} viewerRatingNote={place.viewerRatingNote} signedIn={!!viewer} />
        </div>

        {place.localTip ? (
          <div className="mt-4 rounded-2xl bg-sun-100 border border-sun/40 p-4 flex gap-3">
            <Lightbulb className="text-sun shrink-0 mt-0.5" size={20} />
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-ink-2 mb-1">Local tip</p>
              <p className="text-[15px] leading-relaxed">{place.localTip}</p>
            </div>
          </div>
        ) : null}

        <section className="mt-6">
          <h2 className="text-lg font-bold mb-2">About</h2>
          <p className="text-[15px] leading-relaxed text-ink-2 whitespace-pre-line">{place.description}</p>
          {place.tags.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {place.tags.map((t) => {
                const i = getInterest(t);
                return (
                  <Link key={t} href={`/tags/${t}`} className="chip h-8 text-xs" title={`Browse ${i.label}`}>
                    <span aria-hidden>{i.emoji}</span> {i.label}
                  </Link>
                );
              })}
            </div>
          ) : null}
        </section>

        <PlacePhotos placeId={place.id} photos={place.photos} viewerId={viewer?.id ?? null} creatorId={place.creatorId} signedIn={!!viewer} />

        <PlaceReviews ratings={ratings} />

        <section className="mt-6">
          <h2 className="text-lg font-bold mb-2">Where</h2>
          <div className="card overflow-hidden">
            <div className="h-44">
              <MiniMap lat={place.lat} lng={place.lng} color={category.color} emoji={category.emoji} label={place.name} kind="place" />
            </div>
            <div className="p-4 flex items-start gap-3">
              <MapPin size={18} className="text-muted mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0 text-sm">
                <p className="font-semibold">{place.address ?? "No street address"}</p>
                <p className="text-muted">
                  {[place.neighborhood, place.city].filter(Boolean).join(", ")} · {place.lat.toFixed(4)}, {place.lng.toFixed(4)}
                </p>
              </div>
              <a href={mapsUrl} target="_blank" rel="noreferrer" className="chip" data-active="true">
                <Navigation size={14} /> Directions
              </a>
            </div>
          </div>
        </section>

        <section className="mt-6">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-lg font-bold">Happening here</h2>
            <Link href={`/events/new?placeId=${place.id}`} className="text-sm font-semibold text-pulse inline-flex items-center gap-1">
              <CalendarPlus size={15} /> Host something
            </Link>
          </div>
          {events.length ? (
            <div className="flex flex-col gap-2">
              {events.map((e) => (
                <EventCard key={e.id} event={e} compact />
              ))}
            </div>
          ) : (
            <div className="card p-4 text-sm text-muted flex items-center justify-between gap-3">
              <span>No upcoming events. Be the one who starts the pickup game.</span>
              <Link href={`/events/new?placeId=${place.id}`} className="chip shrink-0">
                Create
              </Link>
            </div>
          )}
        </section>

        {isOwner ? <PlaceOwnerControls placeId={place.id} status={place.status} visibility={place.visibility} /> : null}

        <div className="mt-8 flex items-center justify-between text-xs text-muted">
          <span>Added {new Date(place.createdAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}</span>
          <ReportButton targetType="place" targetId={place.id} signedIn={!!viewer} returnTo={`/places/${place.id}`} />
        </div>
      </div>
    </article>
  );
}
