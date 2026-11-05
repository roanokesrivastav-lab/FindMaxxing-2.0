/**
 * Demo-mode sponsored cards. Mirrors 0023_ads.sql: who may advertise what,
 * review, activation, and serve_ad()'s eligibility, pacing and ordering.
 */
import type { DataRepository } from "../repository";
import { DataError, type AdCampaign } from "../types";
import { adsError, dailyCap, impressionBudget, validateCampaign } from "../ads";
import { moderationError, normalizeReason } from "../moderation";
import type { RateLimitAction } from "@/lib/rateLimits";
import { newId } from "@/lib/utils/ids";
import type { AdCampaignRow, DemoState } from "./store";

/** Mirrors ad_target_ok(). */
export function adTargetOk(state: DemoState, kind: "place" | "event", targetId: string | null, ownerId: string, now = Date.now()): boolean {
  if (kind === "place") return state.places.some((p) => p.id === targetId && p.creatorId === ownerId && p.status === "published" && p.visibility === "public");
  const e = state.events.find((x) => x.id === targetId);
  if (!e || e.creatorId !== ownerId || e.status !== "published" || Date.parse(e.endsAt ?? e.startsAt) <= now) return false;
  if (!e.placeId) return true;
  const p = state.places.find((x) => x.id === e.placeId);
  return !!p && p.status === "published" && p.visibility === "public";
}

const utcDay = (iso: string) => iso.slice(0, 10);

