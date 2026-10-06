/**
 * Demo-mode account deletion. Mirrors what deleting the auth user does in
 * Postgres (0012_account_deletion.sql): the profile goes, and with it their
 * places, events, photos, ratings, saves, lists, follows and attendance;
 * reports they filed stay with the reporter cleared; moderation history they
 * wrote stays with the moderator cleared.
 */
import { recomputeRating, type StoreHandle } from "./store";

export interface DeletedObjects {
  /** Place photo storage paths (each with its stored sizes) to remove. */
  placePhotos: string[];
  /** Avatar storage paths to remove. */
  avatars: string[];
}

export function deleteDemoAccount(handle: StoreHandle, userId: string): DeletedObjects {
  const { state, persist } = handle;
  const profile = state.profiles.find((p) => p.id === userId);
  if (!profile) return { placePhotos: [], avatars: [] };

  const ownPlaces = new Set(state.places.filter((p) => p.creatorId === userId).map((p) => p.id));
  const ownEvents = new Set(state.events.filter((e) => e.creatorId === userId).map((e) => e.id));
  const photoGone = (ph: (typeof state.placePhotos)[number]) => ph.uploaderId === userId || ownPlaces.has(ph.placeId);

  const placePhotos = [...new Set(state.placePhotos.filter((ph) => photoGone(ph) && ph.storagePath).map((ph) => ph.storagePath!))];
  const avatarName = profile.avatarUrl?.match(/^\/api\/uploads\/(avatars-[^/]+)$/)?.[1];
  const avatars = avatarName ? [avatarName] : [];

  // Places they created, and everything hanging off them.
  const ratedPlaces = new Set(state.placeRatings.filter((r) => r.userId === userId).map((r) => r.placeId));
  state.places = state.places.filter((p) => !ownPlaces.has(p.id));
  state.placeTags = state.placeTags.filter((t) => !ownPlaces.has(t.placeId));
  state.placePhotos = state.placePhotos.filter((ph) => !photoGone(ph));
  state.placeRatings = state.placeRatings.filter((r) => r.userId !== userId && !ownPlaces.has(r.placeId));
  for (const placeId of ratedPlaces) recomputeRating(state, placeId);

  // Bookmarks: theirs, and everyone's bookmarks of their places (with list items).
  const listsTouched = new Set(
    state.savedListItems.filter((i) => i.ownerId !== userId && ownPlaces.has(i.placeId)).map((i) => i.listId),
  );
  state.savedPlaces = state.savedPlaces.filter((s) => s.userId !== userId && !ownPlaces.has(s.placeId));
  state.savedListItems = state.savedListItems.filter((i) => i.ownerId !== userId && !ownPlaces.has(i.placeId));
  state.savedLists = state.savedLists.filter((l) => l.ownerId !== userId);
  const now = new Date().toISOString();
  for (const list of state.savedLists) if (listsTouched.has(list.id)) list.updatedAt = now;

  // Events they created; other people's events at their places keep the location.
  state.events = state.events.filter((e) => !ownEvents.has(e.id));
  state.eventTags = state.eventTags.filter((t) => !ownEvents.has(t.eventId));
  state.eventAttendees = state.eventAttendees.filter((a) => a.userId !== userId && !ownEvents.has(a.eventId));
  for (const event of state.events) if (event.placeId && ownPlaces.has(event.placeId)) event.placeId = null;

  state.follows = state.follows.filter((f) => f.followerId !== userId && f.followingId !== userId);
  for (const report of state.reports) if (report.reporterId === userId) report.reporterId = null;
  state.moderators = state.moderators.filter((m) => m.userId !== userId);
  for (const m of state.moderators) if (m.grantedBy === userId) m.grantedBy = null;
  for (const a of state.moderationActions) if (a.moderatorId === userId) a.moderatorId = null;
  state.localRevocations = state.localRevocations.filter((r) => r.userId !== userId);
  for (const r of state.localRevocations) if (r.revokedBy === userId) r.revokedBy = null;
  state.rateLimits = state.rateLimits.filter((r) => r.userId !== userId);

  state.profileInterests = state.profileInterests.filter((i) => i.profileId !== userId);
  state.profiles = state.profiles.filter((p) => p.id !== userId);
  state.authUsers = state.authUsers.filter((u) => u.id !== userId);
  persist();
  return { placePhotos, avatars };
}
