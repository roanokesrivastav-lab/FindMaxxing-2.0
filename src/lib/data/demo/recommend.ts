/**
 * Demo twin of recommend_places / recommend_events (0018_recommendations.sql,
 * as redefined in 0031_user_interactions.sql to leave out what the viewer
 * marked Not interested, in 0033_interaction_attribution.sql to leave out
 * anyone blocked either way and in 0034_cold_start_fallback.sql to fill in
 * with places popular in the viewer's home city), and of the taste term and
 * user_taste view (0035_user_taste.sql): the same candidates, signals,
 * weights, diversity terms, rounding and order.
 * Visibility comes from the repository's canViewPlace / canViewEvent, the
 * mirrors of the row policies the SQL runs under.
 */
import type { DemoState, EventRow, PlaceRow } from "./store";
import type { RecommendationReason } from "../types";
import { discoveryDistance } from "../discovery";
import { hiddenItems } from "./interactions";

type Signal = { w: number; kind: string; text: string; ref: string | null };
const C = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Mirrors is_blocked_between(viewer, other). */
function blockedWith(state: DemoState, viewerId: string): Set<string> {
  const out = new Set<string>();
  for (const b of state.blocks) {
    if (b.blockerId === viewerId) out.add(b.blockedId);
    if (b.blockedId === viewerId) out.add(b.blockerId);
  }
  return out;
}

/** The people the viewer follows and has no block with, by id, with their usernames. */
function followingOf(state: DemoState, viewerId: string, blocked: Set<string>): Map<string, string> {
  return new Map(
    state.follows
      .filter((f) => f.followerId === viewerId && !blocked.has(f.followingId))
      .map((f) => [f.followingId, state.profiles.find((p) => p.id === f.followingId)?.username ?? ""]),
  );
}

function best(signals: Signal[]): RecommendationReason {
  const top = [...signals].sort((a, b) => b.w - a.w || C(a.kind, b.kind))[0];
  return { kind: top.kind, text: top.text, ref: top.ref };
}

function interestSignal(state: DemoState, viewerId: string, tags: string[]): Signal | null {
  const mine = new Set(state.profileInterests.filter((i) => i.profileId === viewerId).map((i) => i.interestSlug));
  const matching = state.taxonomy
    .filter((t) => t.kind === "interest" && mine.has(t.slug) && tags.includes(t.slug))
    .sort((a, b) => a.sortOrder - b.sortOrder || C(a.slug, b.slug));
  if (!matching.length) return null;
  return { w: 2 * matching.length, kind: "interest", text: `Matches your interest in ${matching[0].label}`, ref: matching[0].slug };
}

/** Overall (key null) and per-category tag weights. */
export type Taste = Map<string | null, Map<string, number>>;

const RATING_WEIGHT: Record<number, number> = { 5: 2, 4: 1, 3: 0, 2: -1, 1: -2 };

/**
 * Mirrors the user_taste view: the viewer's actions on items they can see,
 * weighted, decayed by age in whole days and spread over the items' tags,
 * plus +1 per chosen interest. Categories with three nonzero actions get
 * their own vector.
 */