export function createDemoAds(state: DemoState, h: {
  persist(): void;
  assertActive(userId: string): void;
  rateLimit(userId: string, action: RateLimitAction): () => void;
  isAdmin(userId: string | null): boolean;
}): DataRepository["ads"] {
  const delivered = (id: string, day?: string) => state.adImpressions.filter((i) => i.campaignId === id && (!day || i.day === day)).reduce((n, i) => n + i.count, 0);
  const toCampaign = (c: AdCampaignRow): AdCampaign => ({
    id: c.id, advertiserId: c.advertiserId, kind: c.kind, targetId: (c.placeId ?? c.eventId)!,
    targetLabel: c.kind === "place" ? (state.places.find((p) => p.id === c.placeId)?.name ?? null) : (state.events.find((e) => e.id === c.eventId)?.title ?? null),
    headline: c.headline, body: c.body, bounds: c.bounds, categorySlug: c.categorySlug, startsAt: c.startsAt, endsAt: c.endsAt,
    budgetCents: c.budgetCents, status: c.status, reviewNote: c.reviewNote, createdAt: c.createdAt,
    delivered: delivered(c.id), impressionBudget: impressionBudget(c.budgetCents),
  });
  return {
    async create(advertiserId, input) {
      h.assertActive(advertiserId);
      if (!adTargetOk(state, input.kind, input.targetId, advertiserId)) throw adsError("bad_target");
      validateCampaign(input);
      if (input.categorySlug && !state.taxonomy.some((t) => t.kind === "category" && t.slug === input.categorySlug)) throw new DataError("Unknown category", "invalid");
      const counted = h.rateLimit(advertiserId, "ad_campaigns");
      const row: AdCampaignRow = {
        id: newId(), advertiserId, kind: input.kind, placeId: input.kind === "place" ? input.targetId : null, eventId: input.kind === "event" ? input.targetId : null,
        headline: input.headline.trim(), body: input.body?.trim() || null, bounds: input.bounds, categorySlug: input.categorySlug,
        startsAt: input.startsAt, endsAt: input.endsAt, budgetCents: input.budgetCents, status: "pending_review",
        reviewNote: null, reviewedBy: null, reviewedAt: null, checkoutSessionId: null, paidCents: null, createdAt: new Date().toISOString(),
      };
      state.adCampaigns.push(row);
      counted();
      h.persist();
      return row.id;
    },
    async mine(advertiserId) {
      return state.adCampaigns.filter((c) => c.advertiserId === advertiserId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? 1 : -1)).map(toCampaign);
    },
    async setPaused(advertiserId, campaignId, paused) {
      const c = state.adCampaigns.find((x) => x.id === campaignId && x.advertiserId === advertiserId && x.status === (paused ? "active" : "paused"));
      if (!c) throw adsError("not_found");
      c.status = paused ? "paused" : "active";
      h.persist();
    },
    async reviewQueue(viewerId) {
      if (!h.isAdmin(viewerId)) return [];
      return state.adCampaigns.filter((c) => c.status === "pending_review").sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.id < b.id ? -1 : 1)).map(toCampaign);
    },
    async review(adminId, campaignId, approve, note) {
      if (!h.isAdmin(adminId)) throw new DataError("Admins only", "forbidden");
      const c = state.adCampaigns.find((x) => x.id === campaignId);
      if (!c) throw adsError("not_found");
      if (c.status !== "pending_review") throw adsError("not_pending");
      const why = normalizeReason(note);
      if (!approve && !why) throw moderationError("reason_required");
      const now = new Date().toISOString();
      Object.assign(c, { status: approve ? "awaiting_payment" : "rejected", reviewNote: why, reviewedBy: adminId, reviewedAt: now });
      state.moderationActions.push({
        id: newId(), moderatorId: adminId, action: approve ? "approve_ad" : "reject_ad", targetType: "campaign", targetId: campaignId,
        reason: why, statusBefore: "pending_review", statusAfter: c.status, resolvedReports: 0, createdAt: now,
      });
      h.persist();
    },
    async attachCheckout(campaignId, sessionId) {
      const c = state.adCampaigns.find((x) => x.id === campaignId && x.status === "awaiting_payment");
      if (c) {
        c.checkoutSessionId = sessionId;
        h.persist();
      }
    },
    async activate(sessionId, amountCents) {
      const c = state.adCampaigns.find((x) => x.checkoutSessionId === sessionId);
      if (!c) return "unknown";
      if (c.status !== "awaiting_payment") return "duplicate";
      if (amountCents !== c.budgetCents) return "mismatch";
      c.status = "active";
      c.paidCents = amountCents;
      h.persist();
      return "active";
    },
    async serve(slot, context, now = new Date().toISOString()) {
      const kind = slot === "places" ? "place" : "event";
      const at = Date.parse(now);
      const day = utcDay(now);
      const b = context.bounds;
      const eligible = state.adCampaigns
        .filter((c) => c.kind === kind && c.status === "active" && Date.parse(c.startsAt) <= at && Date.parse(c.endsAt) > at
          && adTargetOk(state, c.kind, c.placeId ?? c.eventId, c.advertiserId, at)
          && (!c.categorySlug || !context.categorySlug || c.categorySlug === context.categorySlug)
          && (!c.bounds || !b || (c.bounds.south < b.north && c.bounds.north > b.south && c.bounds.west < b.east && c.bounds.east > b.west)))
        .map((c) => ({ c, today: delivered(c.id, day), total: delivered(c.id) }))
        .sort((x, y) => x.today - y.today || (x.c.id < y.c.id ? -1 : 1));
      for (const { c, today, total } of eligible) {
        if (total >= impressionBudget(c.budgetCents) || today >= dailyCap(c.budgetCents, c.startsAt, c.endsAt)) continue;
        const row = state.adImpressions.find((i) => i.campaignId === c.id && i.day === day && i.slot === slot);
        if (row) row.count += 1;
        else state.adImpressions.push({ campaignId: c.id, day, slot, count: 1 });
        if (total + 1 >= impressionBudget(c.budgetCents)) c.status = "ended";
        h.persist();
        return { campaignId: c.id, kind: c.kind, targetId: (c.placeId ?? c.eventId)!, headline: c.headline, body: c.body };
      }
      return null;
    },
    async endFinished(now = new Date().toISOString()) {
      let n = 0;
      for (const c of state.adCampaigns) {
        if ((c.status === "active" || c.status === "paused") && Date.parse(c.endsAt) <= Date.parse(now)) {
          c.status = "ended";
          n += 1;
        }
      }
      if (n) h.persist();
      return n;
    },
  };
}
