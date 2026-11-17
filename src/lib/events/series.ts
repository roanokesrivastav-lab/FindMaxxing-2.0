import type { SeriesRuleShape } from "@/lib/data/types";

const DAY_NAMES = ["", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

/** "Tuesdays and Thursdays", "every 2 weeks on Mondays": the rule in words for the page. */
export function describeRepeat(rule: SeriesRuleShape): string {
  const days = [...rule.weekdays].sort((a, b) => a - b).map((d) => DAY_NAMES[d] ?? "");
  const list = days.length <= 1 ? days.join("") : `${days.slice(0, -1).join(", ")} and ${days[days.length - 1]}`;
  return rule.interval === 1 ? `weekly on ${list}` : `every ${rule.interval} weeks on ${list}`;
}