export function demoTaste(
  state: DemoState,
  viewerId: string,
  canViewPlace: (p: PlaceRow) => boolean,
  canViewEvent: (e: EventRow) => boolean,
  now = Date.now(),
): Taste {
  type Act = { itemType: "place" | "event"; itemId: string; category: string; weight: number; at: string };
  const place = (id: string) => { const p = state.places.find((x) => x.id === id); return p && canViewPlace(p) ? p : null; };
  const event = (id: string) => { const e = state.events.find((x) => x.id === id); return e && canViewEvent(e) ? e : null; };
  const acts: Act[] = [];
  for (const sv of state.savedPlaces) {
    const p = sv.userId === viewerId ? place(sv.placeId) : null;
    if (p) acts.push({ itemType: "place", itemId: p.id, category: p.categorySlug, weight: 1, at: sv.createdAt });
  }
  for (const r of state.placeRatings) {
    const p = r.userId === viewerId ? place(r.placeId) : null;
    if (p) acts.push({ itemType: "place", itemId: p.id, category: p.categorySlug, weight: RATING_WEIGHT[r.score] ?? -2, at: r.updatedAt });
  }
  for (const a of state.eventAttendees) {
    const e = a.userId === viewerId ? event(a.eventId) : null;
    if (e && e.creatorId !== viewerId) acts.push({ itemType: "event", itemId: e.id, category: e.categorySlug, weight: 1, at: a.createdAt });
  }
  const mine = state.userInteractions.filter((i) => i.userId === viewerId);
  const itemOf = (type: "place" | "event", id: string) => (type === "place" ? place(id) : event(id));
  for (const h of mine) {
    const item = h.action === "hide" ? itemOf(h.itemType, h.itemId) : null;
    if (item) acts.push({ itemType: h.itemType, itemId: h.itemId, category: item.categorySlug, weight: -2, at: h.createdAt });
  }
  // Seen three or more times, never opened, saved, rated, joined or hidden.
  const seen = new Map<string, typeof mine>();
  for (const i of mine) if (i.action === "impression") seen.set(`${i.itemType}:${i.itemId}`, [...(seen.get(`${i.itemType}:${i.itemId}`) ?? []), i]);
  for (const rows of seen.values()) {
    const { itemType, itemId } = rows[0];
    const item = itemOf(itemType, itemId);
    if (!item || rows.length < 3) continue;
    if (mine.some((o) => o.itemType === itemType && o.itemId === itemId && ["view", "save", "rate", "join", "hide"].includes(o.action))) continue;
    if (itemType === "place" && (state.savedPlaces.some((x) => x.userId === viewerId && x.placeId === itemId) || state.placeRatings.some((x) => x.userId === viewerId && x.placeId === itemId))) continue;
    if (itemType === "event" && state.eventAttendees.some((x) => x.userId === viewerId && x.eventId === itemId)) continue;
    acts.push({ itemType, itemId, category: item.categorySlug, weight: -0.1, at: rows.map((r) => r.createdAt).sort(C).at(-1)! });
  }
  const tagsOf = (a: Act) => (a.itemType === "place"
    ? state.placeTags.filter((t) => t.placeId === a.itemId)
    : state.eventTags.filter((t) => t.eventId === a.itemId)).map((t) => t.interestSlug);
  const counts = new Map<string, number>();
  for (const a of acts) if (a.weight !== 0) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  const own = new Set([...counts].filter(([, n]) => n >= 3).map(([c]) => c));
  const prior = state.profileInterests.filter((i) => i.profileId === viewerId).map((i) => i.interestSlug);
  const taste: Taste = new Map();
  const add = (scope: string | null, tag: string, w: number) => {
    const v = taste.get(scope) ?? new Map<string, number>();
    v.set(tag, (v.get(tag) ?? 0) + w);
    taste.set(scope, v);
  };
  for (const a of acts) {
    const w = a.weight * Math.exp(-Math.floor((now - Date.parse(a.at)) / 86_400_000) / 90);
    for (const tag of tagsOf(a)) {
      add(null, tag, w);
      if (own.has(a.category)) add(a.category, tag, w);
    }
  }
  for (const tag of prior) {
    add(null, tag, 1);
    for (const c of own) add(c, tag, 1);
  }
  return taste;
}

/** Mirrors the fit CTE: cosine between the taste vector for the category and the place's tags. */
export function tasteFit(taste: Taste, category: string, tags: string[]): number {
  if (!tags.length) return 0;
  const v = taste.get(taste.has(category) ? category : null);
  if (!v) return 0;
  let norm = 0;
  for (const w of v.values()) norm += w * w;
  if (!norm) return 0;
  const dot = tags.reduce((sum, t) => sum + (v.get(t) ?? 0), 0);
  return dot / (Math.sqrt(norm) * Math.sqrt(tags.length));
}

