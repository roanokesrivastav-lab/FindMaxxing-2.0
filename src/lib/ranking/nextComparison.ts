/**
 * Which place to ask about next after someone rates one (stage 1b). The new
 * place is placed among the places they gave the same stars by binary search:
 * the others in that bucket are ordered best first by their fitted score, and
 * each answer already given removes the half the new place cannot belong to.
 * Derived entirely from the stored answers, so it needs no session state and a
 * refresh resumes where it stopped. At most ceil(log2(bucket + 1)) questions.
 */
import type { Comparison } from "./bradleyTerry";

export interface RankedPlace { id: string; stars: number; score: number }

export function nextOpponent(subject: string, rated: RankedPlace[], answers: Comparison[]): string | null {
  const me = rated.find((p) => p.id === subject);
  if (!me) return null;
  const bucket = rated
    .filter((p) => p.id !== subject && p.stars === me.stars)
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  let lo = 0;
  let hi = bucket.length;
  const answered = new Set<string>();
  for (const a of answers) {
    const opponent = a.winnerId === subject ? a.loserId : a.loserId === subject ? a.winnerId : null;
    if (!opponent) continue;
    const at = bucket.findIndex((p) => p.id === opponent);
    if (at < 0) continue;
    answered.add(opponent);
    if (a.winnerId === subject) hi = Math.min(hi, at);
    else lo = Math.max(lo, at + 1);
  }
  const open = bucket.slice(lo, hi).filter((p) => !answered.has(p.id));
  return open.length ? open[Math.floor(open.length / 2)].id : null;
}
