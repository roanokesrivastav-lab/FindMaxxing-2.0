/**
 * Demo-mode payments. Mirrors 0022_payments.sql: holds that count against
 * capacity, idempotent confirmation, refunds on cancellation, Plus. No money
 * moves: the demo checkout (src/app/checkout/demo) calls the service methods.
 */
import type { DataRepository } from "../repository";
import { DataError, type Entitlement, type Ticket } from "../types";
import { HOLD_MINUTES, MAX_PRICE_CENTS, MIN_PRICE_CENTS, paymentsError } from "../payments";
import type { RateLimitAction } from "@/lib/rateLimits";
import { newId } from "@/lib/utils/ids";
import { leaveEventChat, joinEventChat } from "./messaging";
import type { DemoState, EventRow, TicketRow } from "./store";

const LIVE = new Set(["pending", "paid", "refund_pending"]);
const ended = (e: EventRow) => Date.parse(e.endsAt ?? e.startsAt) < Date.now();

/** Mirrors is_plus(). */
export function isPlusIn(state: DemoState, userId: string | null, now = Date.now()): boolean {
  const e = userId ? state.entitlements.find((x) => x.userId === userId) : null;
  return !!e && ["active", "trialing", "past_due"].includes(e.status) && (!e.currentPeriodEnd || Date.parse(e.currentPeriodEnd) > now);
}

/** Mirrors refund_on_cancel(): holds end, paid tickets wait for their refund. */
export function refundOnCancel(state: DemoState, eventId: string) {
  for (const t of state.tickets) {
    if (t.eventId !== eventId) continue;
    if (t.status === "pending") t.status = "expired";
    else if (t.status === "paid") t.status = "refund_pending";
  }
}

/** Mirrors check_event_join()'s ticket rule. */
export function needsTicket(state: DemoState, event: EventRow, userId: string): boolean {
  return event.priceCents != null && event.creatorId !== userId
    && !state.tickets.some((t) => t.eventId === event.id && t.userId === userId && t.status === "paid");
}

