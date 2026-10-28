/**
 * Payments (Session 17): paid tickets with holds that count against capacity,
 * idempotent confirmation, refunds on cancellation, Plus perks, owner-only
 * money records, Stripe webhooks verified and replayed from fixture payloads,
 * the demo checkout, and parity with the demo store. Stripe itself is mocked:
 * no request leaves the machine.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import Stripe from "stripe";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore, migrateDemoState, buildSeedState } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { deleteDemoAccount } from "../src/lib/data/demo/account";
import type { DataRepository } from "../src/lib/data/repository";
import type { NewEventInput } from "../src/lib/data/types";
import { SEED_USERS } from "../src/lib/seed/seed-data";

vi.mock("server-only", () => ({}));
const { handleStripeEvent } = await import("../src/server/payments/webhook");
const { processRefunds, createTicketCheckout } = await import("../src/server/payments/stripe");

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, theo, jules, nina, dev, lena] = ["maya_r", "theo", "jules", "nina", "dev", "lena"].map(user);
const tomorrow = () => new Date(Date.now() + 2 * 86_400_000).toISOString();

describe("payments in the database", () => {
  let db: PGlite;
  let ev: string; // dev's event, capacity 3 (dev + 2)
  const as = <T = Record<string, unknown>>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const service = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => {
    await db.exec("set role service_role");
    try {
      return (await db.query<T>(sql, p)).rows;
    } finally {
      await db.exec("reset role");
    }
  };
  const reserve = async (id: string) => (await as<{ ticket_id: string; amount_cents: number; host_account: string | null }>(id, "select * from public.reserve_ticket($1)", [ev]))[0];
  const status = async (ticket: string) => (await db.query<{ status: string }>("select status from public.tickets where id = $1", [ticket])).rows[0].status;
  const going = async () => (await db.query<{ user_id: string }>("select user_id from public.event_attendees where event_id = $1", [ev])).rows.map((r) => r.user_id).sort();

  beforeAll(async () => {
    db = await createSeededDb();
    const cat = (await db.query<{ category_slug: string }>("select category_slug from public.events limit 1")).rows[0].category_slug;
    ev = (await db.query<{ id: string }>(`insert into public.events (title, description, location_name, lat, lng, starts_at, creator_id, category_slug, capacity)
      values ('Paid supper club', 'A long enough description', 'Somewhere', 39.96, -83, $1, $2, $3, 3) returning id`, [tomorrow(), dev, cat])).rows[0].id;
    await db.query("insert into public.event_attendees (event_id, user_id) values ($1, $2)", [ev, dev]);
  });

  it("prices only through set_event_price, by the host, with payouts set up", async () => {
    // Column grants already refuse it; the guard trigger is a second line.
    await expect(as(dev, "update public.events set price_cents = 1500 where id = $1", [ev])).rejects.toThrow(/permission denied|payments:price_via_function/);
    await expect(as(maya, "select public.set_event_price($1, 1500)", [ev])).rejects.toThrow(/payments:not_found/);
    await expect(as(dev, "select public.set_event_price($1, 1500)", [ev])).rejects.toThrow(/payments:no_payout_account/);
    await expect(as(dev, "select public.set_host_account($1, 'acct_1', true)", [dev])).rejects.toThrow(/permission denied/);
    await service("select public.set_host_account($1, 'acct_dev', true)", [dev]);
    await expect(as(dev, "select public.set_event_price($1, 50)", [ev])).rejects.toThrow(/payments:bad_price/);
    await as(dev, "select public.set_event_price($1, 1500)", [ev]);
    expect((await db.query("select price_cents from public.events where id = $1", [ev])).rows).toEqual([{ price_cents: 1500 }]);
  });

  it("refuses a plain join to a paid event", async () => {
    await expect(as(maya, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [ev])).rejects.toThrow(/payments:ticket_required/);
  });

  it("holds spots against capacity, reuses a hold, and frees it when it lapses", async () => {
    const a = await reserve(maya);
    expect(a).toMatchObject({ amount_cents: 1500, host_account: "acct_dev" });
    expect((await reserve(maya)).ticket_id).toBe(a.ticket_id);
    const b = await reserve(theo);
    await expect(reserve(jules)).rejects.toThrow(/full/); // dev + two holds = 3
    await expect(as(dev, "select * from public.reserve_ticket($1)", [ev])).rejects.toThrow(/payments:already_going/);
    await db.query("update public.tickets set expires_at = now() - interval '1 minute' where id = $1", [b.ticket_id]);
    const c = await reserve(jules);
    expect(await status(b.ticket_id)).toBe("expired");
    // The price is locked once tickets exist.
    await expect(as(dev, "select public.set_event_price($1, 2000)", [ev])).rejects.toThrow(/payments:price_locked/);
    // Holds and confirmation take the event row lock, like check_event_join().
    expect((await db.query<{ d: string }>("select pg_get_functiondef('public.reserve_ticket(uuid)'::regprocedure) as d")).rows[0].d).toMatch(/for update/);
    void c;
  });

  it("keeps money records private and client-proof", async () => {
    expect(await as(theo, "select * from public.tickets where user_id = $1", [maya])).toEqual([]);
    expect((await as(maya, "select * from public.tickets")).length).toBe(1);
    await expect(as(maya, "update public.tickets set status = 'paid' where user_id = auth.uid()")).rejects.toThrow(/permission denied/);
    await expect(as(maya, "insert into public.entitlements (user_id, status) values (auth.uid(), 'active')")).rejects.toThrow(/permission denied/);
    await expect(as(maya, "select * from public.stripe_events")).rejects.toThrow(/permission denied/);
    await expect(as(maya, "update public.profiles set supporter = true where id = auth.uid()")).rejects.toThrow(/permission denied|supporter_is_earned/);
    for (const f of ["select public.confirm_ticket('cs', 'pi', 1500)", "select * from public.tickets_to_refund()", "select public.record_stripe_event('evt', 't', null)"]) {
      await expect(as(maya, f)).rejects.toThrow(/permission denied/);
    }
    // The host sees totals for their own event only.
    expect(await as(dev, "select * from public.event_ticket_summary($1)", [ev])).toEqual([{ paid: 0, pending: 2, refunded: 0, revenue_cents: 0 }]);
    expect(await as(maya, "select * from public.event_ticket_summary($1)", [ev])).toEqual([{ paid: 0, pending: 0, refunded: 0, revenue_cents: 0 }]);
  });

  it("confirms a paid checkout once, and refunds what cannot become a ticket", async () => {
    const t = (await db.query<{ id: string; user_id: string }>("select id, user_id from public.tickets where event_id = $1 and status = 'pending' order by created_at", [ev])).rows;
    await service("select public.attach_checkout_session($1, 'cs_a')", [t[0].id]);
    await service("select public.attach_checkout_session($1, 'cs_b')", [t[1].id]);
    expect(await service("select public.confirm_ticket('cs_a', 'pi_a', 1500) as r")).toEqual([{ r: "confirmed" }]);
    expect(await service("select public.confirm_ticket('cs_a', 'pi_a', 1500) as r")).toEqual([{ r: "duplicate" }]);
    expect(await service("select public.confirm_ticket('cs_nope', 'pi_x', 1500) as r")).toEqual([{ r: "unknown" }]);
    expect(await service("select public.confirm_ticket('cs_b', 'pi_b', 999) as r")).toEqual([{ r: "refund" }]);
    expect(await going()).toEqual([dev, t[0].user_id].sort());
    expect(await status(t[1].id)).toBe("refund_pending");
    // The ticket holder could leave and come back: the ticket lets them in.
    await as(t[0].user_id, "delete from public.event_attendees where event_id = $1 and user_id = auth.uid()", [ev]);
    await as(t[0].user_id, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [ev]);
  });

  it("refunds every ticket when the host cancels, and frees the places when Stripe confirms", async () => {
    await as(dev, "update public.events set status = 'cancelled' where id = $1", [ev]);
    const due = await service<{ ticket_id: string; payment_intent_id: string }>("select * from public.tickets_to_refund()");
    expect(due.map((d) => d.payment_intent_id).sort()).toEqual(["pi_a", "pi_b"]);
    for (const d of due) await service("select public.mark_ticket_refunded($1)", [d.payment_intent_id]);
    await service("select public.mark_ticket_refunded('pi_a')"); // redelivery
    expect((await db.query("select status from public.tickets where event_id = $1 and payment_intent_id is not null", [ev])).rows).toEqual([{ status: "refunded" }, { status: "refunded" }]);
    expect(await going()).toEqual([dev]);
    expect(await service("select * from public.tickets_to_refund()")).toEqual([]);
  });

  it("gives Plus its perks and its badge, and takes them back", async () => {
    const lists = async () => {
      await db.query("delete from public.saved_lists where owner_id = $1", [nina]);
      await db.query("insert into public.saved_lists (owner_id, name) select $1, 'List ' || g from generate_series(1, 100) g", [nina]);
      return as(nina, "insert into public.saved_lists (owner_id, name) values (auth.uid(), 'One more')").then(() => "ok", (e: Error) => e.message);
    };
    expect(await lists()).toMatch(/at most 100 lists/);
    await service("select public.set_entitlement($1, 'active', now() + interval '30 days', 'sub_1')", [nina]);
    expect((await db.query("select supporter from public.profiles where id = $1", [nina])).rows).toEqual([{ supporter: true }]);
    expect(await lists()).toBe("ok");
    for (let i = 0; i < 30; i++) await as(nina, "select public.consume_trip_plan()");
    await expect(as(nina, "select public.consume_trip_plan()")).rejects.toThrow(/rate_limited:trip_plans_plus/);
    await service("select public.set_entitlement($1, 'canceled', null, 'sub_1')", [nina]);
    expect((await db.query("select supporter from public.profiles where id = $1", [nina])).rows).toEqual([{ supporter: false }]);
    expect((await as<{ p: boolean }>(nina, "select public.is_plus(auth.uid()) as p"))[0].p).toBe(false);
    // An active plan past its period end no longer counts.
    await service("select public.set_entitlement($1, 'active', now() - interval '1 day', 'sub_1')", [nina]);
    expect((await as<{ p: boolean }>(nina, "select public.is_plus(auth.uid()) as p"))[0].p).toBe(false);
  });

  it("records each Stripe event once", async () => {
    expect(await service("select public.record_stripe_event('evt_1', 'charge.refunded', 'ch_1') as r")).toEqual([{ r: true }]);
    expect(await service("select public.record_stripe_event('evt_1', 'charge.refunded', 'ch_1') as r")).toEqual([{ r: false }]);
  });
});

// ----------------------------------------------------------------------------
// Demo repository and parity
// ----------------------------------------------------------------------------
const newEvent = (repo: DataRepository, host: string, capacity: number | null, categorySlug: string): Promise<{ id: string }> =>
  repo.events.create({ title: "Paid supper club", description: "A long enough description", locationName: "Somewhere", lat: 39.96, lng: -83, startsAt: tomorrow(), categorySlug, capacity, tags: [] } satisfies NewEventInput, host);

describe("payments in demo mode", () => {
  let handle: ReturnType<typeof createIsolatedStore>;
  let repo: DataRepository;
  let cat: string;
  beforeEach(() => {
    handle = createIsolatedStore();
    repo = createDemoRepository(handle);
    cat = handle.state.events[0].categorySlug;
  });
  const pay = async (ticketId: string, amount = 1500) => {
    await repo.payments.attachCheckout(ticketId, `cs_${ticketId}`);
    return repo.payments.confirmTicket(`cs_${ticketId}`, `pi_${ticketId}`, amount);
  };

  it("follows the same rules as the database", async () => {
    const ev = await newEvent(repo, dev, 3, cat);
    await expect(repo.payments.setEventPrice(maya, ev.id, 1500)).rejects.toMatchObject({ code: "not_found" });
    await expect(repo.payments.setEventPrice(dev, ev.id, 50)).rejects.toMatchObject({ code: "invalid" });
    await repo.payments.setEventPrice(dev, ev.id, 1500);
    await expect(repo.events.join(maya, ev.id)).rejects.toMatchObject({ code: "forbidden", message: "This event needs a ticket" });
    const a = await repo.payments.reserveTicket(maya, ev.id);
    expect((await repo.payments.reserveTicket(maya, ev.id)).ticketId).toBe(a.ticketId);
    const b = await repo.payments.reserveTicket(theo, ev.id);
    await expect(repo.payments.reserveTicket(jules, ev.id)).rejects.toMatchObject({ code: "full" });
    await expect(repo.payments.setEventPrice(dev, ev.id, 2000)).rejects.toMatchObject({ code: "conflict" });
    expect(await pay(a.ticketId)).toBe("confirmed");
    expect(await pay(a.ticketId)).toBe("duplicate");
    expect(await pay(b.ticketId, 999)).toBe("refund");
    expect((await repo.events.get(ev.id, maya))!.viewerJoined).toBe(true);
    // Maya is in the group chat too.
    expect(await repo.messaging.eventConversation(maya, ev.id)).not.toBeNull();
    expect(await repo.payments.ticketSummary(dev, ev.id)).toEqual({ paid: 1, pending: 0, refunded: 1, revenueCents: 1500 });
    expect(await repo.payments.ticketSummary(maya, ev.id)).toBeNull();
    await repo.events.cancel(ev.id, dev);
    expect((await repo.payments.ticketsToRefund()).map((t) => t.paymentIntentId).sort()).toEqual([`pi_${a.ticketId}`, `pi_${b.ticketId}`].sort());
    for (const t of await repo.payments.ticketsToRefund()) await repo.payments.markRefunded(t.paymentIntentId);
    expect((await repo.payments.myTickets(maya)).map((t) => t.status)).toEqual(["refunded"]);
    expect(handle.state.eventAttendees.filter((x) => x.eventId === ev.id).map((x) => x.userId)).toEqual([dev]);
  });

  it("gives Plus more lists and trip plans, and the badge", async () => {
    for (let i = 0; i < 100; i++) handle.state.savedLists.push({ id: crypto.randomUUID(), ownerId: nina, name: `L${i}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await expect(repo.savedLists.create(nina, "One more")).rejects.toMatchObject({ code: "full" });
    await repo.payments.setEntitlement(nina, "active", new Date(Date.now() + 86_400_000).toISOString(), "sub");
    await repo.savedLists.create(nina, "One more");
    expect((await repo.profiles.getById(nina))!.supporter).toBe(true);
    for (let i = 0; i < 30; i++) await repo.limits.consume(nina, "trip_plans");
    await expect(repo.limits.consume(nina, "trip_plans")).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("keeps money records, anonymized, when a buyer deletes their account", async () => {
    const ev = await newEvent(repo, dev, null, cat);
    await repo.payments.setEventPrice(dev, ev.id, 1500);
    const a = await repo.payments.reserveTicket(maya, ev.id);
    await pay(a.ticketId);
    deleteDemoAccount(handle, maya);
    expect(handle.state.tickets.map((t) => [t.userId, t.status])).toEqual([[null, "paid"]]);
  });

  it("migrates a v10 store with every event free", () => {
    const v10 = buildSeedState() as unknown as Record<string, unknown>;
    for (const k of ["tickets", "hostAccounts", "entitlements", "stripeCustomers", "stripeEvents"]) delete v10[k];
    v10.version = 10;
    const r = migrateDemoState(v10);
    expect(r.ok && r.state.tickets).toEqual([]);
  });
});

describe("payments parity", () => {
  it("ends with the same tickets and attendees in SQL and the demo store", async () => {
    const db = await createSeededDb();
    const repo = createDemoRepository(createIsolatedStore());
    const cat = (await db.query<{ category_slug: string }>("select category_slug from public.events limit 1")).rows[0].category_slug;
    const sqlEv = (await queryAs<{ id: string }>(db, dev, `insert into public.events (title, description, location_name, lat, lng, starts_at, creator_id, category_slug, capacity)
      values ('Paid supper club', 'A long enough description', 'Somewhere', 39.96, -83, $1, auth.uid(), $2, 3) returning id`, [tomorrow(), cat]))[0].id;
    await queryAs(db, dev, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid()) on conflict do nothing", [sqlEv]);
    await db.exec("set role service_role");
    await db.query("select public.set_host_account($1, 'acct', true)", [dev]);
    await db.exec("reset role");
    await queryAs(db, dev, "select public.set_event_price($1, 1500)", [sqlEv]);
    const demoEv = (await newEvent(repo, dev, 3, cat)).id;
    await repo.payments.setEventPrice(dev, demoEv, 1500);

    const outcomes: string[][] = [[], []];
    for (const [i, u] of [maya, theo, jules].entries()) {
      const sqlHold = await queryAs<{ ticket_id: string }>(db, u, "select * from public.reserve_ticket($1)", [sqlEv]).then((r) => r[0].ticket_id, (e: Error) => `error:${/full/.test(e.message) ? "full" : e.message}`);
      const demoHold = await repo.payments.reserveTicket(u, demoEv).then((r) => r.ticketId, (e: Error) => `error:${/full/.test(e.message) ? "full" : e.message}`);
      outcomes[0].push(sqlHold.startsWith("error") ? sqlHold : "held");
      outcomes[1].push(demoHold.startsWith("error") ? demoHold : "held");
      if (i === 0 && !sqlHold.startsWith("error")) {
        await db.exec("set role service_role");
        await db.query("select public.attach_checkout_session($1, 'cs1')", [sqlHold]);
        outcomes[0].push((await db.query<{ r: string }>("select public.confirm_ticket('cs1', 'pi1', 1500) as r")).rows[0].r);
        await db.exec("reset role");
        await repo.payments.attachCheckout(demoHold, "cs1");
        outcomes[1].push(await repo.payments.confirmTicket("cs1", "pi1", 1500));
      }
    }
    expect(outcomes[1]).toEqual(outcomes[0]);
    const sqlState = (await db.query<{ status: string }>("select status from public.tickets order by status")).rows.map((r) => r.status);
    expect((await repo.payments.myTickets(maya)).concat(await repo.payments.myTickets(theo), await repo.payments.myTickets(jules)).map((t) => t.status).sort()).toEqual(sqlState);
  }, 120_000);
});

// ----------------------------------------------------------------------------
// Stripe: webhooks from fixture payloads, refunds, checkout requests (mocked)
// ----------------------------------------------------------------------------
const fakeStripe = () => {
  const calls: { method: string; args: unknown[] }[] = [];
  const subscriptions = new Map<string, Stripe.Subscription>();
  const rec = (method: string, result: unknown) => vi.fn(async (...args: unknown[]) => (calls.push({ method, args }), result));
  return {
    calls,
    subscriptions,
    stripe: {
      subscriptions: { retrieve: vi.fn(async (id: string) => subscriptions.get(id)), list: vi.fn(async () => ({ data: [...subscriptions.values()], has_more: false })) },
      checkout: { sessions: { create: rec("checkout.sessions.create", { id: "cs_test_1", url: "https://checkout.stripe.test/cs_test_1" }) } },
      refunds: { create: rec("refunds.create", { id: "re_1" }) },
      billingPortal: { sessions: { create: rec("billingPortal.sessions.create", { url: "https://billing.stripe.test" }) } },
      customers: { create: rec("customers.create", { id: "cus_1" }) },
      accounts: { create: rec("accounts.create", { id: "acct_1" }) },
      accountLinks: { create: rec("accountLinks.create", { url: "https://connect.stripe.test" }) },
      webhooks: new Stripe("sk_test_fake").webhooks,
    } as never,
  };
};
const event = (id: string, type: string, object: Record<string, unknown>) => ({ id, type, object: "event", data: { object } }) as unknown as Stripe.Event;

describe("Stripe webhooks and jobs", () => {
  let handle: ReturnType<typeof createIsolatedStore>;
  let repo: DataRepository;
  beforeEach(() => {
    handle = createIsolatedStore();
    repo = createDemoRepository(handle);
  });

  it("confirms tickets, expires checkouts, follows subscriptions and refunds, each once", async () => {
    const ev = await newEvent(repo, dev, null, handle.state.events[0].categorySlug);
    await repo.payments.setEventPrice(dev, ev.id, 1500);
    const hold = await repo.payments.reserveTicket(maya, ev.id);
    await repo.payments.attachCheckout(hold.ticketId, "cs_1");
    const { stripe, calls, subscriptions } = fakeStripe();
    const completed = event("evt_1", "checkout.session.completed", { id: "cs_1", mode: "payment", payment_status: "paid", currency: "usd", metadata: { ticket_id: hold.ticketId }, payment_intent: "pi_1", amount_total: 1500 });
    expect(await handleStripeEvent(completed, repo, stripe)).toBe("confirmed");
    expect(await handleStripeEvent(completed, repo, stripe)).toBe("duplicate:confirmed");
    // A payment through a replaced checkout is refunded.
    const stale = event("evt_2", "checkout.session.completed", { id: "cs_old", mode: "payment", payment_status: "paid", currency: "usd", metadata: { ticket_id: hold.ticketId }, payment_intent: "pi_old", amount_total: 1500 });
    expect(await handleStripeEvent(stale, repo, stripe)).toBe("unknown");
    expect(calls).toEqual([{ method: "refunds.create", args: [{ payment_intent: "pi_old", reverse_transfer: true }, { idempotencyKey: "refund:session:cs_old" }] }]);

    const sub = { id: "sub_1", status: "active", created: 1, customer: "cus_sub", metadata: { user_id: theo }, items: { data: [{ current_period_end: Math.floor(Date.now() / 1000) + 86_400 }] } };
    subscriptions.set(sub.id, sub as unknown as Stripe.Subscription);
    expect(await handleStripeEvent(event("evt_3", "customer.subscription.created", sub), repo, stripe)).toBe("plan_active");
    expect(await repo.payments.isPlus(theo)).toBe(true);
    subscriptions.set(sub.id, { ...sub, status: "canceled" } as unknown as Stripe.Subscription);
    expect(await handleStripeEvent(event("evt_4", "customer.subscription.deleted", sub), repo, stripe)).toBe("plan_canceled");
    expect(await repo.payments.isPlus(theo)).toBe(false);

    await handleStripeEvent(event("evt_5", "account.updated", { id: "acct_9", charges_enabled: true, metadata: { user_id: lena } }), repo, stripe);
    expect(await repo.payments.hostAccountOf(lena)).toBe("acct_9");

    await repo.events.cancel(ev.id, dev);
    expect(await processRefunds(repo, stripe)).toEqual({ requested: 1, failed: 0 });
    expect(await processRefunds(repo, stripe)).toEqual({ requested: 1, failed: 0 }); // retried until the webhook arrives...
    expect(calls.filter((c) => c.method === "refunds.create").slice(1).map((c) => (c.args[1] as { idempotencyKey: string }).idempotencyKey)).toEqual([`refund:${hold.ticketId}`, `refund:${hold.ticketId}`]); // ...with one idempotency key
    await handleStripeEvent(event("evt_6", "charge.refunded", { id: "ch_1", refunded: true, payment_intent: "pi_1" }), repo, stripe);
    expect(await repo.payments.ticketsToRefund()).toEqual([]);
    expect((await repo.payments.myTickets(maya))[0].status).toBe("refunded");
    expect(handle.state.stripeEvents.map((e) => e.id)).toEqual(["evt_1", "evt_2", "evt_3", "evt_4", "evt_5", "evt_6"]);
  });

  it("asks Stripe for a destination charge that pays the host", async () => {
    const { stripe, calls } = fakeStripe();
    vi.stubEnv("TICKET_PLATFORM_FEE_BPS", "500");
    await createTicketCheckout(stripe, { ticketId: "t1", amountCents: 2000, currency: "usd", expiresAt: new Date().toISOString(), eventTitle: "Supper", hostAccount: "acct_host" }, { userId: maya, eventId: "e1", origin: "https://findmaxxing.test" });
    vi.unstubAllEnvs();
    const params = calls[0].args[0] as Stripe.Checkout.SessionCreateParams;
    expect(params).toMatchObject({ mode: "payment", metadata: { ticket_id: "t1" }, payment_intent_data: { transfer_data: { destination: "acct_host" }, application_fee_amount: 100 } });
    expect(params.expires_at! - Math.floor(Date.now() / 1000)).toBeGreaterThanOrEqual(30 * 60);
    await expect(createTicketCheckout(stripe, { ticketId: "t1", amountCents: 2000, currency: "usd", expiresAt: "", eventTitle: "x", hostAccount: null }, { userId: maya, eventId: "e1", origin: "" })).rejects.toThrow(/payout/);
  });
});

const auth = vi.hoisted(() => ({ id: null as string | null }));
const service = vi.hoisted(() => ({ repo: null as unknown }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (auth.id ? { id: auth.id, email: "x@example.com" } : null) }));
vi.mock("@/server/serviceRepository", () => ({ serviceRepository: async () => service.repo }));

describe("the webhook route, and the demo checkout actions", async () => {
  const { POST } = await import("../src/app/api/stripe/webhook/route");
  const actions = await import("../src/server/actions/payments");
  beforeEach(() => {
    globalThis.__findmaxxingDemoStore = createIsolatedStore();
    service.repo = createDemoRepository(globalThis.__findmaxxingDemoStore);
  });

  it("verifies the signature over the raw body before doing anything", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "payments");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
    const repo = service.repo as DataRepository;
    const ev = await newEvent(repo, dev, null, globalThis.__findmaxxingDemoStore!.state.events[0].categorySlug);
    await repo.payments.setEventPrice(dev, ev.id, 1500);
    const hold = await repo.payments.reserveTicket(maya, ev.id);
    await repo.payments.attachCheckout(hold.ticketId, "cs_signed");
    const payload = JSON.stringify({ id: "evt_r1", object: "event", type: "checkout.session.completed", data: { object: { id: "cs_signed", mode: "payment", payment_status: "paid", currency: "usd", amount_total: 1500, payment_intent: "pi_signed", metadata: { ticket_id: hold.ticketId } } } });
    const post = (headers: Record<string, string>, body = payload) => POST(new Request("http://x/api/stripe/webhook", { method: "POST", body, headers }));
    expect((await post({})).status).toBe(400);
    expect((await post({ "stripe-signature": "t=1,v1=bad" })).status).toBe(400);
    const signature = new Stripe("sk_test_fake").webhooks.generateTestHeaderString({ payload, secret: "whsec_test" });
    expect((await post({ "stripe-signature": signature }, payload.replace('"paid"', '"unpaid"'))).status).toBe(400); // tampered
    const ok = await post({ "stripe-signature": signature });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ received: true, outcome: "confirmed" });
    expect((await repo.payments.myTickets(maya))[0].status).toBe("paid");
    vi.unstubAllEnvs();
    expect((await post({ "stripe-signature": signature })).status).toBe(404); // payments off
  });

  it("run the labeled demo checkout, and only in demo mode", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "payments");
    const repo = createDemoRepository(globalThis.__findmaxxingDemoStore!);
    const ev = await newEvent(repo, dev, null, globalThis.__findmaxxingDemoStore!.state.events[0].categorySlug);
    auth.id = dev;
    expect(await actions.setEventPriceAction(ev.id, 12.5)).toEqual({ ok: true, data: undefined });
    auth.id = maya;
    const bought = await actions.buyTicketAction(ev.id);
    expect(bought).toMatchObject({ ok: true, data: { url: expect.stringMatching(/^\/checkout\/demo\?ticket=/) } });
    const ticketId = bought.ok ? new URL(`http://x${bought.data.url}`).searchParams.get("ticket")! : "";
    auth.id = theo;
    expect(await actions.demoPayTicketAction(ticketId)).toMatchObject({ ok: false, code: "not_found" }); // not theirs
    auth.id = maya;
    expect(await actions.demoPayTicketAction(ticketId)).toMatchObject({ ok: true, data: { outcome: "confirmed" } });
    expect((await repo.events.get(ev.id, maya))!.viewerJoined).toBe(true);
    expect(await actions.demoSetPlusAction(true)).toEqual({ ok: true, data: undefined });
    expect(await repo.payments.isPlus(maya)).toBe(true);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.test");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon");
    vi.stubEnv("STRIPE_SECRET_KEY", "sk_test_fake");
    vi.stubEnv("STRIPE_WEBHOOK_SECRET", "whsec_test");
    expect(await actions.demoPayTicketAction(ticketId)).toMatchObject({ ok: false, code: "forbidden" });
    expect(await actions.demoSetPlusAction(true)).toMatchObject({ ok: false, code: "forbidden" });
    vi.unstubAllEnvs();
    expect(await actions.buyTicketAction(ev.id)).toMatchObject({ ok: false, code: "unavailable" }); // flag off
  });
});
