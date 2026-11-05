import Link from "next/link";
import type { ReactNode } from "react";
import { MessageCircle, Navigation } from "lucide-react";
import type { EventDetail } from "@/lib/data/types";
import { hasNewcomerInfo } from "@findmaxxing/shared/events";
import { getCategory, getInterest } from "@/lib/data/taxonomy";
import { formatPrice } from "@/lib/data/payments";
import { formatEventDateLong, formatTimeRange, pluralize } from "@/lib/utils/format";
import { Avatar } from "@/components/ui/Avatar";
import { BackButton } from "@/components/ui/BackButton";
import { PlaceGlyph } from "@/components/ui/PlaceGlyph";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { Surface } from "@/components/ui/Surface";
import { MiniMap } from "@/components/map/MiniMap";
import { ShareButton } from "@/components/shared/ShareButton";
import { ReportButton } from "@/components/shared/ReportButton";
import { OwnerActions } from "@/components/shared/OwnerActions";
import { DirectionsLink } from "@/components/interactions/TrackView";
import { LocalDate } from "@/components/time/LocalDate";
import { InterestIcon } from "@/components/ui/TaxonomyIcon";

export interface EditorialEventProps {
  event: EventDetail;
  time: { timeZone: string; now: number };
  ended: boolean;
  cancelled: boolean;
  full: boolean;
  isHost: boolean;
  signedIn: boolean;
  /** Ticket price in cents when payments are on and the event is priced; else null. */
  price: number | null;
  /** The linked place's lead photo, when there is one (photography-led). */
  photo: { src: string; alt: string } | null;
  chatId: string | null;
  /** The one primary action (Join / Ticket / status), rendered by the page. */
  action: ReactNode;
  /** Host-only panels (pricing), banners and notices, in page order. */
  notices?: ReactNode;
  hostTools?: ReactNode;
  /** Requirements from later tickets (4.2 activity details); the section is left out when empty. */
  requirements?: ReactNode;
  /** Availability details from later tickets (4.3 Readiness row); replaces the plain line when given. */
  availability?: ReactNode;
  /** The viewer's participation status text, when it is not plain going (4.4). */
  status?: ReactNode;
}

/**
 * Roadmap 4.1: the event page in the Local editorial treatment (pilotEvents). Order: what it is →
 * date, time and time zone as plain text (no calendar date block) → meeting point and travel → host
 * and permitted social proof → cost and availability → requirements → status + one primary action.
 * "Your first time?" comes from host-entered fields (events.newcomer) and is left out when empty.
 */