export function createDemoPayments(state: DemoState, h: {
  persist(): void;
  assertActive(userId: string): void;
  rateLimit(userId: string, action: RateLimitAction): () => void;
  canViewEvent(event: EventRow, viewerId: string): boolean;
}): DataRepository["payments"] {
  const toTicket = (t: TicketRow): Ticket => {
    const e = t.eventId ? state.events.find((x) => x.id === t.eventId) : null;
    return {
      id: t.id, eventId: t.eventId, eventTitle: e?.title ?? null, eventStartsAt: e?.startsAt ?? null, status: t.status,
      amountCents: t.amountCents, currency: t.currency, createdAt: t.createdAt, expiresAt: t.expiresAt, paidAt: t.paidAt, refundedAt: t.refundedAt,
    };
  };
  const syncSupporter = (userId: string) => {
    const p = state.profiles.find((x) => x.id === userId);
    if (p) p.supporter = isPlusIn(state, userId);
  };
  return {
    async isClosing(userId) { return !state.profiles.some((p) => p.id === userId); },
    async isPlus(userId) {
      return isPlusIn(state, userId);
    },
    async entitlement(userId) {
      const e = state.entitlements.find((x) => x.userId === userId);
      return e ? ({ plan: "plus", status: e.status, currentPeriodEnd: e.currentPeriodEnd, active: isPlusIn(state, userId) } satisfies Entitlement) : null;
    },
    async canSell() {
      return true; // no payouts in demo mode
    },
    async setEventPrice(ownerId, eventId, cents) {
      h.assertActive(ownerId);
      const e = state.events.find((x) => x.id === eventId);
      if (!e || e.creatorId !== ownerId) throw paymentsError("not_found");
      if (e.status !== "published" || ended(e)) throw paymentsError("event_closed");
      if (cents !== null && (!Number.isInteger(cents) || cents < MIN_PRICE_CENTS || cents > MAX_PRICE_CENTS)) throw paymentsError("bad_price");
      if (state.tickets.some((t) => t.eventId === eventId && LIVE.has(t.status)) || state.eventAttendees.some((a) => a.eventId === eventId && a.userId !== e.creatorId)) {
        throw paymentsError("price_locked");
      }
      e.priceCents = cents;
      h.persist();
    },
    async reserveTicket(userId, eventId) {
      h.assertActive(userId);
      const e = state.events.find((x) => x.id === eventId);
      if (!e || !h.canViewEvent(e, userId)) throw paymentsError("not_found");
      if (e.status !== "published" || ended(e)) throw paymentsError("event_closed");
      if (e.priceCents == null) throw paymentsError("free_event");
      if (e.creatorId === userId || state.eventAttendees.some((a) => a.eventId === eventId && a.userId === userId)) throw paymentsError("already_going");
      const now = Date.now();
      for (const t of state.tickets) if (t.eventId === eventId && t.status === "pending" && Date.parse(t.expiresAt) <= now) t.status = "expired";
      let t = state.tickets.find((x) => x.eventId === eventId && x.userId === userId && LIVE.has(x.status));
      if (t && t.status !== "pending") throw paymentsError("already_going");
      if (!t) {
        if (e.capacity !== null) {
          const taken = state.eventAttendees.filter((a) => a.eventId === eventId).length + state.tickets.filter((x) => x.eventId === eventId && x.status === "pending").length;
          if (taken >= e.capacity) throw new DataError("This event is full", "full");
        }
        const counted = h.rateLimit(userId, "tickets");
        t = {
          id: newId(), eventId, userId, status: "pending", amountCents: e.priceCents, currency: "usd", checkoutSessionId: null, paymentIntentId: null,
          expiresAt: new Date(now + HOLD_MINUTES * 60_000).toISOString(), createdAt: new Date(now).toISOString(), paidAt: null, refundedAt: null,
        };
        state.tickets.push(t);
        counted();
        h.persist();
      }
      return { ticketId: t.id, amountCents: t.amountCents, currency: t.currency, expiresAt: t.expiresAt, eventTitle: e.title, hostAccount: null };
    },
    async myTickets(userId) {
      return state.tickets.filter((t) => t.userId === userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1)).map(toTicket);
    },
    async ticketSummary(ownerId, eventId) {
      const e = state.events.find((x) => x.id === eventId);
      if (!e || e.creatorId !== ownerId) return null;
      const mine = state.tickets.filter((t) => t.eventId === eventId);
      return {
        paid: mine.filter((t) => t.status === "paid").length,
        pending: mine.filter((t) => t.status === "pending" && Date.parse(t.expiresAt) > Date.now()).length,
        refunded: mine.filter((t) => t.status === "refund_pending" || t.status === "refunded").length,
        revenueCents: mine.filter((t) => t.status === "paid").reduce((n, t) => n + t.amountCents, 0),
      };
    },
    async customerOf(userId) {
      return state.stripeCustomers.find((c) => c.userId === userId)?.customerId ?? null;
    },
    async hostAccountOf(userId) {
      return state.hostAccounts.find((a) => a.userId === userId)?.accountId ?? null;
    },
    async attachCheckout(ticketId, sessionId) {
      const t = state.tickets.find((x) => x.id === ticketId && x.status === "pending");
      if (t) {
        t.checkoutSessionId = sessionId;
        h.persist();
      }
    },
    async confirmTicket(sessionId, paymentIntentId, amountCents) {
      const t = state.tickets.find((x) => x.checkoutSessionId === sessionId);
      if (!t) return "unknown";
      if (t.status !== "pending" && t.status !== "expired") return "duplicate";
      const refund = () => {
        t.status = "refund_pending";
        t.paymentIntentId = paymentIntentId;
        h.persist();
        return "refund" as const;
      };
      if (t.status === "expired" || Date.parse(t.expiresAt) <= Date.now()) return refund();
      if (amountCents !== t.amountCents) return refund();
      const e = state.events.find((x) => x.id === t.eventId);
      const going = state.eventAttendees.filter((a) => a.eventId === t.eventId);
      if (!e || e.status !== "published" || ended(e) || !t.userId) return refund();
      if (!going.some((a) => a.userId === t.userId)) {
        if (e.capacity !== null && going.length >= e.capacity) return refund();
        state.eventAttendees.push({ eventId: e.id, userId: t.userId, createdAt: new Date().toISOString() });
        joinEventChat(state, e.id, t.userId);
      }
      Object.assign(t, { status: "paid", paymentIntentId, paidAt: new Date().toISOString() });
      h.persist();
      return "confirmed";
    },
    async expireCheckout(sessionId) {
      const t = state.tickets.find((x) => x.checkoutSessionId === sessionId && x.status === "pending");
      if (t) {
        t.status = "expired";
        h.persist();
      }
    },
    async ticketsToRefund() {
      return state.tickets.filter((t) => t.status === "refund_pending" && t.paymentIntentId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1))
        .map((t) => ({ ticketId: t.id, paymentIntentId: t.paymentIntentId! }));
    },
    async markRefunded(paymentIntentId) {
      const t = state.tickets.find((x) => x.paymentIntentId === paymentIntentId && (x.status === "paid" || x.status === "refund_pending"));
      if (!t) return;
      t.status = "refunded";
      t.refundedAt ??= new Date().toISOString();
      state.eventAttendees = state.eventAttendees.filter((a) => !(a.eventId === t.eventId && a.userId === t.userId));
      if (t.eventId && t.userId) leaveEventChat(state, t.eventId, t.userId);
      h.persist();
    },
    async setEntitlement(userId, status, periodEnd, subscriptionId) {
      if (!state.profiles.some((p) => p.id === userId)) return;
      const row = state.entitlements.find((x) => x.userId === userId);
      const updatedAt = new Date().toISOString();
      if (row) Object.assign(row, { status, currentPeriodEnd: periodEnd, subscriptionId, updatedAt });
      else state.entitlements.push({ userId, status, currentPeriodEnd: periodEnd, subscriptionId, updatedAt });
      syncSupporter(userId);
      h.persist();
    },
    async linkCustomer(userId, customerId) {
      if (!state.profiles.some((p) => p.id === userId)) return;
      state.stripeCustomers = state.stripeCustomers.filter((c) => c.userId !== userId);
      state.stripeCustomers.push({ userId, customerId });
      h.persist();
    },
    async setHostAccount(userId, accountId, chargesEnabled) {
      if (!state.profiles.some((p) => p.id === userId)) return;
      state.hostAccounts = state.hostAccounts.filter((a) => a.userId !== userId);
      state.hostAccounts.push({ userId, accountId, chargesEnabled });
      h.persist();
    },
    async recordStripeEvent(id, type, objectId) {
      if (state.stripeEvents.some((e) => e.id === id)) return false;
      state.stripeEvents.push({ id, type, objectId, receivedAt: new Date().toISOString() });
      h.persist();
      return true;
    },
    async claimStripeEvent(id, type, objectId, userId) {
      let e = state.stripeEvents.find((x) => x.id === id);
      if (e && (!e.state || e.state === "complete")) return { state: "complete", outcome: e.outcome ?? "processed" };
      const scope = userId ? `user:${userId}` : `event:${id}`;
      if (state.stripeEvents.some((x) => x.state === "processing" && (x.id === id || x.scope === scope) && Date.parse(x.leasedUntil ?? "") > Date.now())) return { state: "busy" };
      if (!e) { e = { id, type, objectId, receivedAt: new Date().toISOString() }; state.stripeEvents.push(e); }
      const token = newId();
      Object.assign(e, { state: "processing", token, scope, leasedUntil: new Date(Date.now() + 5 * 60_000).toISOString() });
      h.persist();
      return { state: "claimed", token };
    },
    async finishStripeEvent(id, token, outcome, plan) {
      const e = state.stripeEvents.find((x) => x.id === id && x.state === "processing" && x.token === token);
      if (!e || Date.parse(e.leasedUntil ?? "") <= Date.now()
        || state.stripeEvents.some((x) => x.id !== id && x.scope === e.scope && x.state === "processing" && x.token !== token && Date.parse(x.leasedUntil ?? "") > Date.now())) throw new Error("Stripe event lease lost");
      if (plan) {
        if (e.scope !== `user:${plan.userId}`) throw new Error("Stripe plan scope mismatch");
        // No await between validation, plan mutation and event completion.
        if (state.profiles.some((p) => p.id === plan.userId)) {
          const customer = state.stripeCustomers.find((c) => c.userId === plan.userId);
          if (plan.customerId && customer && customer.customerId !== plan.customerId) throw new Error("Stripe customer changed");
          if (plan.customerId && !customer) state.stripeCustomers.push({ userId: plan.userId, customerId: plan.customerId });
          const row = state.entitlements.find((x) => x.userId === plan.userId);
          const fields = { userId: plan.userId, status: plan.status, currentPeriodEnd: plan.periodEnd, subscriptionId: plan.subscriptionId, updatedAt: new Date().toISOString() };
          if (row) Object.assign(row, fields); else state.entitlements.push(fields);
          syncSupporter(plan.userId);
        }
      }
      Object.assign(e, { state: "complete", outcome, token: undefined, scope: undefined, leasedUntil: undefined }); h.persist();
    },
    async releaseStripeEvent(id, token) {
      const e = state.stripeEvents.find((x) => x.id === id && x.state === "processing" && x.token === token);
      if (e) { Object.assign(e, { state: "pending", token: undefined, scope: undefined, leasedUntil: undefined }); h.persist(); }
    },
  };
}
