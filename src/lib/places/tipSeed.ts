/**
 * Seeded "Still true?" confirmations (roadmap 2.6), applied by the SQL seed
 * (scripts/generate-seed-sql.ts) and the demo store alike, so demo mode shows a
 * confirmed, dated tip. Each confirms the place's tip written by its creator.
 */
export const SEED_TIP_CONFIRMATIONS: { place: string; user: string }[] = [
  { place: "Cannon & Crown", user: "maya_r" }, // tip by theo
  { place: "Meeple Cellar", user: "jules" }, // tip by sam_k
  { place: "Tuttle Lot Fields", user: "theo" }, // tip by maya_r
];
