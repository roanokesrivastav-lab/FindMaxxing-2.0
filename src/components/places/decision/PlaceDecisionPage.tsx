import Link from "next/link";
import type { ReactNode } from "react";
import { Bookmark, CalendarPlus, Lightbulb, MapPin, Navigation, Users } from "lucide-react";
import type { Event, PlaceDetail, PlaceRating, SavedList } from "@/lib/data/types";
import { getCategory, getInterest } from "@/lib/data/taxonomy";
import { knownFor, reviewAnchor, splitReviews } from "@/lib/places/decision";
import { formatRating, pluralize } from "@/lib/utils/format";
import { neighborhoodHref } from "@/lib/utils/neighborhoods";
import { PHOTO_LAYOUT_SIZES, photoSrc, photoSrcSet } from "@/lib/images/sizes";
import { Surface } from "@/components/ui/Surface";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { PlaceGlyph } from "@/components/ui/PlaceGlyph";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { StarRating } from "@/components/ui/Stars";
import { Avatar } from "@/components/ui/Avatar";
import { BackButton } from "@/components/ui/BackButton";
import { InterestIcon } from "@/components/ui/TaxonomyIcon";
import { buttonClass } from "@/components/ui/Button";
import { SaveButton } from "@/components/places/SaveButton";
import { RatingControl } from "@/components/places/RatingControl";
import { PlacePhotos } from "@/components/places/PlacePhotos";
import { PlaceOwnerControls } from "@/components/places/PlaceOwnerControls";
import { VisibilityNotice } from "@/components/places/VisibilityNotice";
import { ShareButton } from "@/components/shared/ShareButton";
import { OwnerActions } from "@/components/shared/OwnerActions";
import { ReportButton } from "@/components/shared/ReportButton";
import { NewBanner } from "@/components/shared/NewBanner";
import { EventCard } from "@/components/events/EventCard";
import { MiniMap } from "@/components/map/MiniMap";
import { DirectionsLink } from "@/components/interactions/TrackView";
import { LocalDate } from "@/components/time/LocalDate";
import { Evidence } from "./Evidence";

const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };

export interface PlaceDecisionProps {
  place: PlaceDetail;
  ratings: PlaceRating[];
  /** Ids of the people the viewer follows ("friends" on this page). Empty when signed out. */
  followingIds: string[];
  events: Event[];
  lists: SavedList[];
  memberIds: string[];
  viewerId: string | null;
  isNew: boolean;
  extendedTiers: boolean;
  /** The photo that leads the page: the viewer's own (2.8) or the place's public one. Null = no photo. */
  leadPhoto?: { url: string; alt: string; note?: ReactNode } | null;
  /** Slot 4: the most relevant recent observation (2.6). */
  observation?: ReactNode;
  /** Slot 7: best for / less suited (2.7). */
  occasions?: ReactNode;
  /** Slot 8: the local tip block (2.6 replaces the plain tip). */
  tip?: ReactNode;
  /** Owner-only: why the viewer saved it (3.1). Rendered apart from what the place is. */
  mySave?: ReactNode;
  /** Extra rows in the "You" block (2.8: your photo). */
  personalExtra?: ReactNode;
}

/**
 * The photo-first place page (roadmap 2.5, behind pilotExplore). Order, top to bottom:
 * photo; name, category, neighborhood; known for; price / travel time / hours (unknowns
 * said plainly); rating next to its count; recent observation; You / Friends / Community
 * as separate blocks; reviews (friends' first, then everyone else's, never summarized);
 * best for / less suited; one local tip; Save, Add to outing (disabled), Directions.
 * Every claim opens its evidence. With no photo it is still a complete layout: the
 * category glyph leads and nothing is left as an empty frame.
 */
