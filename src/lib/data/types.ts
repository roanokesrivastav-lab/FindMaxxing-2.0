/** Domain types live in packages/shared (also used by the mobile app). */
export * from "@findmaxxing/shared/types";

/** One head-to-head question: is `opponent` better than `subject`, which the viewer just rated? */
export interface ComparisonPrompt {
  subject: { id: string; name: string };
  opponent: { id: string; name: string };
}
