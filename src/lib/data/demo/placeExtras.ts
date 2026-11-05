/**
 * Account deletion for the place-lane collections (tips, 2.6; later save details
 * and personal photos), mirroring the SQL foreign keys: rows on the user's own
 * places go with the places (cascade), their confirmations go (cascade), their
 * authored tips and corrections stay anonymized (set null).
 */
import type { DemoState } from "./store";
import { ensureTips } from "./tips";
import { ensureOccasions } from "./occasions";
import { ensurePersonalPhotos, ensurePublicPhotos, removePersonalFile } from "./personalPhotos";

export function forgetPlaceExtras(state: DemoState, userId: string, ownPlaces: Set<string>): void {
  const tips = ensureTips(state);
  const goneTips = new Set(tips.placeTips.filter((t) => ownPlaces.has(t.placeId)).map((t) => t.id));
  tips.placeTips = tips.placeTips.filter((t) => !goneTips.has(t.id));
  for (const t of tips.placeTips) {
    if (t.authorId === userId) t.authorId = null;
    if (t.lastConfirmedBy === userId) t.lastConfirmedBy = null;
  }
  tips.placeTipConfirmations = tips.placeTipConfirmations.filter((c) => c.userId !== userId && !goneTips.has(c.tipId));
  tips.placeTipCorrections = tips.placeTipCorrections.filter((c) => !goneTips.has(c.tipId));
  for (const c of tips.placeTipCorrections) if (c.authorId === userId) c.authorId = null;
  const notes = ensureOccasions(state);
  (state as DemoState & { placeOccasionNotes: typeof notes }).placeOccasionNotes = notes.filter((n) => !ownPlaces.has(n.placeId));
  for (const n of ensureOccasions(state)) if (n.authorId === userId) n.authorId = null;
  // Personal photos are the user's alone: every one goes, file and row. Public-photo
  // credits on their own places go with the places; credits they set stay, unattributed.
  const mine = ensurePersonalPhotos(state);
  for (const r of mine) if (r.userId === userId || ownPlaces.has(r.placeId)) removePersonalFile(r.file);
  (state as DemoState & { personalPlacePhotos: typeof mine }).personalPlacePhotos = mine.filter((r) => r.userId !== userId && !ownPlaces.has(r.placeId));
  const credits = ensurePublicPhotos(state);
  (state as DemoState & { placePublicPhotos: typeof credits }).placePublicPhotos = credits.filter((c) => !ownPlaces.has(c.placeId));
  for (const c of ensurePublicPhotos(state)) if (c.setBy === userId) c.setBy = null;
}