export function PlaceDecisionPage(props: PlaceDecisionProps) {
  const { place, ratings, followingIds, events, lists, memberIds, viewerId, isNew, extendedTiers } = props;
  const signedIn = !!viewerId;
  const isOwner = !!viewerId && viewerId === place.creatorId;
  const category = getCategory(place.categorySlug);
  const lead = props.leadPhoto === undefined ? (place.photos[0] ? { url: place.photos[0].url, alt: `${place.name}` } : null) : props.leadPhoto;
  const { friends, everyone, own } = splitReviews(ratings, followingIds, viewerId);
  const sentence = knownFor(place.description);
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${place.lat},${place.lng}`;
  const where = [place.neighborhood, place.city].filter(Boolean).join(", ");
  const reviewCount = ratings.length;

  const topActions = (
    <div className="flex items-center gap-item">
      {isOwner ? <OwnerActions kind="place" id={place.id} canEdit canDelete /> : null}
      <ShareButton title={place.name} text={place.localTip ?? place.description} item={{ kind: "place", id: place.id }} />
    </div>
  );

  return (
    <article className="treatment-editorial pb-nav md:pb-10" data-place-page="decision" data-hero={lead ? "photo" : "glyph"}>
      {/* 0. Photo first. */}
      {lead ? (
        <div className="relative h-[300px] md:h-[400px] md:mx-6 md:mt-6 md:rounded-3xl overflow-hidden bg-paper-2">
          {/* Not next/image: photos come from the authorized route, already pipeline-sized. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={photoSrc(lead.url, "md")}
            srcSet={photoSrcSet(lead.url)}
            sizes={PHOTO_LAYOUT_SIZES.hero}
            alt={lead.alt}
            className="h-full w-full object-cover"
            fetchPriority="high"
          />
          <div className="absolute inset-x-0 top-0 p-edge flex items-center justify-between">
            <BackButton fallback="/" />
            {topActions}
          </div>
          {lead.note ? <div className="absolute inset-x-0 bottom-0 p-edge">{lead.note}</div> : null}
        </div>
      ) : (
        <div className="px-edge pt-row flex items-center justify-between max-w-2xl mx-auto">
          <BackButton fallback="/" />
          {topActions}
        </div>
      )}

      <div className="max-w-2xl mx-auto px-edge">
        {isNew ? (
          <div className="mt-row">
            <NewBanner kind="place" />
          </div>
        ) : null}

        {/* 1. Name, category, neighborhood. */}
        <header className="mt-row flex items-start gap-row">
          {lead ? null : <PlaceGlyph categorySlug={place.categorySlug} size={72} label={category.label} />}
          <div className="min-w-0 flex-1">
            <h1 className="type-page-title text-ink break-words">{place.name}</h1>
            <p className="type-body text-ink-2 mt-hair">
              <span>{category.label}</span>
              {place.neighborhood ? (
                <>
                  {" · "}
                  <Link href={neighborhoodHref(place.neighborhood)} className="underline-offset-4 hover:underline">
                    {place.neighborhood}
                  </Link>
                </>
              ) : null}
            </p>
            {sentence ? (
              <p className="type-body text-ink mt-item" data-known-for="">
                <span className="text-ink-2">Known for: </span>
                {sentence}
              </p>
            ) : null}
          </div>
        </header>

        {place.status !== "published" || place.visibility !== "public" ? (
          <div className="mt-row">
            <VisibilityNotice status={place.status} visibility={place.visibility} city={place.city} isOwner={isOwner} />
          </div>
        ) : null}

        {/* 2. Price, travel time, hours: unknowns said honestly. */}
        <dl className="mt-row grid grid-cols-1 gap-item sm:grid-cols-3" data-facts="">
          <Fact label="Price" value="Not listed yet" />
          <Fact label="Travel time" value="Depends on where you start: use Directions" />
          <Fact label="Hours" value="Not listed yet" />
        </dl>

        {/* 3. The rating next to its count; the claim opens its evidence. */}
        <div className="mt-row" data-rating-claim="">
          {place.ratingCount ? (
            <Evidence
              claim={
                <span className="inline-flex flex-wrap items-center gap-item">
                  <b className="type-item-title text-ink">{formatRating(place.ratingAvg)}</b>
                  <StarRating value={place.ratingAvg} size={14} />
                  <span className="type-body text-ink-2">from {pluralize(place.ratingCount, "rating")}</span>
                </span>
              }
            >
              The average of {pluralize(place.ratingCount, "star rating")} people gave this place, one each.{" "}
              {reviewCount ? (
                <a href="#reviews" className="font-semibold underline-offset-4 hover:underline">
                  Read the {pluralize(reviewCount, "written review")}
                </a>
              ) : (
                "Nobody has written a review yet."
              )}
            </Evidence>
          ) : (
            <p className="type-body text-ink-2">No ratings yet.</p>
          )}
        </div>

        {/* 4. Most relevant recent observation (dated tip, 2.6). */}
        {props.observation ?? null}

        {/* 5. You, friends and community: separate blocks, never one score. */}
        <SectionHeader title="You" id="you" />
        <Surface variant="flat" className="pb-row flex flex-col gap-row" data-block="you">
          <RatingControl
            placeId={place.id}
            ratingAvg={place.ratingAvg}
            ratingCount={place.ratingCount}
            viewerRating={place.viewerRating}
            viewerRatingNote={place.viewerRatingNote}
            signedIn={signedIn}
            hideAggregate
          />
          {signedIn ? (
            <StatusLabel tone={place.viewerSaved ? "positive" : "neutral"}>{place.viewerSaved ? "In your saves" : "Not saved"}</StatusLabel>
          ) : null}
          {props.personalExtra ?? null}
        </Surface>
        {props.mySave ?? null}

        <SectionHeader title="Friends" id="friends" />
        <div data-block="friends">
          {!signedIn ? (
            <p className="type-body text-ink-2">
              <Link href={`/auth/sign-in?next=${encodeURIComponent(`/places/${place.id}`)}`} className="font-semibold underline-offset-4 hover:underline">
                Sign in
              </Link>{" "}
              to see reviews from people you follow.
            </p>
          ) : friends.length ? (
            <ul className="list-none m-0 p-0">
              {friends.map((r) => (
                <li key={r.id} className="surface-flat">
                  <a href={`#${reviewAnchor(r.id)}`} className="flex flex-wrap items-center gap-x-row gap-y-hair py-item">
                    <Avatar name={r.user?.displayName ?? "Someone"} src={r.user?.avatarUrl ?? null} size={28} />
                    <span className="type-body font-semibold text-ink min-w-0 break-words">{r.user?.displayName ?? "Someone"}</span>
                    <StarRating value={r.score} size={12} />
                    <span className="type-body text-ink-2">Read their review</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-body text-ink-2">Nobody you follow has reviewed this place yet.</p>
          )}
        </div>

        <SectionHeader title="Community" id="community" />
        <div data-block="community" className="flex flex-col gap-item">
          <Evidence claim={<span className="type-body text-ink">{place.ratingCount ? `${formatRating(place.ratingAvg)} average from ${pluralize(place.ratingCount, "rating")}` : "No ratings yet"}</span>}>
            Everyone&rsquo;s star ratings, one per person, averaged. Friends are not weighted differently.
          </Evidence>
          <Evidence claim={<span className="type-body text-ink inline-flex items-center gap-hair"><Bookmark size={14} aria-hidden /> {place.saveCount ? pluralize(place.saveCount, "save") : "No saves yet"}</span>}>
            How many people have saved this place. Who saved it is private and never shown.
          </Evidence>
          <p className="type-body text-ink-2">
            {place.creator ? (
              <>
                Added by{" "}
                <Link href={`/u/${place.creator.username}`} className="font-semibold text-ink underline-offset-4 hover:underline">
                  {place.creator.displayName}
                </Link>
              </>
            ) : (
              "Community contribution"
            )}
            {" · "}
            <LocalDate value={place.createdAt} format={DATE} />
          </p>
        </div>

        {/* 6. Reviews: friends' actual reviews first, then everyone else's. */}
        <SectionHeader title="Reviews" id="reviews" action={reviewCount ? pluralize(reviewCount, "review") : undefined} />
        {friends.length || everyone.length || own ? (
          <div data-block="reviews">
            {friends.length ? <ReviewList heading="From people you follow" reviews={friends} group="friends" /> : null}
            {everyone.length ? <ReviewList heading={friends.length ? "Everyone else" : "From the community"} reviews={everyone} group="everyone" /> : null}
            {own && !friends.length && !everyone.length ? <p className="type-body text-ink-2">Only your own review so far.</p> : null}
          </div>
        ) : (
          <p className="type-body text-ink-2" data-block="reviews">
            No written reviews yet. Rate it above and add a note to write the first.
          </p>
        )}

        {/* 7. Best for / less suited (2.7). */}
        {props.occasions ?? null}

        {/* 8. One local tip, on an inset surface. */}
        {props.tip !== undefined ? props.tip : place.localTip ? (
          <>
            <SectionHeader title="Local tip" />
            <Surface variant="inset" className="p-row flex gap-item" data-block="tip">
              <Lightbulb className="text-sun shrink-0 mt-hair" size={20} aria-hidden />
              <p className="type-body text-ink">{place.localTip}</p>
            </Surface>
          </>
        ) : null}

        {/* 9. Save, Add to outing (disabled until outings exist), Directions. */}
        <div className="mt-section flex flex-wrap items-center gap-item" data-block="actions">
          <SaveButton placeId={place.id} saved={place.viewerSaved} signedIn={signedIn} lists={lists} memberIds={memberIds} />
          <button type="button" disabled aria-describedby="outing-later" className={buttonClass("secondary", "md")}>
            <Users size={16} aria-hidden /> Add to outing
          </button>
          <DirectionsLink kind="place" id={place.id} href={mapsUrl} className={buttonClass("secondary", "md")}>
            <Navigation size={16} aria-hidden /> Directions
          </DirectionsLink>
          <p id="outing-later" className="type-body text-ink-2 basis-full">
            Group outings arrive in a later update.
          </p>
        </div>

        {/* More about the place, further down. */}
        {place.description && place.description.trim() !== sentence ? (
          <>
            <SectionHeader title="About" />
            <p className="type-body text-ink-2 whitespace-pre-line break-words">{place.description}</p>
          </>
        ) : null}
        {place.tags.length ? (
          <div className="mt-item flex flex-wrap gap-item">
            {place.tags.map((t) => {
              const i = getInterest(t);
              return (
                <Link key={t} href={`/tags/${t}`} className="chip h-8 text-xs" title={`Browse ${i.label}`}>
                  <InterestIcon slug={i.slug} /> {i.label}
                </Link>
              );
            })}
          </div>
        ) : null}

        <PlacePhotos placeId={place.id} photos={place.photos} viewerId={viewerId} creatorId={place.creatorId} signedIn={signedIn} />

        <SectionHeader title="Where" />
        <Surface variant="flat" className="overflow-hidden">
          <div className="h-44 rounded-xl overflow-hidden">
            <MiniMap lat={place.lat} lng={place.lng} color={category.color} categorySlug={place.categorySlug} label={place.name} kind="place" />
          </div>
          <div className="py-row flex items-start gap-item">
            <MapPin size={18} className="text-muted mt-hair shrink-0" aria-hidden />
            <div className="flex-1 min-w-0 type-body">
              <p className="font-semibold break-words">{place.address ?? "No street address"}</p>
              <p className="text-ink-2">{where}</p>
            </div>
          </div>
        </Surface>

        <SectionHeader
          title="Happening here"
          action={
            <Link href={`/events/new?placeId=${place.id}`} className="font-semibold text-pulse-ink inline-flex items-center gap-hair">
              <CalendarPlus size={15} aria-hidden /> Host something
            </Link>
          }
        />
        {events.length ? (
          <div className="flex flex-col gap-item">
            {events.map((e) => (
              <EventCard key={e.id} event={e} compact />
            ))}
          </div>
        ) : (
          <p className="type-body text-ink-2">No upcoming events here yet.</p>
        )}

        {isOwner ? <PlaceOwnerControls placeId={place.id} status={place.status} visibility={place.visibility} extendedTiers={extendedTiers} /> : null}

        <div className="mt-section flex items-center justify-between type-body text-ink-2">
          <span>
            Added <LocalDate value={place.createdAt} format={DATE} />
          </span>
          <ReportButton targetType="place" targetId={place.id} signedIn={signedIn} returnTo={`/places/${place.id}`} />
        </div>
      </div>
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <Surface variant="inset" className="px-row py-item">
      <dt className="type-body text-ink-2">{label}</dt>
      <dd className="type-body text-ink m-0">{value}</dd>
    </Surface>
  );
}

function ReviewList({ heading, reviews, group }: { heading: string; reviews: PlaceRating[]; group: "friends" | "everyone" }) {
  return (
    <section aria-label={heading} data-review-group={group} className="mt-item">
      <h3 className="type-body font-semibold text-ink-2">{heading}</h3>
      <ul className="list-none m-0 p-0">
        {reviews.map((r) => (
          <li key={r.id} id={reviewAnchor(r.id)} className="surface-flat py-row" data-review={r.id}>
            <div className="flex flex-wrap items-center gap-x-item gap-y-hair">
              {r.user ? (
                <Link href={`/u/${r.user.username}`} className="flex items-center gap-item min-w-0 hover:text-flare-ink">
                  <Avatar name={r.user.displayName} src={r.user.avatarUrl} size={28} />
                  <span className="type-body font-semibold break-words">{r.user.displayName}</span>
                </Link>
              ) : (
                <span className="type-body text-ink-2">Someone</span>
              )}
              <StarRating value={r.score} size={12} className="ml-auto shrink-0" />
            </div>
            <p className="type-body text-ink mt-item break-words">{r.note}</p>
            <p className="type-body text-ink-2 mt-hair">
              <LocalDate value={r.updatedAt} format={DATE} />
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
