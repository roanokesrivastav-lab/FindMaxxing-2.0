/**
 * Demo twin of recommend_places / recommend_events (0018_recommendations.sql):
 * the same candidates, signals, weights, diversity terms, rounding and order.
 * Visibility comes from the repository's canViewPlace / canViewEvent, the
 * mirrors of the row policies the SQL runs under.
 */
import type { DemoState, EventRow, PlaceRow } from "./store";
import type { RecommendationReason } from "../types";
import { discoveryDistance } from "../discovery";

type Signal = { w: number; kind: string; text: string; ref: string | null };
const C = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const round3 = (n: number) => Math.round(n * 1000) / 1000;

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

export function recommendDemoPlaces(
  state: DemoState,
  viewerId: string,
  canView: (p: PlaceRow) => boolean,
  near: { lat: number; lng: number } | null,
  limit: number,
): { place: PlaceRow; score: number; reason: RecommendationReason }[] {
  const saved = state.savedPlaces.filter((s) => s.userId === viewerId);
  const rated = state.placeRatings.filter((r) => r.userId === viewerId);
  const liked = [
    ...saved.map((s) => ({ placeId: s.placeId, at: s.createdAt, how: "saved" as const })),
    ...rated.filter((r) => r.score >= 4).map((r) => ({ placeId: r.placeId, at: r.updatedAt, how: "rated" as const })),
  ];
  const tagsOf = (placeId: string) => state.placeTags.filter((t) => t.placeId === placeId).map((t) => t.interestSlug);
  const following = new Map(
    state.follows.filter((f) => f.followerId === viewerId).map((f) => [f.followingId, state.profiles.find((p) => p.id === f.followingId)?.username ?? ""]),
  );
  const joinedCats = new Set(
    state.eventAttendees.filter((a) => a.userId === viewerId).map((a) => state.events.find((e) => e.id === a.eventId)?.categorySlug).filter(Boolean),
  );
  const out: { place: PlaceRow; score: number; reason: RecommendationReason }[] = [];
  for (const p of state.places) {
    if (p.status !== "published" || p.creatorId === viewerId || !canView(p)) continue;
    if (saved.some((s) => s.placeId === p.id) || rated.some((r) => r.placeId === p.id)) continue;
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
    if (!signals.length) continue;
    const nearby = near ? 2 * Math.exp(-discoveryDistance(p, near) / 3000) : 0;
    const saves = state.savedPlaces.filter((s) => s.placeId === p.id).length;
    const score = round3(signals.reduce((sum, s) => sum + s.w, 0) + nearby + (p.source === "community" ? 1.5 : 0) + 1.5 / (1 + saves));
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
  const following = new Map(
    state.follows.filter((f) => f.followerId === viewerId).map((f) => [f.followingId, state.profiles.find((p) => p.id === f.followingId)?.username ?? ""]),
  );
  const joined = new Set(state.eventAttendees.filter((a) => a.userId === viewerId).map((a) => a.eventId));
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
    if (e.status !== "published" || e.creatorId === viewerId || joined.has(e.id) || !canView(e)) continue;
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