/**
 * rules-v2 (the SQL) passes the viewer's taste; rules-v1, kept for the
 * offline evaluation, passes null and has no taste term.
 */
export function recommendDemoPlaces(
  state: DemoState,
  viewerId: string,
  canView: (p: PlaceRow) => boolean,
  near: { lat: number; lng: number } | null,
  limit: number,
  now = Date.now(),
  taste: Taste | null = null,
): { place: PlaceRow; score: number; reason: RecommendationReason }[] {
  const saved = state.savedPlaces.filter((s) => s.userId === viewerId);
  const rated = state.placeRatings.filter((r) => r.userId === viewerId);
  const liked = [
    ...saved.map((s) => ({ placeId: s.placeId, at: s.createdAt, how: "saved" as const })),
    ...rated.filter((r) => r.score >= 4).map((r) => ({ placeId: r.placeId, at: r.updatedAt, how: "rated" as const })),
  ];
  const tagsOf = (placeId: string) => state.placeTags.filter((t) => t.placeId === placeId).map((t) => t.interestSlug);
  const blocked = blockedWith(state, viewerId);
  const following = followingOf(state, viewerId, blocked);
  const joinedCats = new Set(
    state.eventAttendees.filter((a) => a.userId === viewerId).map((a) => state.events.find((e) => e.id === a.eventId)?.categorySlug).filter(Boolean),
  );
  const hidden = hiddenItems(state, viewerId, "place");
  const homeCity = state.profiles.find((p) => p.id === viewerId)?.homeCity ?? null;
  const out: { place: PlaceRow; score: number; reason: RecommendationReason }[] = [];
  for (const p of state.places) {
    if (p.status !== "published" || p.creatorId === viewerId || !canView(p) || (p.creatorId && blocked.has(p.creatorId))) continue;
    if (saved.some((s) => s.placeId === p.id) || rated.some((r) => r.placeId === p.id) || hidden.has(p.id)) continue;
    const signals: Signal[] = [];
    if (p.creatorId && following.has(p.creatorId)) {
      const u = following.get(p.creatorId)!;
      signals.push({ w: 4, kind: "followed_added", text: `Added by @${u}, who you follow`, ref: u });
    }
    const raters = state.placeRatings.filter((r) => r.placeId === p.id && r.score >= 4 && following.has(r.userId)).map((r) => following.get(r.userId)!).sort(C);
    if (raters.length) signals.push({ w: 3, kind: "followed_rated", text: `Rated highly by @${raters[0]}`, ref: raters[0] });
    const tags = tagsOf(p.id);
    const similar = liked
      .filter((l) => tagsOf(l.placeId).some((t) => tags.includes(t)))
      .sort((a, b) => C(b.at, a.at) || C(a.placeId, b.placeId))[0];
    if (similar) {
      const name = state.places.find((x) => x.id === similar.placeId)?.name ?? "";
      signals.push({ w: 3, kind: "liked_similar", text: similar.how === "saved" ? `Because you saved ${name}` : `Because you rated ${name} highly`, ref: similar.placeId });
    }
    const interest = interestSignal(state, viewerId, tags);
    if (interest) signals.push(interest);
    if (joinedCats.has(p.categorySlug)) signals.push({ w: 1, kind: "event_category", text: "Like the events you join", ref: p.categorySlug });
    const saves = state.savedPlaces.filter((s) => s.placeId === p.id).length;
    if (!signals.length) {
      // The cold-start fallback: saved in the viewer's home city, decayed by the place's age in whole days.
      if (homeCity === null || p.city !== homeCity || saves === 0) continue;
      const ageDays = Math.floor((now - Date.parse(p.createdAt)) / 86_400_000);
      const popularity = saves * Math.exp(-ageDays / 180);
      out.push({ place: p, score: round3(0.9 * (1 - Math.exp(-popularity / 3))), reason: { kind: "popular_local", text: "Popular with locals", ref: p.city } });
      continue;
    }
    const nearby = near ? 2 * Math.exp(-discoveryDistance(p, near) / 3000) : 0;
    const fit = taste ? 3 * tasteFit(taste, p.categorySlug, tags) : 0;
    const score = round3(signals.reduce((sum, s) => sum + s.w, 0) + nearby + (p.source === "community" ? 1.5 : 0) + 1.5 / (1 + saves) + fit);
    out.push({ place: p, score, reason: best(signals) });
  }
  return out.sort((a, b) => b.score - a.score || C(a.place.id, b.place.id)).slice(0, limit);
}

