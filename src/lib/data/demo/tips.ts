/**
 * Demo twin of 0060_place_tips.sql (roadmap 2.6). The collections are optional on
 * DemoState and created here on first use, copying each place's legacy local tip
 * as a practical tip by its creator and applying the seeded confirmations, the
 * same as the migration and the SQL seed. (Lazy, so no store-version bump that
 * would collide with other lanes; a store from before 2.6 gains them in place.)
 */
import type { DataRepository } from "../repository";
import { DataError, type ProfileSummary } from "../types";
import type { RateLimitAction } from "@/lib/rateLimits";
import { newId } from "@/lib/utils/ids";
import { SEED_TIP_CONFIRMATIONS } from "@/lib/places/tipSeed";
import { seedPlaceByName, seedUserByName } from "@/lib/seed/seed-data";
import { isCurrentTip, normalizeCorrection, normalizeTipInput, orderTips, type PlaceTip, type TipKind, type TipStatus } from "@/lib/places/tips";
import { isModeratorIn, type DemoState, type PlaceRow } from "./store";

export interface PlaceTipRow {
  id: string;
  placeId: string;
  authorId: string | null;
  body: string;
  kind: TipKind;
  expiresAt: string | null;
  status: TipStatus;
  lastConfirmedAt: string | null;
  lastConfirmedBy: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface TipCollections {
  placeTips: PlaceTipRow[];
  placeTipConfirmations: { tipId: string; userId: string; createdAt: string }[];
  placeTipCorrections: { id: string; tipId: string; authorId: string | null; body: string; createdAt: string }[];
}

/** Creates the tip collections on first use (the migration's backfill plus the seed's confirmations). */
export function ensureTips(state: DemoState): TipCollections {
  const s = state as DemoState & Partial<TipCollections>;
  if (s.placeTips && s.placeTipConfirmations && s.placeTipCorrections) return s as TipCollections;
  s.placeTips = [];
  s.placeTipConfirmations = [];
  s.placeTipCorrections = [];
  for (const p of state.places) {
    const body = p.localTip?.trim();
    if (!body) continue;
    s.placeTips.push({
      id: newId(), placeId: p.id, authorId: p.creatorId, body: body.slice(0, 280), kind: "practical", expiresAt: null,
      status: "published", lastConfirmedAt: null, lastConfirmedBy: null, createdAt: p.updatedAt, updatedAt: p.updatedAt,
    });
  }
  const now = new Date().toISOString();
  for (const c of SEED_TIP_CONFIRMATIONS) {
    const placeId = seedPlaceByName(c.place)?.id;
    const userId = seedUserByName(c.user)?.id;
    const tip = s.placeTips.find((t) => t.placeId === placeId && t.authorId !== userId);
    if (!tip || !userId || !state.profiles.some((p) => p.id === userId)) continue;
    s.placeTipConfirmations.push({ tipId: tip.id, userId, createdAt: now });
    tip.lastConfirmedAt = now;
    tip.lastConfirmedBy = userId;
  }
  return s as TipCollections;
}

export function createDemoTips(
  state: DemoState,
  h: {
    persist(): void;
    assertActive(userId: string): void;
    rateLimit(userId: string, action: RateLimitAction): () => void;
    canViewPlace(p: PlaceRow, viewerId: string | null): boolean;
    summary(id: string | null): ProfileSummary | null;
  },
): DataRepository["tips"] {
  const t = () => ensureTips(state);
  const placeOf = (id: string) => state.places.find((p) => p.id === id);
  /** Mirrors can_view_place_tip(). */
  const canViewTip = (tip: PlaceTipRow, viewerId: string | null) => {
    if (isModeratorIn(state, viewerId)) return true;
    const place = placeOf(tip.placeId);
    if (!place || !h.canViewPlace(place, viewerId)) return false;
    return tip.status === "published" || (!!viewerId && tip.authorId === viewerId);
  };
  const toTip = (r: PlaceTipRow): PlaceTip => ({
    id: r.id, placeId: r.placeId, body: r.body, kind: r.kind, expiresAt: r.expiresAt, status: r.status,
    author: h.summary(r.authorId), createdAt: r.createdAt, updatedAt: r.updatedAt,
    lastConfirmedAt: r.lastConfirmedAt, lastConfirmedBy: h.summary(r.lastConfirmedBy),
  });
  const visibleTip = (tipId: string, viewerId: string | null) => {
    const tip = t().placeTips.find((x) => x.id === tipId);
    if (!tip || !canViewTip(tip, viewerId)) throw new DataError("Tip not found", "not_found");
    return tip;
  };

  return {
    async list(placeId, viewerId = null, now = Date.now()) {
      const place = placeOf(placeId);
      if (!place || !h.canViewPlace(place, viewerId)) return [];
      return orderTips(t().placeTips.filter((x) => x.placeId === placeId && isCurrentTip(x, now)).map(toTip));
    },
    async evidence(tipId, viewerId = null) {
      const tip = t().placeTips.find((x) => x.id === tipId);
      if (!tip || !canViewTip(tip, viewerId)) return null;
      return {
        tip: toTip(tip),
        confirmations: t().placeTipConfirmations
          .filter((c) => c.tipId === tipId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((c) => ({ user: h.summary(c.userId), createdAt: c.createdAt })),
        corrections: t().placeTipCorrections
          .filter((c) => c.tipId === tipId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .map((c) => ({ id: c.id, body: c.body, author: h.summary(c.authorId), createdAt: c.createdAt })),
      };
    },
    async add(userId, placeId, input) {
      h.assertActive(userId);
      const place = placeOf(placeId);
      if (!place || !h.canViewPlace(place, userId)) throw new DataError("Place not found", "not_found");
      const clean = normalizeTipInput(input);
      const counted = h.rateLimit(userId, "tips");
      const now = new Date().toISOString();
      const row: PlaceTipRow = { id: newId(), placeId, authorId: userId, ...clean, status: "published", lastConfirmedAt: null, lastConfirmedBy: null, createdAt: now, updatedAt: now };
      t().placeTips.push(row);
      counted();
      h.persist();
      return toTip(row);
    },
    async edit(userId, tipId, input) {
      h.assertActive(userId);
      const tip = visibleTip(tipId, userId);
      if (tip.authorId !== userId) throw new DataError("Only the author can edit this tip", "forbidden");
      const clean = normalizeTipInput(input);
      // An edit is not a confirmation: lastConfirmed stays exactly as it was.
      Object.assign(tip, clean, { updatedAt: new Date().toISOString() });
      h.persist();
      return toTip(tip);
    },
    async confirm(userId, tipId) {
      h.assertActive(userId);
      const tip = visibleTip(tipId, userId);
      if (tip.authorId === userId) throw new DataError("You can't confirm your own tip", "forbidden");
      const counted = h.rateLimit(userId, "tip_confirmations");
      const now = new Date().toISOString();
      t().placeTipConfirmations.push({ tipId, userId, createdAt: now });
      tip.lastConfirmedAt = now;
      tip.lastConfirmedBy = userId;
      counted();
      h.persist();
    },
    async suggestCorrection(userId, tipId, body) {
      h.assertActive(userId);
      visibleTip(tipId, userId);
      const text = normalizeCorrection(body);
      const counted = h.rateLimit(userId, "tips");
      t().placeTipCorrections.push({ id: newId(), tipId, authorId: userId, body: text, createdAt: new Date().toISOString() });
      counted();
      h.persist();
    },
    async setStatus(moderatorId, tipId, status) {
      h.assertActive(moderatorId);
      if (!isModeratorIn(state, moderatorId)) throw new DataError("Moderators only", "forbidden");
      const tip = t().placeTips.find((x) => x.id === tipId);
      if (!tip) throw new DataError("Tip not found", "not_found");
      tip.status = status;
      h.persist();
    },
  };
}
