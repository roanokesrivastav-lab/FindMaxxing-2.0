/**
 * Demo twin of 0031_user_interactions.sql: the private per-user interaction
 * log. The checks mirror the table's: constraints, the insert policy (own
 * rows, visible items, the analytics opt-out except for "hide"), the
 * suspended-account trigger and one rate-limit tick per batch.
 */
import type { DataRepository } from "../repository";
import { DataError, INTERACTION_ACTIONS, INTERACTION_SURFACES, MAX_INTERACTION_BATCH, type InteractionInput, type UserInteraction } from "../types";
import type { RateLimitAction } from "@/lib/rateLimits";
import type { DemoState, EventRow, PlaceRow } from "./store";

const PLACE_ONLY = new Set(["save", "unsave", "rate"]);
const EVENT_ONLY = new Set(["join", "leave"]);

/** Mirrors forget_item_interactions(): a deleted item takes everyone's history of it. */
export function forgetItemInteractions(state: DemoState, itemType: "place" | "event", ids: Set<string>): void {
  if (!ids.size) return;
  state.userInteractions = state.userInteractions.filter((i) => !(i.itemType === itemType && ids.has(i.itemId)));
}

/** Mirrors purge_user_interactions(): impressions and views older than keepDays go. */
export function purgeDemoInteractions(state: DemoState, keepDays: number, now = Date.now()): number {
  const cutoff = now - keepDays * 86_400_000;
  const before = state.userInteractions.length;
  state.userInteractions = state.userInteractions.filter((i) => !(i.action === "impression" || i.action === "view") || Date.parse(i.createdAt) >= cutoff);
  return before - state.userInteractions.length;
}

/** The ids the viewer marked Not interested, for the recommenders. */
export function hiddenItems(state: DemoState, userId: string, itemType: "place" | "event"): Set<string> {
  return new Set(state.userInteractions.filter((i) => i.userId === userId && i.action === "hide" && i.itemType === itemType).map((i) => i.itemId));
}

function validRow(row: InteractionInput): boolean {
  const { itemType, action, surface = null, position = null, value = null } = row;
  if (itemType !== "place" && itemType !== "event") return false;
  if (!(INTERACTION_ACTIONS as readonly string[]).includes(action)) return false;
  if (surface !== null && !(INTERACTION_SURFACES as readonly string[]).includes(surface)) return false;
  if (position !== null && !(Number.isInteger(position) && position >= 0 && position <= 999)) return false;
  if ((action === "rate") !== (value !== null)) return false;
  if (value !== null && !(Number.isInteger(value) && value >= 1 && value <= 5)) return false;
  if (PLACE_ONLY.has(action) && itemType !== "place") return false;
  if (EVENT_ONLY.has(action) && itemType !== "event") return false;
  return true;
}

export function createDemoInteractions(state: DemoState, h: {
  persist(): void;
  assertActive(userId: string): void;
  rateLimit(userId: string, action: RateLimitAction): () => void;
  canViewPlace(p: PlaceRow, viewerId: string): boolean;
  canViewEvent(e: EventRow, viewerId: string): boolean;
}): DataRepository["interactions"] {
  const own = (userId: string) => state.userInteractions.filter((i) => i.userId === userId);
  const visible = (userId: string, row: InteractionInput) => {
    if (row.itemType === "place") {
      const p = state.places.find((x) => x.id === row.itemId);
      return !!p && h.canViewPlace(p, userId);
    }
    const e = state.events.find((x) => x.id === row.itemId);
    return !!e && h.canViewEvent(e, userId);
  };
  return {
    async log(userId, rows) {
      if (!rows.length) return;
      const profile = state.profiles.find((p) => p.id === userId);
      if (!profile) throw new DataError("Profile not found", "not_found");
      h.assertActive(userId);
      if (rows.length > MAX_INTERACTION_BATCH) throw new DataError("Too many interactions in one batch", "invalid");
      if (!rows.every(validRow)) throw new DataError("Invalid interaction", "invalid");
      // The insert policy: one refused row refuses the whole statement.
      if (rows.some((r) => (r.action !== "hide" && profile.analyticsOptOut) || !visible(userId, r))) {
        throw new DataError("Interaction not allowed", "forbidden");
      }
      const counted = h.rateLimit(userId, "interactions");
      const now = new Date().toISOString();
      let id = state.userInteractions.reduce((max, i) => Math.max(max, i.id), 0);
      for (const r of rows) {
        state.userInteractions.push({
          id: ++id, userId, itemType: r.itemType, itemId: r.itemId, action: r.action,
          surface: r.surface ?? null, position: r.position ?? null, value: r.value ?? null, createdAt: now,
        });
      }
      counted();
      h.persist();
    },
    async list(userId, opts = {}) {
      const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 100), 1), 1000);
      return own(userId).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id).slice(0, limit).map(toPublic);
    },
    async unhide(userId, item) {
      const before = state.userInteractions.length;
      state.userInteractions = state.userInteractions.filter(
        (i) => !(i.userId === userId && i.action === "hide" && i.itemType === item.itemType && i.itemId === item.itemId),
      );
      if (state.userInteractions.length !== before) h.persist();
    },
    async clear(userId) {
      const before = state.userInteractions.length;
      state.userInteractions = state.userInteractions.filter((i) => i.userId !== userId);
      const n = before - state.userInteractions.length;
      if (n) h.persist();
      return n;
    },
  };
}

function toPublic(i: DemoState["userInteractions"][number]): UserInteraction {
  return { id: i.id, itemType: i.itemType, itemId: i.itemId, action: i.action, surface: i.surface, position: i.position, value: i.value, createdAt: i.createdAt };
}
