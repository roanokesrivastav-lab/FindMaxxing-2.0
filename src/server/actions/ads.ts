"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled, getSiteUrl, paymentsMode } from "@/lib/config";
import { getRepository } from "@/lib/data";
import { paymentsError } from "@/lib/data/payments";
import { createCampaignCheckout, getStripe } from "@/server/payments/stripe";
import { serviceRepository } from "@/server/serviceRepository";
import { fail, succeed, toFailure, type ActionResult } from "./result";

const id = z.string().uuid();
const DAY = 86_400_000;
/** "Near the listing": about 5 km around it. */
const NEAR = { lat: 0.045, lng: 0.06 };

const campaignSchema = z.object({
  kind: z.enum(["place", "event"]),
  targetId: id,
  headline: z.string().trim().min(3, "Headlines are 3 to 60 characters").max(60, "Headlines are 3 to 60 characters"),
  body: z.string().trim().max(140, "Keep the text under 140 characters").optional().transform((v) => v || null),
  area: z.enum(["near", "anywhere"]),
  matchCategory: z.boolean(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Choose a start date"),
  days: z.number().int().min(1).max(60),
  budgetDollars: z.number().min(20, "Budgets go from $20 to $1,000").max(1000, "Budgets go from $20 to $1,000"),
});

/** Ads need their flag, and payments to be paid for. */
async function advertising() {
  if (!featureEnabled("ads") || !paymentsMode()) return { error: fail("Sponsored cards are not available", undefined, "unavailable") };
  const viewer = await getViewer();
  if (!viewer) return { error: fail("Sign in first", undefined, "unauthenticated") };
  return { viewer, mode: paymentsMode()! };
}

/** Submits a campaign for review. Targeting comes from the listing: its area and its category. */
export async function createCampaignAction(input: unknown): Promise<ActionResult<{ id: string }>> {
  const { viewer, error } = await advertising();
  if (error) return error;
  const parsed = campaignSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check the form");
  const f = parsed.data;
  try {
    const repo = await getRepository();
    const target = f.kind === "place" ? await repo.places.get(f.targetId, viewer.id) : await repo.events.get(f.targetId, viewer.id);
    if (!target) return fail("You can promote your own public place or upcoming event", undefined, "invalid");
    const startsAt = new Date(`${f.startsOn}T00:00:00Z`).getTime() < Date.now() ? new Date().toISOString() : new Date(`${f.startsOn}T00:00:00Z`).toISOString();
    const campaign = await repo.ads.create(viewer.id, {
      kind: f.kind, targetId: f.targetId, headline: f.headline, body: f.body,
      bounds: f.area === "near" ? { north: target.lat + NEAR.lat, south: target.lat - NEAR.lat, east: target.lng + NEAR.lng, west: target.lng - NEAR.lng } : null,
      categorySlug: f.matchCategory ? target.categorySlug : null,
      startsAt, endsAt: new Date(Date.parse(startsAt) + f.days * DAY).toISOString(), budgetCents: Math.round(f.budgetDollars * 100),
    });
    revalidatePath("/ads");
    return succeed({ id: campaign });
  } catch (err) {
    return toFailure(err);
  }
}

/** Pays an approved campaign: Stripe Checkout, or the demo checkout. */
export async function payCampaignAction(campaignId: string): Promise<ActionResult<{ url: string }>> {
  const { viewer, mode, error } = await advertising();
  if (error) return error;
  const c = (await (await getRepository()).ads.mine(viewer.id)).find((x) => x.id === campaignId && x.status === "awaiting_payment");
  if (!c) return fail("That campaign isn't waiting for payment", undefined, "not_found");
  if (mode === "demo") return succeed({ url: `/checkout/demo?campaign=${c.id}` });
  const stripe = await getStripe();
  if (!stripe) return fail("Payments are not available", undefined, "unavailable");
  try {
    const session = await createCampaignCheckout(stripe, c, { userId: viewer.id, origin: getSiteUrl(), email: viewer.email });
    await (await serviceRepository()).ads.attachCheckout(c.id, session.id);
    return succeed({ url: session.url });
  } catch (err) {
    return toFailure(err);
  }
}

/** Demo checkout for a campaign. Refused outside demo mode; no money moves. */
export async function demoPayCampaignAction(campaignId: string): Promise<ActionResult> {
  const { viewer, mode, error } = await advertising();
  if (error) return error;
  if (mode !== "demo") return fail(paymentsError("demo_only").message, undefined, "forbidden");
  const repo = await getRepository();
  const c = (await repo.ads.mine(viewer.id)).find((x) => x.id === campaignId && x.status === "awaiting_payment");
  if (!c) return fail("That campaign isn't waiting for payment", undefined, "not_found");
  await repo.ads.attachCheckout(c.id, `demo_cs_${c.id}`);
  await repo.ads.activate(`demo_cs_${c.id}`, c.budgetCents);
  revalidatePath("/ads");
  return succeed(undefined);
}

export async function setCampaignPausedAction(campaignId: string, paused: boolean): Promise<ActionResult> {
  const { viewer, error } = await advertising();
  if (error) return error;
  if (!id.safeParse(campaignId).success) return fail("Unknown campaign");
  try {
    await (await getRepository()).ads.setPaused(viewer.id, campaignId, paused);
    revalidatePath("/ads");
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}

/** Admins: approve (it then waits for payment) or reject with a reason. */
export async function reviewCampaignAction(input: { campaignId: string; approve: boolean; note?: string | null }): Promise<ActionResult> {
  if (!featureEnabled("ads") || !featureEnabled("admin")) return fail("Not available", undefined, "unavailable");
  const viewer = await getViewer();
  if (!viewer) return fail("Sign in first", undefined, "unauthenticated");
  if (!id.safeParse(input.campaignId).success) return fail("Unknown campaign");
  try {
    await (await getRepository()).ads.review(viewer.id, input.campaignId, input.approve, input.note ?? null);
    revalidatePath("/admin/ads");
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}
