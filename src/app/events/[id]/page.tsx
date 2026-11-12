import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { MessageCircle, Navigation } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, paymentsMode } from "@/lib/config";
import { TicketButton } from "@/components/payments/TicketButton";
import { EventPricing } from "@/components/payments/EventPricing";
import { getInterest } from "@/lib/data/taxonomy";
import { JoinButton } from "@/components/events/JoinButton";
import { ReportButton } from "@/components/shared/ReportButton";
import { Avatar } from "@/components/ui/Avatar";
import { BackButton } from "@/components/ui/BackButton";
import { CategoryBadge } from "@/components/ui/Badge";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { Surface } from "@/components/ui/Surface";
import { MiniMap } from "@/components/map/MiniMap";
import { NewBanner } from "@/components/shared/NewBanner";
import { ShareButton } from "@/components/shared/ShareButton";
import { DirectionsLink, TrackView } from "@/components/interactions/TrackView";
import { eventHasEnded, formatEventDateLong, formatTimeRange } from "@/lib/utils/format";
import { LocalDate } from "@/components/time/LocalDate";
import { OwnerActions } from "@/components/shared/OwnerActions";
import { shareMetadata } from "@/lib/utils/share-metadata";
import { DEFAULT_TIME_ZONE } from "@/lib/utils/timezone";
import { getViewerTime } from "@/lib/time/server";
import { InterestIcon } from "@/components/ui/TaxonomyIcon";
import { ACTIVITY_KIND_LABELS, describeActivity } from "@/lib/activity";
import { readinessParts } from "@/lib/readiness";
import { ConfirmSessionButton } from "@/components/events/ConfirmSessionButton";
import { eventDetailFacts, sameZoneAt } from "@/lib/events/detail";

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

/**
 * Event detail in the Local editorial treatment (roadmap 4.1). One column, one
 * left edge, in a fixed reading order: what it is, when (in the event's own
 * time zone, as text), where to meet, who hosts and who is going, what it costs
 * and how many spots are left, what to expect, then the status and the one
 * action. The action block is in that place in the page and stays in view at
 * the foot of the screen until the reader reaches it.
 */
