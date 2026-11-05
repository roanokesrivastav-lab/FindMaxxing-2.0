/**
 * What may be kept of a validation (6.0 SPEC §5, decision R-2): our verdict and our suggested edit,
 * never a provider duration, distance or geometry. 6.3 stores exactly this shape in
 * outing_itineraries.validation; nothing in 6.1/6.2 writes it anywhere.
 */
import type { RouterId } from "./types";
import type { FailingCode, Suggestion, ValidationResult } from "./validate";

export type StoredVerdict = {
  status: ValidationResult["status"];
  /** Which constraint failed and where; the provider-derived minutes are left out. */
  failing?: { code: FailingCode; stopId: string };
  suggestion?: Suggestion;
  /** The first uncertain stop. */
  uncertainStopId?: string;
  validated_at: string;
  router: RouterId;
};

/** Allow-list copy: any field not named here (seconds, meters, walk minutes, times) is dropped. */
export function storedVerdict(result: ValidationResult, meta: { validatedAt: string; router: RouterId }): StoredVerdict {
  const verdict: StoredVerdict = { status: result.status, validated_at: meta.validatedAt, router: meta.router };
  if (result.status === "infeasible") {
    verdict.failing = { code: result.failing.code, stopId: result.failing.stopId };
    if (result.suggestion) {
      const s = result.suggestion;
      verdict.suggestion =
        s.kind === "drop_stop" ? { kind: s.kind, stopId: s.stopId, recheck: true }
        : s.kind === "shorten_stop" ? { kind: s.kind, stopId: s.stopId, byMin: s.byMin, durationMin: s.durationMin, recheck: false }
        : s.kind === "start_earlier" ? { kind: s.kind, byMin: s.byMin, startLocal: s.startLocal, recheck: false }
        : { kind: s.kind, stopIds: [s.stopIds[0], s.stopIds[1]], recheck: true };
    }
  }
  if (result.status === "uncertain") verdict.uncertainStopId = result.stopId;
  return verdict;
}

/** Unknown legs caused by the provider being slow, failing or absent, rather than by the route itself. */
export function providerUnavailable(result: ValidationResult): boolean {
  return result.status === "uncertain"
    && result.uncertain.some((u) => u.kind === "leg" && u.reason !== "no_route");
}

export type Shown<P> = { plan: P | null; verdict: StoredVerdict | null; possiblyOutdated: boolean };

/**
 * After re-validating a saved plan: the plan itself is never changed or dropped by validation. When the
 * provider timed out or failed, the last saved verdict stays on show, marked possibly outdated, instead
 * of being replaced by "uncertain". Any other fresh result replaces the shown verdict.
 */
export function afterRevalidation<P>(
  saved: { plan: P; verdict: StoredVerdict } | null,
  fresh: ValidationResult,
  meta: { validatedAt: string; router: RouterId },
): Shown<P> {
  if (saved && providerUnavailable(fresh)) return { plan: saved.plan, verdict: saved.verdict, possiblyOutdated: true };
  return { plan: saved?.plan ?? null, verdict: storedVerdict(fresh, meta), possiblyOutdated: false };
}
