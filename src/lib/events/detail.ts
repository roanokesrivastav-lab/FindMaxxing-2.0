/**
 * What the event page says about cost, spots and the one action it offers
 * (roadmap 4.1). Pure, so the wording rules can be tested without rendering:
 *
 * - A priced event never says "free", whether or not tickets can be bought here.
 * - Full is said as "Full" and the action is off; there is no queue to offer.
 * - Nothing is claimed that the event does not record: no capacity means no
 *   "spots left" number.
 */
import type { Event } from "@/lib/data/types";
import type { StatusTone } from "@/components/ui/StatusLabel";
import { formatPrice } from "@/lib/data/payments";

export interface EventDetailInput {
  event: Pick<Event, "status" | "capacity" | "attendeeCount" | "priceCents" | "creatorId" | "readiness">;
  /** The viewer is on the attendee list. */
  joined: boolean;
  viewerId: string | null;
  ended: boolean;
  /** Tickets can be bought in this deployment (the payments flag). */
  ticketsOnSale: boolean;
}

/** The single primary action. "none" means there is nothing honest to offer. */
export type EventAction = "ticket" | "join" | "leave" | "none";

export interface EventDetailFacts {
  /** A state that changes what the page means; null while the event is simply open. */
  status: { tone: StatusTone; label: string } | null;
  /** "Free" or "$12.00 per ticket". */
  cost: string;
  priced: boolean;
  /** "12 going" */
  going: string;
  /** "3 of 20 spots left", "Full", or null when the host set no limit. */
  spots: string | null;
  spotsLeft: number | null;
  full: boolean;
  action: EventAction;
  /** One line beside the action saying what it does, or why there is none. */
  note: string;
}

export function eventDetailFacts({ event, joined, viewerId, ended, ticketsOnSale }: EventDetailInput): EventDetailFacts {
  const cancelled = event.status === "cancelled";
  const priced = event.priceCents != null;
  const isHost = !!viewerId && viewerId === event.creatorId;
  // Seats held by a paid checkout count too (events_readiness). Without that number, fall back to the going count.
  const spotsLeft = event.readiness?.spotsOpen != null ? event.readiness.spotsOpen : event.capacity !== null ? Math.max(0, event.capacity - event.attendeeCount) : null;
  const full = spotsLeft === 0;
  const open = !cancelled && !ended;

  const status: EventDetailFacts["status"] = cancelled
    ? { tone: "negative", label: "Cancelled" }
    : ended
      ? { tone: "neutral", label: "Ended" }
      : isHost
        ? { tone: "positive", label: "You're hosting" }
        : joined
          ? { tone: "positive", label: "You're going" }
          : full
            ? { tone: "warning", label: "Full" }
            : null;

  const action: EventAction = !open
    ? joined && cancelled
      ? "leave"
      : "none"
    : joined
      ? "leave"
      : priced && !isHost
        ? ticketsOnSale
          ? "ticket"
          : "none"
        : "join";

  const note = cancelled
    ? joined
      ? priced
        ? "You were on the list. Tickets are being refunded."
        : "You were on the list."
      : "This event is no longer taking people."
    : ended
      ? "This event is over."
      : isHost
        ? "You're on the list as the host."
        : joined
          ? "You're on the list."
          : full
            ? priced
              ? "Every spot is taken or being paid for."
              : "Every spot is taken. One opens if someone leaves."
            : priced
              ? ticketsOnSale
                ? "Buying a ticket holds your spot for 30 minutes while you pay."
                : "Tickets for this event can't be bought here right now."
              : "Join so the host knows you're coming.";

  return {
    status,
    cost: priced ? `${formatPrice(event.priceCents!)} per ticket` : "Free",
    priced,
    going: `${event.attendeeCount} going`,
    spots: event.capacity === null ? null : full ? "Full" : `${spotsLeft} of ${event.capacity} spot${event.capacity === 1 ? "" : "s"} left`,
    spotsLeft,
    full,
    action,
    note,
  };
}

/** The viewer's own clock is shown only when it differs from the event's. */
export function sameZoneAt(iso: string, a: string, b: string): boolean {
  if (a === b) return true;
  const at = new Date(iso);
  const stamp = (timeZone: string) =>
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  try {
    return stamp(a) === stamp(b);
  } catch {
    return false;
  }
}