export function EditorialEvent(p: EditorialEventProps) {
  const { event, time, ended, cancelled, full, isHost, price } = p;
  const category = getCategory(event.categorySlug);
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${event.lat},${event.lng}`;
  const spotsLeft = event.capacity !== null ? Math.max(0, event.capacity - event.attendeeCount) : null;
  const newcomer = hasNewcomerInfo(event.newcomer) ? event.newcomer : null;
  const statusLine = cancelled ? (
    <StatusLabel tone="negative">Cancelled</StatusLabel>
  ) : ended ? (
    <StatusLabel tone="neutral">Ended</StatusLabel>
  ) : p.status ? (
    p.status
  ) : event.viewerJoined ? (
    <StatusLabel tone="positive">Going</StatusLabel>
  ) : full ? (
    <StatusLabel tone="warning">Full</StatusLabel>
  ) : null;

  return (
    <article className="treatment-editorial pb-nav md:pb-10">
      <div className="max-w-2xl mx-auto px-edge md:px-6">
        <div className="flex items-center justify-between gap-item pt-row">
          <BackButton fallback="/events" />
          <div className="flex items-center gap-item">
            {isHost ? <OwnerActions kind="event" id={event.id} canEdit={!cancelled && !ended} canCancel={!cancelled && !ended} canDelete={!event.attendees.some((a) => a.id !== event.creatorId)} /> : null}
            <ShareButton item={{ kind: "event", id: event.id }} title={event.title} text={`${formatEventDateLong(event.startsAt, time)} at ${event.locationName}`} />
          </div>
        </div>

        {/* What it is. Photography-led: the venue's photo leads when there is one. */}
        <header className="mt-row flex flex-col gap-item">
          {p.photo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={p.photo.src} alt={p.photo.alt} className="w-full aspect-[4/3] object-cover rounded-2xl bg-paper-2" />
          ) : null}
          <div className="flex flex-wrap items-center gap-x-row gap-y-hair">
            <span className="type-body inline-flex items-center gap-item font-semibold text-ink-2">
              {p.photo ? null : <PlaceGlyph categorySlug={event.categorySlug} size={32} />}
              {category.label}
            </span>
            {cancelled ? <StatusLabel tone="negative">Cancelled</StatusLabel> : ended ? <StatusLabel tone="neutral">Ended</StatusLabel> : null}
          </div>
          <h1 className="type-page-title text-ink break-words">{event.title}</h1>
          <p className="type-body text-ink-2 whitespace-pre-line break-words">{event.description}</p>
          {event.tags.length ? (
            <div className="flex flex-wrap gap-item">
              {event.tags.map((t) => {
                const i = getInterest(t);
                return (
                  <Link key={t} href={`/tags/${t}`} className="chip h-8 text-xs" title={`Browse ${i.label}`}>
                    <InterestIcon slug={i.slug} /> {i.label}
                  </Link>
                );
              })}
            </div>
          ) : null}
        </header>

        {cancelled ? (
          <Surface variant="inset" className="mt-row rounded-xl p-row">
            <p className="type-body text-ink">This event has been cancelled. Existing attendees can still view it and leave.</p>
          </Surface>
        ) : null}
        {p.notices}

        {/* Date, time and time zone as plain text. */}
        <section aria-labelledby="ev-when">
          <SectionHeader id="ev-when" title="When" />
          <p className="type-body text-ink">{formatEventDateLong(event.startsAt, time)}</p>
          <p className="type-body text-ink-2">{formatTimeRange(event.startsAt, event.endsAt, time)}</p>
        </section>

        {/* Meeting point and travel. */}
        <section aria-labelledby="ev-where">
          <SectionHeader id="ev-where" title="Meeting point" />
          <p className="type-body text-ink font-semibold break-words">
            {event.placeId ? (
              <Link href={`/places/${event.placeId}`} className="underline underline-offset-4">{event.locationName}</Link>
            ) : (
              event.locationName
            )}
          </p>
          <p className="type-body text-ink-2 break-words">{event.address ?? `${event.lat.toFixed(4)}, ${event.lng.toFixed(4)}`}</p>
          <div className="mt-item h-44 overflow-hidden rounded-xl">
            <MiniMap lat={event.lat} lng={event.lng} color={category.color} categorySlug={event.categorySlug} label={event.title} kind="event" />
          </div>
          <DirectionsLink kind="event" id={event.id} href={mapsUrl} className="chip mt-item">
            <Navigation size={14} /> Directions
          </DirectionsLink>
        </section>

        {/* Host and permitted social proof (the going list that exists today; no social line). */}
        <section aria-labelledby="ev-host">
          <SectionHeader id="ev-host" title="Host" />
          {event.creator ? (
            <Link href={`/u/${event.creator.username}`} className="flex items-center gap-row py-item rounded-xl hover:bg-paper-2/60">
              <Avatar name={event.creator.displayName} src={event.creator.avatarUrl} size={44} />
              <span className="min-w-0">
                <span className="type-item-title text-ink block truncate">{event.creator.displayName}</span>
                <span className="type-body text-muted">@{event.creator.username}</span>
              </span>
            </Link>
          ) : (
            <p className="type-body text-muted">Community event</p>
          )}
          <h3 className="type-body font-semibold text-ink mt-row">{pluralize(event.attendeeCount, "person", "people")} going</h3>
          {event.attendees.length ? (
            <ul className="mt-item grid grid-cols-2 gap-item">
              {event.attendees.map((a) => (
                <li key={a.id} className="min-w-0">
                  <Link href={`/u/${a.username}`} className="flex items-center gap-item min-w-0 hover:text-flare-ink">
                    <Avatar name={a.displayName} src={a.avatarUrl} size={32} />
                    <span className="type-body font-semibold truncate">{a.displayName}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-body text-muted mt-hair">Nobody yet. Be first.</p>
          )}
        </section>

        {newcomer ? (
          <section aria-labelledby="ev-first-time">
            <Surface variant="inset" className="mt-section rounded-xl p-row flex flex-col gap-item">
              <h2 id="ev-first-time" className="type-item-title text-ink">Your first time?</h2>
              {newcomer.meetingSpot ? <p className="type-body text-ink-2"><span className="font-semibold text-ink">Where to find us: </span>{newcomer.meetingSpot}</p> : null}
              {newcomer.welcomer ? <p className="type-body text-ink-2"><span className="font-semibold text-ink">Who welcomes you: </span>{newcomer.welcomer}</p> : null}
              {newcomer.bring ? <p className="type-body text-ink-2"><span className="font-semibold text-ink">What to bring: </span>{newcomer.bring}</p> : null}
              {newcomer.soloWelcome ? <p className="type-body text-ink-2">Coming alone is normal here.</p> : null}
            </Surface>
          </section>
        ) : null}

        {/* Cost and availability. "Free to join" only when there is no price. */}
        <section aria-labelledby="ev-cost">
          <SectionHeader id="ev-cost" title="Cost and spots" />
          <p className="type-body text-ink font-semibold">
            {price ? `${formatPrice(price)} per ticket${cancelled ? " · tickets are being refunded" : ""}` : "Free"}
          </p>
          {p.availability ?? (
            <p className="type-body text-ink-2">
              {cancelled
                ? "No longer accepting attendees."
                : spotsLeft === null
                  ? `${event.attendeeCount} going · no limit`
                  : spotsLeft === 0
                    ? `${event.attendeeCount} going · full for now`
                    : `${event.attendeeCount} going · ${pluralize(spotsLeft, "spot")} left`}
            </p>
          )}
          {p.hostTools}
        </section>

        {p.requirements ? (
          <section aria-labelledby="ev-requirements">
            <SectionHeader id="ev-requirements" title="Requirements" />
            {p.requirements}
          </section>
        ) : null}

        {p.chatId ? (
          <Link href={`/messages/${p.chatId}`} className="mt-section flex items-center gap-item py-row type-body font-semibold surface-flat">
            <MessageCircle size={18} aria-hidden /> Group chat
            <span className="ml-auto font-normal text-muted">Everyone going</span>
          </Link>
        ) : null}

        <div className="mt-section flex items-center justify-between type-body text-muted">
          <span>Created <LocalDate value={event.createdAt} format={{ month: "short", day: "numeric" }} /></span>
          <ReportButton targetType="event" targetId={event.id} signedIn={p.signedIn} returnTo={`/events/${event.id}`} />
        </div>
      </div>

      {/* Status + one primary action, floating above the tab bar (raised: the only floating surface). */}
      <div className="sticky z-10 bottom-[calc(var(--nav-height)+var(--safe-bottom))] md:bottom-0 mt-section">
        <Surface variant="raised" className="max-w-2xl mx-auto px-edge py-item flex flex-wrap items-center justify-between gap-x-row gap-y-item md:rounded-2xl">
          <div className="min-w-0" aria-live="polite">{statusLine ?? <span className="type-body text-ink-2">{price ? formatPrice(price) : "Free"}</span>}</div>
          {p.action}
        </Surface>
      </div>
    </article>
  );
}
