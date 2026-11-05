/**
 * Account deletion for the place-lane collections (tips, 2.6; later save details
 * and personal photos), mirroring the SQL foreign keys: rows on the user's own
 * places go with the places (cascade), their confirmations go (cascade), their
 * authored tips and corrections stay anonymized (set null).
 */
import type { DemoState } from "./store";
import { ensureTips } from "./tips";

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
}