export default async function EventPage({ params, searchParams }: PageProps<"/events/[id]">) {
  const [{ id }, sp, viewer, repo, time] = await Promise.all([params, searchParams, getViewer(), getRepository(), getViewerTime()]);
  const event = await repo.events.get(id, viewer?.id ?? null);
  if (!event) notFound();
  const ended = eventHasEnded(event.startsAt, event.endsAt, time.now);
  const cancelled = event.status === "cancelled";
  const mapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${event.lat},${event.lng}`;
  // The group chat, for people going (behind the messaging flag).
  const chatId = viewer && event.viewerJoined && featureEnabled("messaging") ? await repo.messaging.eventConversation(viewer.id, event.id) : null;
  // Tickets are sold behind the payments flag; the host gets the pricing panel. The price itself is
  // shown whenever the event has one, so a priced event is never described as free.
  const payments = paymentsMode();
  const isHost = !!viewer && viewer.id === event.creatorId;
  const facts = eventDetailFacts({ event, joined: !!event.viewerJoined, viewerId: viewer?.id ?? null, ended, ticketsOnSale: !!payments });
  // Structured activity details (roadmap 4.2), behind the pilot flag.
  const pilotEvents = featureEnabled("pilotEvents");
  const activity = pilotEvents ? (event.activityDetails ?? null) : null;
  const activityLines = describeActivity(activity);
  // The Readiness row and the host's confirm button (roadmap 4.3), behind the pilot flag.
  // The going and spots counts are already in "Cost and spots", so only the rest of the row is shown here.
  const readiness = pilotEvents && event.readiness
    ? readinessParts(event.readiness, { now: time.now, cancelled, ended, viewerTimeZone: time.timeZone }).slice(1).filter((part) => part !== "Full" && !/ spots? open$/.test(part))
    : null;
  const canConfirm = pilotEvents && isHost && !cancelled && !ended && event.decision === "open" && event.minAttendance != null;
  const [ticketSummary, canSell] = payments && isHost && !cancelled && !ended
    ? await Promise.all([repo.payments.ticketSummary(viewer!.id, event.id), repo.payments.canSell(viewer!.id)])
    : [null, false];
  // When: the event's own zone, always named. The viewer's clock is added only when it reads differently.
  const eventZone = { timeZone: event.timeZone };
  const otherClock = !sameZoneAt(event.startsAt, event.timeZone, time.timeZone) || (event.endsAt ? !sameZoneAt(event.endsAt, event.timeZone, time.timeZone) : false);
  const roundButton = "h-10 w-10 inline-flex items-center justify-center rounded-full border border-line bg-surface";

  return (
    <article className="treatment-editorial pb-nav md:pb-10" data-event-detail="">
      {viewer && featureEnabled("recommendations") ? <TrackView kind="event" id={event.id} /> : null}
      <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4">
        <div className="flex items-center justify-between">
          <BackButton fallback="/events" className={roundButton} />
          <div className="flex items-center gap-2">
            {isHost ? <OwnerActions kind="event" id={event.id} canEdit={!cancelled && !ended} canCancel={!cancelled && !ended} canDelete={!event.attendees.some((attendee) => attendee.id !== event.creatorId)} /> : null}
            <ShareButton item={{ kind: "event", id: event.id }} title={event.title} text={`${formatEventDateLong(event.startsAt, eventZone)} at ${event.locationName}`} />
          </div>
        </div>

        {/* Anything focused above the action is scrolled clear of it while it rides at the foot of the screen. */}
        <div className="[&_*]:scroll-mb-40">
          {/* 1. What it is */}
          <header className="mt-section" data-part="what">
            <div className="flex flex-wrap items-center gap-2">
              <CategoryBadge slug={event.categorySlug} />
              {activity ? <span className="type-body font-semibold text-ink-2">{ACTIVITY_KIND_LABELS[activity.kind]}</span> : null}
            </div>
            <h1 className="type-page-title text-ink mt-2 break-words">{event.title}</h1>
            {cancelled || ended ? (
              <p className="mt-2">
                <StatusLabel tone={cancelled ? "negative" : "neutral"}>{cancelled ? "Cancelled" : "Ended"}</StatusLabel>
              </p>
            ) : null}
            {cancelled && event.cancelReason === "below_minimum" && pilotEvents ? (
              <p className="type-body text-ink-2 mt-2">Not enough people signed up by the decision time, so it was called off automatically.</p>
            ) : null}
            <p className="type-body text-ink-2 mt-3 whitespace-pre-line break-words">{event.description}</p>
            {event.tags.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
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

          {/* 2. When: plain text, in the event's zone */}
          <section aria-labelledby="event-when" data-part="when">
            <SectionHeader id="event-when" title="When" />
            <p className="type-item-title text-ink">{formatEventDateLong(event.startsAt, eventZone)}</p>
            <p className="type-body text-ink-2">{formatTimeRange(event.startsAt, event.endsAt, eventZone)}</p>
            {otherClock ? (
              <p className="type-body text-ink-2 mt-1" data-your-time="">
                Your time: <LocalDate value={event.startsAt} format={{ weekday: "short", month: "short", day: "numeric" }} />, {formatTimeRange(event.startsAt, event.endsAt, time)}
              </p>
            ) : null}
          </section>

          {/* 3. Where to meet, and how to get there */}
          <section aria-labelledby="event-where" data-part="where">
            <SectionHeader
              id="event-where"
              title="Meeting point"
              action={
                <DirectionsLink kind="event" id={event.id} href={mapsUrl} className="chip">
                  <Navigation size={14} aria-hidden /> Directions
                </DirectionsLink>
              }
            />
            <p className="type-item-title text-ink break-words">
              {event.placeId ? (
                <Link href={`/places/${event.placeId}`} className="underline underline-offset-4">
                  {event.locationName}
                </Link>
              ) : (
                event.locationName
              )}
            </p>
            <p className="type-body text-ink-2 break-words">{event.address ?? `${event.lat.toFixed(4)}, ${event.lng.toFixed(4)}`}</p>
            <div className="mt-3 h-44 overflow-hidden rounded-2xl">
              <MiniMap lat={event.lat} lng={event.lng} color="#6b4cff" categorySlug={event.categorySlug} label={event.title} kind="event" />
            </div>
          </section>

          {/* 4. Who hosts, and who is going */}
          <section aria-labelledby="event-host" data-part="host">
            <SectionHeader id="event-host" title="Hosted by" />
            {event.creator ? (
              <Link href={`/u/${event.creator.username}`} className="flex items-center gap-3 rounded-xl py-1 hover:bg-paper-2/60">
                <Avatar name={event.creator.displayName} src={event.creator.avatarUrl} size={44} />
                <span className="min-w-0">
                  <span className="type-item-title text-ink block truncate">{event.creator.displayName}</span>
                  <span className="type-body text-ink-2 block">@{event.creator.username}</span>
                </span>
              </Link>
            ) : (
              <p className="type-body text-ink-2">Community event</p>
            )}
            <h3 className="type-body font-semibold text-ink mt-4" id="event-going">Who&apos;s going</h3>
            {event.attendees.length ? (
              <ul className="list-none p-0 m-0 mt-2 grid grid-cols-2 sm:grid-cols-3 gap-3" aria-labelledby="event-going">
                {event.attendees.map((a) => (
                  <li key={a.id} className="min-w-0">
                    <Link href={`/u/${a.username}`} className="flex items-center gap-2 min-w-0 hover:text-flare-ink">
                      <Avatar name={a.displayName} src={a.avatarUrl} size={32} />
                      <span className="type-body font-semibold truncate">{a.displayName}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="type-body text-ink-2 mt-1">Nobody yet. Be first.</p>
            )}
          </section>

          {/* 5. Cost and spots */}
          <section aria-labelledby="event-cost" data-part="cost">
            <SectionHeader id="event-cost" title="Cost and spots" />
            <p className="type-item-title text-ink" data-cost="">{facts.cost}</p>
            <p className="type-body text-ink-2" data-spots="">
              {facts.going}
              {facts.spots ? ` · ${facts.spots}` : ""}
            </p>
            {readiness && readiness.length ? <p className="type-body font-semibold text-ink mt-1" data-testid="readiness-row">{readiness.join(" · ")}</p> : null}
          </section>

          {/* 6. What to expect (requirements). Host-entered newcomer notes join this block when they exist. */}
          {activity ? (
            <section aria-labelledby="event-expect" data-part="expect">
              <SectionHeader id="event-expect" title="What to expect" />
              <Surface variant="inset" className="p-4">
                <h3 className="type-body font-semibold text-ink">{ACTIVITY_KIND_LABELS[activity.kind]}</h3>
                {activityLines.length ? (
                  <ul className="mt-1.5 flex flex-col gap-1 type-body text-ink-2 list-disc pl-5">
                    {activityLines.map((line) => <li key={line}>{line}</li>)}
                  </ul>
                ) : null}
              </Surface>
            </section>
          ) : null}
        </div>

        {/* 7. Status and the one action. In its place in the page; held at the foot of the screen until then. */}
        <section aria-label="Join this event" data-part="action" className="action-dock mt-section">
          <Surface variant="raised" className="p-4 flex flex-wrap items-center gap-x-4 gap-y-3">
            <div className="flex-1 min-w-0 basis-[12rem]">
              {facts.status ? (
                <p>
                  <StatusLabel tone={facts.status.tone}>{facts.status.label}</StatusLabel>
                </p>
              ) : (
                <p className="type-body font-semibold text-ink">{facts.cost}{facts.spots ? ` · ${facts.spots}` : ""}</p>
              )}
              <p className="type-body text-ink-2" data-action-note="">{facts.note}</p>
            </div>
            {facts.action === "ticket" ? (
              <TicketButton eventId={event.id} priceCents={event.priceCents!} signedIn={!!viewer} disabled={facts.full} />
            ) : facts.action === "join" || facts.action === "leave" ? (
              <JoinButton eventId={event.id} joined={event.viewerJoined} signedIn={!!viewer} full={facts.full} ended={ended} cancelled={cancelled} size="md" />
            ) : null}
          </Surface>
        </section>

        {sp.ticket === "success" ? <p role="status" className="type-body font-semibold mt-3">Payment received. Your ticket is confirmed{payments === "stripe" ? " as soon as Stripe tells us" : ""}.</p> : null}
        {sp.ticket === "refunded" ? <p role="status" className="type-body font-semibold mt-3">The event filled up while you checked out, so your payment was refunded.</p> : null}
        {sp.new ? (
          <div className="mt-3">
            <NewBanner kind="event" />
          </div>
        ) : null}
        {chatId ? (
          <Link href={`/messages/${chatId}`} className="mt-3 flex items-center gap-2 rounded-xl py-3 font-semibold hover:bg-paper-2/60">
            <MessageCircle size={18} className="text-pulse" aria-hidden /> Group chat
            <span className="ml-auto type-body font-normal text-ink-2">Everyone going</span>
          </Link>
        ) : null}

        {/* Host tools */}
        {canConfirm ? (
          <div className="card p-4 mt-3 flex flex-wrap items-center gap-3">
            <p className="flex-1 min-w-0 basis-[12rem] text-sm text-ink-2">
              Needs {event.minAttendance} to go ahead. Confirm it yourself and it won&apos;t be called off automatically.
            </p>
            <ConfirmSessionButton eventId={event.id} />
          </div>
        ) : null}
        {payments && isHost && !cancelled && !ended ? (
          <EventPricing eventId={event.id} priceCents={event.priceCents ?? null} summary={ticketSummary} canSell={canSell} locked={event.attendees.some((a) => a.id !== event.creatorId)} demo={payments === "demo"} />
        ) : null}

        <div className="mt-section flex items-center justify-between text-xs text-muted">
          <span>Created <LocalDate value={event.createdAt} format={{ month: "short", day: "numeric" }} /></span>
          <ReportButton targetType="event" targetId={event.id} signedIn={!!viewer} returnTo={`/events/${event.id}`} />
        </div>
      </div>
    </article>
  );
}