const NY_WEEKDAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" });
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function recommendDemoEvents(
  state: DemoState,
  viewerId: string,
  canView: (e: EventRow) => boolean,
  near: { lat: number; lng: number } | null,
  limit: number,
  now: number,
): { event: EventRow; score: number; reason: RecommendationReason }[] {
  const saved = new Set(state.savedPlaces.filter((s) => s.userId === viewerId).map((s) => s.placeId));
  const blocked = blockedWith(state, viewerId);
  const following = followingOf(state, viewerId, blocked);
  const joined = new Set(state.eventAttendees.filter((a) => a.userId === viewerId).map((a) => a.eventId));
  const hidden = hiddenItems(state, viewerId, "event");
  // Most common weekday (Columbus time) of events joined but not hosted; ties go to the earliest weekday.
  const dayCounts = new Map<number, number>();
  for (const e of state.events) {
    if (!joined.has(e.id) || e.creatorId === viewerId) continue;
    const d = DOW.indexOf(NY_WEEKDAY.format(new Date(e.startsAt)));
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
  }
  const usual = [...dayCounts.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? null;
  const out: { event: EventRow; score: number; reason: RecommendationReason }[] = [];
  for (const e of state.events) {
    if (e.status !== "published" || e.creatorId === viewerId || joined.has(e.id) || hidden.has(e.id) || !canView(e)) continue;
    if (e.creatorId && blocked.has(e.creatorId)) continue;
    if (new Date(e.endsAt ?? e.startsAt).getTime() < now - 3600_000) continue;
    const signals: Signal[] = [];
    if (e.placeId && saved.has(e.placeId)) {
      const name = state.places.find((p) => p.id === e.placeId)?.name ?? "";
      signals.push({ w: 4, kind: "saved_place", text: `At ${name}, which you saved`, ref: e.placeId });
    }
    if (e.creatorId && following.has(e.creatorId)) {
      const u = following.get(e.creatorId)!;
      signals.push({ w: 4, kind: "followed_host", text: `Hosted by @${u}, who you follow`, ref: u });
    }
    const going = state.eventAttendees.filter((a) => a.eventId === e.id && a.userId !== e.creatorId && following.has(a.userId)).map((a) => following.get(a.userId)!).sort(C);
    if (going.length) signals.push({ w: 2, kind: "followed_going", text: `@${going[0]} is going`, ref: going[0] });
    const interest = interestSignal(state, viewerId, state.eventTags.filter((t) => t.eventId === e.id).map((t) => t.interestSlug));
    if (interest) signals.push(interest);
    const day = NY_WEEKDAY.format(new Date(e.startsAt));
    if (usual !== null && DOW.indexOf(day) === usual) signals.push({ w: 1, kind: "usual_day", text: `On ${day}, when you usually go`, ref: null });
    if (!signals.length) continue;
    const soon = 1.5 * Math.exp(-Math.max((new Date(e.startsAt).getTime() - now) / 1000, 0) / 259200);
    const nearby = near ? 2 * Math.exp(-discoveryDistance(e, near) / 3000) : 0;
    const small = state.eventAttendees.filter((a) => a.eventId === e.id).length < 5 ? 0.5 : 0;
    out.push({ event: e, score: round3(signals.reduce((s, x) => s + x.w, 0) + soon + nearby + small), reason: best(signals) });
  }
  return out.sort((a, b) => b.score - a.score || C(a.event.id, b.event.id)).slice(0, limit);
}
