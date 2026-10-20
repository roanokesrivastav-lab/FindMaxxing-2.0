import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { CalendarDays, Clock, MapPin, MessageCircle, Navigation, Users } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, paymentsMode } from "@/lib/config";
import { TicketButton } from "@/components/payments/TicketButton";
import { EventPricing } from "@/components/payments/EventPricing";
import { formatPrice } from "@/lib/data/payments";
import { getCategory, getInterest } from "@/lib/data/taxonomy";
import { JoinButton } from "@/components/events/JoinButton";
import { ReportButton } from "@/components/shared/ReportButton";
import { Avatar } from "@/components/ui/Avatar";
import { BackButton } from "@/components/ui/BackButton";
import { CategoryBadge } from "@/components/ui/Badge";
import { MiniMap } from "@/components/map/MiniMap";
import { NewBanner } from "@/components/shared/NewBanner";
import { ShareButton } from "@/components/shared/ShareButton";
import { eventHasEnded, formatEventDateLong, formatTimeRange } from "@/lib/utils/format";
import { LocalDate, LocalDayLabel, LocalTimeRange } from "@/components/time/LocalDate";
import { OwnerActions } from "@/components/shared/OwnerActions";
import { shareMetadata } from "@/lib/utils/share-metadata";
import { DEFAULT_TIME_ZONE } from "@/lib/utils/timezone";
import { getViewerTime } from "@/lib/time/server";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: PageProps<"/events/[id]">): Promise<Metadata> {
  const { id } = await params;
  const repo = await getRepository();
  // No viewer on purpose: crawlers are anonymous, so only public events unfurl.
  const event = await repo.events.get(id);
  if (!event) return { title: "Event" };
  // Unfurls are read by people anywhere, so use the city's zone (labelled) rather than a cookie.
  const tz = { timeZone: DEFAULT_TIME_ZONE };
  return shareMetadata({
    title: event.title,
    description: `${formatEventDateLong(event.startsAt, tz)} · ${formatTimeRange(event.startsAt, event.endsAt, tz)} at ${event.locationName}. ${event.description}`,
    path: `/events/${event.id}`,
    type: "article",
  });
}

