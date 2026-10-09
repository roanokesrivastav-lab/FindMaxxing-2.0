"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer } from "@/lib/auth/server";
import { getSiteUrl, paymentsMode } from "@/lib/config";
import { getRepository } from "@/lib/data";
import { MAX_PRICE_CENTS, MIN_PRICE_CENTS, paymentsError } from "@/lib/data/payments";
import { createHostOnboarding, createPlusCheckout, createPortal, createTicketCheckout, getStripe } from "@/server/payments/stripe";
import { serviceRepository } from "@/server/serviceRepository";
import { fail, succeed, toFailure, type ActionResult } from "./result";

const id = z.string().uuid();
const DAY = 86_400_000;

/** Every payments action: the flag (and, outside demo mode, Stripe keys) and someone signed in. */
async function paying() {
  const mode = paymentsMode();
  if (!mode) return { error: fail("Payments are not available", undefined, "unavailable") };
  const viewer = await getViewer();
  if (!viewer) return { error: fail("Sign in first", undefined, "unauthenticated") };
  return { viewer, mode };
}

/** The host sets or removes a ticket price (dollars). */
export async function setEventPriceAction(eventId: string, dollars: number | null): Promise<ActionResult> {
  const { viewer, error } = await paying();
  if (error) return error;
  if (!id.safeParse(eventId).success) return fail("Invalid event");
  const cents = dollars === null ? null : Math.round(dollars * 100);
  if (cents !== null && (!Number.isFinite(cents) || cents < MIN_PRICE_CENTS || cents > MAX_PRICE_CENTS)) return fail(paymentsError("bad_price").message, { price: paymentsError("bad_price").message });
  try {
    await (await getRepository()).payments.setEventPrice(viewer.id, eventId, cents);
    revalidatePath(`/events/${eventId}`);
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}

/** Holds a spot and returns where to pay: Stripe Checkout, or the labeled demo checkout. */
export async function buyTicketAction(eventId: string): Promise<ActionResult<{ url: string }>> {
  const { viewer, mode, error } = await paying();
  if (error) return error;
  if (!id.safeParse(eventId).success) return fail("Invalid event");
  try {
    const repo = await getRepository();
    const hold = await repo.payments.reserveTicket(viewer.id, eventId);
    if (mode === "demo") return succeed({ url: `/checkout/demo?ticket=${hold.ticketId}` });
    const stripe = await getStripe();
    if (!stripe) return fail("Payments are not available", undefined, "unavailable");
    const session = await createTicketCheckout(stripe, hold, { userId: viewer.id, eventId, origin: getSiteUrl(), email: viewer.email });
    await (await serviceRepository()).payments.attachCheckout(hold.ticketId, session.id);
    return succeed({ url: session.url });
  } catch (err) {
    return toFailure(err);
  }
}

/** Demo checkout: "pays" a held ticket. Refused outside demo mode; no money moves. */
export async function demoPayTicketAction(ticketId: string): Promise<ActionResult<{ eventId: string | null; outcome: string }>> {
  const { viewer, mode, error } = await paying();
  if (error) return error;
  if (mode !== "demo") return fail(paymentsError("demo_only").message, undefined, "forbidden");
  const repo = await getRepository();
  const ticket = (await repo.payments.myTickets(viewer.id)).find((t) => t.id === ticketId && t.status === "pending");
  if (!ticket) return fail("That checkout has ended", undefined, "not_found");
  await repo.payments.attachCheckout(ticket.id, `demo_cs_${ticket.id}`);
  const outcome = await repo.payments.confirmTicket(`demo_cs_${ticket.id}`, `demo_pi_${ticket.id}`, ticket.amountCents);
  if (outcome === "refund") for (const t of await repo.payments.ticketsToRefund()) await repo.payments.markRefunded(t.paymentIntentId);
  if (ticket.eventId) revalidatePath(`/events/${ticket.eventId}`);
  return succeed({ eventId: ticket.eventId, outcome });
}

export async function demoCancelCheckoutAction(ticketId: string): Promise<ActionResult> {
  const { viewer, mode, error } = await paying();
  if (error) return error;
  if (mode !== "demo") return fail(paymentsError("demo_only").message, undefined, "forbidden");
  const repo = await getRepository();
  const ticket = (await repo.payments.myTickets(viewer.id)).find((t) => t.id === ticketId && t.status === "pending");
  if (ticket) {
    await repo.payments.attachCheckout(ticket.id, `demo_cs_${ticket.id}`);
    await repo.payments.expireCheckout(`demo_cs_${ticket.id}`);
  }
  return succeed(undefined);
}

/** Start Plus: Stripe Checkout, or the demo checkout. */
export async function subscribePlusAction(): Promise<ActionResult<{ url: string }>> {
  const { viewer, mode, error } = await paying();
  if (error) return error;
  if (mode === "demo") return succeed({ url: "/checkout/demo?plan=plus" });
  const priceId = process.env.STRIPE_PLUS_PRICE_ID;
  const stripe = await getStripe();
  if (!priceId || !stripe) return fail("Plus is not set up yet", undefined, "unavailable");
  try {
    return succeed({ url: await createPlusCheckout(stripe, await serviceRepository(), { userId: viewer.id, email: viewer.email, priceId, origin: getSiteUrl() }) });
  } catch (err) {
    return toFailure(err);
  }
}

/** Manage or cancel Plus: Stripe's customer portal. */
export async function managePlusAction(): Promise<ActionResult<{ url: string }>> {
  const { viewer, mode, error } = await paying();
  if (error) return error;
  if (mode === "demo") return succeed({ url: "/checkout/demo?plan=manage" });
  const stripe = await getStripe();
  const customer = await (await getRepository()).payments.customerOf(viewer.id);
  if (!stripe || !customer) return fail("No subscription to manage", undefined, "not_found");
  try {
    return succeed({ url: await createPortal(stripe, customer, getSiteUrl()) });
  } catch (err) {
    return toFailure(err);
  }
}

/** Demo checkout for Plus: a month, then it lapses. Refused outside demo mode. */
export async function demoSetPlusAction(active: boolean): Promise<ActionResult> {
  const { viewer, mode, error } = await paying();
  if (error) return error;
  if (mode !== "demo") return fail(paymentsError("demo_only").message, undefined, "forbidden");
  const repo = await getRepository();
  await repo.payments.setEntitlement(viewer.id, active ? "active" : "canceled", active ? new Date(Date.now() + 30 * DAY).toISOString() : null, `demo_sub_${viewer.id}`);
  revalidatePath("/", "layout");
  return succeed(undefined);
}

/** Hosts: Stripe Connect onboarding, to be paid for tickets. Stripe mode only. */
export async function hostPayoutsAction(): Promise<ActionResult<{ url: string }>> {
  const { viewer, mode, error } = await paying();
  if (error) return error;
  if (mode === "demo") return fail("Demo mode has no payouts: you can price events without them", undefined, "unavailable");
  const stripe = await getStripe();
  if (!stripe) return fail("Payments are not available", undefined, "unavailable");
  try {
    return succeed({ url: await createHostOnboarding(stripe, await serviceRepository(), { userId: viewer.id, email: viewer.email, origin: getSiteUrl() }) });
  } catch (err) {
    return toFailure(err);
  }
}