export default async function EventPage({ params, searchParams }: PageProps<"/events/[id]">) {
  const [{ id }, sp, viewer, repo, time] = await Promise.all([params, searchParams, getViewer(), getRepository(), getViewerTime()]);
  const event = await repo.events.get(id, viewer?.id ?? null);
  if (!event) notFound();
  const category = getCategory(event.categorySlug);
  const ended = eventHasEnded(event.startsAt, event.endsAt, time.now);
  const cancelled = event.status === "cancelled";
  const full = event.capacity !== null && event.attendeeCount >= event.capacity;
  const spotsLeft = event.capacity !== null ? Math.max(0, event.capacity - event.attendeeCount) : null;
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${event.lat},${event.lng}`;
  // The group chat, for people going (behind the messaging flag).
  const chatId = viewer && event.viewerJoined && featureEnabled("messaging") ? await repo.messaging.eventConversation(viewer.id, event.id) : null;
  // Tickets (behind the payments flag): buyers see a price; the host gets the pricing panel.
  const payments = paymentsMode();
  const price = payments ? (event.priceCents ?? null) : null;
  const isHost = !!viewer && viewer.id === event.creatorId;
  const [ticketSummary, canSell] = payments && isHost && !cancelled && !ended
    ? await Promise.all([repo.payments.ticketSummary(viewer!.id, event.id), repo.payments.canSell(viewer!.id)])
    : [null, false];

  return (
    <article className="pb-nav md:pb-10">
      <div className="relative bg-pulse text-white md:mx-6 md:mt-6 md:rounded-3xl overflow-hidden">
        <div className="absolute inset-0 opacity-30 bg-[radial-gradient(circle_at_80%_20%,white,transparent_45%)]" aria-hidden />
        <div className="relative max-w-2xl mx-auto px-4 md:px-6 pt-4 pb-8">
          <div className="flex items-center justify-between">
            <BackButton fallback="/events" className="h-10 w-10 inline-flex items-center justify-center rounded-full bg-white/15 backdrop-blur" />
            <div className="flex items-center gap-2">
              {viewer?.id === event.creatorId ? <OwnerActions kind="event" id={event.id} canEdit={!cancelled && !ended} canCancel={!cancelled && !ended} canDelete={!event.attendees.some((attendee) => attendee.id !== event.creatorId)} /> : null}
              <ShareButton
                title={event.title}
                text={`${formatEventDateLong(event.startsAt, time)} at ${event.locationName}`}
                className="border-white/25 bg-white/15 text-white hover:bg-white/25"
              />
              <span className="text-sm font-semibold bg-white/15 rounded-full px-3 py-1">{cancelled ? "Cancelled" : ended ? "Ended" : <LocalDayLabel value={event.startsAt} />}</span>
            </div>
          </div>
          <div className="mt-8 flex items-center gap-2">
            <CategoryBadge slug={event.categorySlug} tone="solid" className="bg-white/20" />
            <span className="text-3xl" aria-hidden>
              {category.emoji}
            </span>
          </div>
          <h1 className="mt-2 text-3xl md:text-4xl font-bold leading-tight">{event.title}</h1>
          <div className="mt-4 flex flex-col gap-1.5 text-white/90 text-[15px]">
            <p className="inline-flex items-center gap-2">
              <CalendarDays size={16} /> <LocalDate value={event.startsAt} format={{ weekday: "long", month: "long", day: "numeric" }} />
            </p>
            <p className="inline-flex items-center gap-2">
              <Clock size={16} /> <LocalTimeRange startsAt={event.startsAt} endsAt={event.endsAt} />
            </p>
            <p className="inline-flex items-center gap-2">
              <MapPin size={16} />
              {event.placeId ? (
                <Link href={`/places/${event.placeId}`} className="underline underline-offset-4">
                  {event.locationName}
                </Link>
              ) : (
                event.locationName
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-4 md:px-6 relative">
        {cancelled ? <div className="mt-4 rounded-2xl border-2 border-danger bg-danger-100 px-4 py-3 text-sm font-bold text-danger">This event has been cancelled. Existing attendees can still view it and leave.</div> : null}
        <div className={`card p-4 flex items-center gap-3 ${cancelled ? "mt-3" : "-mt-5"}`}>
          <div className="flex-1 min-w-0">
            <p className="font-bold inline-flex items-center gap-1.5">
              <Users size={16} /> {event.attendeeCount} going
            </p>
            <p className="text-xs text-muted mt-0.5">
              {!cancelled && event.capacity ? `${spotsLeft} spot${spotsLeft === 1 ? "" : "s"} left · ` : ""}
              {cancelled ? (event.viewerJoined ? "You were on the attendee list." : "This event is no longer accepting attendees.") : event.viewerJoined ? "You're on the list." : full ? "Full for now." : "Free to join. Just show up."}
            </p>
          </div>
          {price && !event.viewerJoined && !isHost && !cancelled && !ended ? (
            <TicketButton eventId={event.id} priceCents={price} signedIn={!!viewer} disabled={full} />
          ) : (
            <JoinButton eventId={event.id} joined={event.viewerJoined} signedIn={!!viewer} full={full} ended={ended} cancelled={cancelled} size="md" />
          )}
        </div>
        {chatId ? (
          <Link href={`/messages/${chatId}`} className="mt-3 card p-3 flex items-center gap-2 font-semibold hover:bg-surface-2">
            <MessageCircle size={18} className="text-pulse" /> Group chat
            <span className="ml-auto text-xs font-normal text-muted">Everyone going</span>
          </Link>
        ) : null}
        {price ? <p className="mt-2 text-sm text-ink-2"><b>{formatPrice(price)}</b> per ticket{cancelled ? " · tickets are being refunded" : ""}</p> : null}
        {sp.ticket === "success" ? <p role="status" className="card p-3 mt-3 text-sm font-semibold">Payment received. Your ticket is confirmed{payments === "stripe" ? " as soon as Stripe tells us" : ""}.</p> : null}
        {sp.ticket === "refunded" ? <p role="status" className="card p-3 mt-3 text-sm font-semibold">The event filled up while you checked out, so your payment was refunded.</p> : null}
        {payments && isHost && !cancelled && !ended ? (
          <EventPricing eventId={event.id} priceCents={price} summary={ticketSummary} canSell={canSell} locked={event.attendees.some((a) => a.id !== event.creatorId)} demo={payments === "demo"} />
        ) : null}
        {sp.new ? (
          <div className="mt-3">
            <NewBanner kind="event" />
          </div>
        ) : null}

        <section className="mt-6">
          <h2 className="text-lg font-bold mb-2">Details</h2>
          <p className="text-[15px] leading-relaxed text-ink-2 whitespace-pre-line">{event.description}</p>
          {event.tags.length ? (
            <div className="mt-3 flex flex-wrap gap-2">
              {event.tags.map((t) => {
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

        <section className="mt-6">
          <h2 className="text-lg font-bold mb-2">Hosted by</h2>
          {event.creator ? (
            <Link href={`/u/${event.creator.username}`} className="card p-4 flex items-center gap-3 hover:bg-surface-2">
              <Avatar name={event.creator.displayName} src={event.creator.avatarUrl} size={44} />
              <div className="min-w-0">
                <p className="font-bold truncate">{event.creator.displayName}</p>
                <p className="text-xs text-muted">@{event.creator.username}</p>
              </div>
            </Link>
          ) : (
            <p className="text-sm text-muted">Community event</p>
          )}
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold mb-2">Who&apos;s going</h2>
          {event.attendees.length ? (
            <div className="card p-4 grid grid-cols-2 sm:grid-cols-3 gap-3">
              {event.attendees.map((a) => (
                <Link key={a.id} href={`/u/${a.username}`} className="flex items-center gap-2 min-w-0 hover:text-flare-ink">
                  <Avatar name={a.displayName} src={a.avatarUrl} size={32} />
                  <span className="text-sm font-semibold truncate">{a.displayName}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted">Nobody yet. Be first.</p>
          )}
        </section>

        <section className="mt-6">
          <h2 className="text-lg font-bold mb-2">Meeting point</h2>
          <div className="card overflow-hidden">
            <div className="h-44">
              <MiniMap lat={event.lat} lng={event.lng} color="#6b4cff" emoji={category.emoji} label={event.title} kind="event" />
            </div>
            <div className="p-4 flex items-start gap-3">
              <MapPin size={18} className="text-muted mt-0.5 shrink-0" />
              <div className="flex-1 min-w-0 text-sm">
                <p className="font-semibold">{event.locationName}</p>
                <p className="text-muted">{event.address ?? `${event.lat.toFixed(4)}, ${event.lng.toFixed(4)}`}</p>
              </div>
              <a href={mapsUrl} target="_blank" rel="noreferrer" className="chip" data-active="true">
                <Navigation size={14} /> Directions
              </a>
            </div>
          </div>
        </section>

        <div className="mt-8 flex items-center justify-between text-xs text-muted">
          <span>Created <LocalDate value={event.createdAt} format={{ month: "short", day: "numeric" }} /></span>
          <ReportButton targetType="event" targetId={event.id} signedIn={!!viewer} returnTo={`/events/${event.id}`} />
        </div>
      </div>
    </article>
  );
}
