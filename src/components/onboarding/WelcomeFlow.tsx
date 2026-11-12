"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, ChevronDown, LocateFixed, MapPin } from "lucide-react";
import { MAX_INTERESTS } from "@/lib/data/taxonomy";
import { FEATURED_INTERESTS, MORE_INTERESTS, firstMapHref, hasMoreSelected, toggleInterest } from "@/lib/onboarding/interests";
import { HOME_CITY_COOLDOWN_DAYS } from "@/lib/data/types";
import { Button } from "@/components/ui/Button";
import { FormField, Input } from "@/components/ui/Field";
import { Avatar } from "@/components/ui/Avatar";
import { FollowButton } from "@/components/profile/FollowButton";
import { Logo } from "@/components/layout/Logo";
import { finishOnboardingAction, saveOnboardingStepAction } from "@/server/actions/onboarding";
import { formatInZone } from "@/lib/utils/format";
import { useViewerTime } from "@/components/time/ViewerTime";
import { InterestIcon } from "@/components/ui/TaxonomyIcon";
import { cn } from "@/lib/utils/cn";
import { InterestThumb } from "./InterestThumb";

interface Person {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  interests: string[];
}

const STEPS = ["Interests", "Home city", "Location", "People"] as const;
const DATE: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };

/**
 * Four short steps, each skippable. Finishing or skipping marks onboarding done
 * (it never shows again) and lands on the map filtered to the chosen interests.
 *
 * Interests (roadmap 1.2): six rows with a thumbnail and a checkmark, the rest
 * under "More interests", no minimum. The limit is MAX_INTERESTS, said up front
 * and again when it is reached; the first map filters by every one accepted.
 */
export function WelcomeFlow({
  displayName,
  initialInterests,
  initialHomeCity,
  localFrom,
  localDays,
  people,
}: {
  displayName: string;
  initialInterests: string[];
  initialHomeCity: string | null;
  localFrom: string;
  localDays: number;
  people: Person[];
}) {
  const [step, setStep] = useState(0);
  const [interests, setInterests] = useState<string[]>(initialInterests);
  // Open from the start when a saved choice lives outside the first six, so nothing selected is hidden.
  const [moreOpen, setMoreOpen] = useState(() => hasMoreSelected(initialInterests));
  const [limitHit, setLimitHit] = useState(false);
  const [homeCity, setHomeCity] = useState(initialHomeCity ?? "");
  const [error, setError] = useState<string | null>(null);
  const [location, setLocation] = useState<"idle" | "asking" | "granted" | "denied">("idle");
  const [pending, start] = useTransition();
  const router = useRouter();
  const time = useViewerTime();
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Each step announces itself: focus moves to its heading.
  useEffect(() => {
    headingRef.current?.focus();
  }, [step]);

  const next = () => {
    setError(null);
    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const save = (input: { interests?: string[]; homeCity?: string | null }) =>
    start(async () => {
      const res = await saveOnboardingStepAction(input);
      if (!res.ok) {
        setError(res.fieldErrors?.homeCity ?? res.fieldErrors?.interests ?? res.error);
        return;
      }
      next();
    });

  const finish = (toMap: boolean) =>
    start(async () => {
      const res = await finishOnboardingAction();
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Every saved interest goes to the map: the link, the page and the discovery query share one limit.
      router.replace(firstMapHref(res.data.interests, toMap));
    });

  const askLocation = () => {
    if (!("geolocation" in navigator)) {
      setLocation("denied");
      return;
    }
    setLocation("asking");
    navigator.geolocation.getCurrentPosition(
      () => setLocation("granted"),
      () => setLocation("denied"),
      { timeout: 10_000 },
    );
  };

  const toggle = (slug: string) => {
    const result = toggleInterest(interests, slug);
    setInterests(result.selected);
    setLimitHit(result.refused);
  };
  const atLimit = interests.length >= MAX_INTERESTS;
  const moreSelected = MORE_INTERESTS.filter((i) => interests.includes(i.slug)).length;
  // Skipping the step keeps what was already saved, so the People step never matches on unsaved taps.
  const skipInterests = () => {
    setInterests(initialInterests);
    setLimitHit(false);
    next();
  };
  const matching = people
    .map((p) => ({ p, overlap: p.interests.filter((i) => interests.includes(i)).length }))
    .sort((a, b) => b.overlap - a.overlap)
    .slice(0, 5);

  return (
    <div className="min-h-dvh paper-grid">
      <div className="max-w-md mx-auto px-4 pt-6 pb-12">
        <div className="flex items-center justify-between mb-6">
          <Logo size={28} />
          <button type="button" onClick={() => finish(false)} disabled={pending} className="text-sm font-semibold text-muted hover:text-ink">
            Skip setup
          </button>
        </div>
        <p className="text-xs font-bold uppercase tracking-[0.12em] text-flare-ink" aria-live="polite">
          Step {step + 1} of {STEPS.length} · {STEPS[step]}
        </p>
        <div className="mt-2 mb-5 flex gap-1.5" aria-hidden>
          {STEPS.map((s, i) => (
            <span key={s} className={`h-1.5 flex-1 rounded-full ${i <= step ? "bg-ink" : "bg-line"}`} />
          ))}
        </div>

        <section className="card p-5">
          {step === 0 ? (
            <>
              <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold outline-none">Welcome, {displayName.split(" ")[0]}. What would you go out for?</h1>
              <p id="interest-help" className="text-sm text-muted mt-1 mb-3">
                Pick any that fit, up to {MAX_INTERESTS}, or none. The map opens showing what you pick, and you can change it there.
              </p>
              <ul className="list-none p-0 m-0" aria-label="Interests">
                {FEATURED_INTERESTS.map((i) => {
                  const on = interests.includes(i.slug);
                  const blocked = atLimit && !on;
                  return (
                    <li key={i.slug} className="surface-flat">
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={on}
                        aria-disabled={blocked || undefined}
                        aria-describedby={blocked ? "interest-limit" : undefined}
                        data-interest={i.slug}
                        onClick={() => toggle(i.slug)}
                        className={cn(
                          "w-full flex flex-wrap items-center gap-x-row gap-y-item py-3 text-left rounded-xl",
                          blocked && "opacity-60",
                        )}
                      >
                        <InterestThumb slug={i.slug} src={i.thumbnail} color={i.color} />
                        <span className="flex min-w-0 flex-1 basis-[9rem] flex-col gap-hair">
                          <span className="type-item-title text-ink break-words">{i.label}</span>
                          <span className="type-body text-ink-2 break-words">{i.blurb}</span>
                        </span>
                        <CheckMark on={on} />
                      </button>
                    </li>
                  );
                })}
              </ul>
              <button
                type="button"
                aria-expanded={moreOpen}
                aria-controls="more-interests"
                onClick={() => setMoreOpen((v) => !v)}
                className="mt-3 inline-flex items-center gap-1.5 min-h-11 text-sm font-semibold text-ink"
              >
                <ChevronDown size={16} aria-hidden className={cn("transition-transform", moreOpen && "rotate-180")} />
                More interests
                {moreSelected ? <span className="text-muted font-medium">({moreSelected} selected)</span> : null}
              </button>
              {/* Kept in the page while closed (hidden), so the button's aria-controls always has a target. */}
              <div id="more-interests" hidden={!moreOpen} className="mt-1 flex flex-wrap gap-2" role="group" aria-label="More interests">
                {MORE_INTERESTS.map((i) => {
                  const on = interests.includes(i.slug);
                  const blocked = atLimit && !on;
                  return (
                    <button
                      key={i.slug}
                      type="button"
                      role="checkbox"
                      aria-checked={on}
                      aria-disabled={blocked || undefined}
                      aria-describedby={blocked ? "interest-limit" : undefined}
                      data-interest={i.slug}
                      data-active={on ? "true" : "false"}
                      onClick={() => toggle(i.slug)}
                      className={cn("chip", blocked && "opacity-60")}
                    >
                      {on ? <Check size={14} aria-hidden /> : <InterestIcon slug={i.slug} />} {i.label}
                    </button>
                  );
                })}
              </div>
              <p id="interest-limit" role="status" className={cn("mt-3 text-sm", atLimit ? (limitHit ? "text-ink font-semibold" : "text-muted") : "sr-only")}>
                {atLimit ? `That’s ${MAX_INTERESTS}, the most the map can use at once. Remove one to pick another.` : interests.length ? `${interests.length} selected` : "None selected"}
              </p>
              {error ? <p className="mt-3 text-sm text-danger font-medium" role="alert">{error}</p> : null}
              <StepButtons pending={pending} onSkip={skipInterests} onNext={() => save({ interests })} nextLabel="Continue to home city" />
            </>
          ) : null}

          {step === 1 ? (
            <>
              <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold outline-none">Where&apos;s home?</h1>
              <p className="text-sm text-muted mt-1 mb-4">
                Locals see places other locals keep for each other. You count as a local of your home city from {formatInZone(localFrom, time, DATE)} ({localDays} days after joining),
                and your home city can change once every {HOME_CITY_COOLDOWN_DAYS} days.
              </p>
              <FormField label="Home city" htmlFor="welcome-city" error={error ?? undefined}>
                <Input id="welcome-city" value={homeCity} onChange={(e) => setHomeCity(e.target.value)} maxLength={80} placeholder="Columbus" autoComplete="address-level2" />
              </FormField>
              <StepButtons pending={pending} onSkip={next} onNext={() => (homeCity.trim() ? save({ homeCity: homeCity.trim() }) : next())} />
            </>
          ) : null}

          {step === 2 ? (
            <>
              <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold outline-none">Show what&apos;s near you?</h1>
              <p className="text-sm text-muted mt-1 mb-4">
                With your location the map opens where you are and lists can sort by distance. It stays on your device; we never store it.
              </p>
              {location === "granted" ? (
                <p className="text-sm font-semibold text-moss inline-flex items-center gap-2" role="status"><MapPin size={16} /> Location on.</p>
              ) : location === "denied" ? (
                <p className="text-sm text-muted" role="status">No problem. You can turn it on later from the map.</p>
              ) : (
                <Button type="button" variant="secondary" onClick={askLocation} loading={location === "asking"}>
                  <LocateFixed size={16} /> Use my location
                </Button>
              )}
              <StepButtons pending={pending} onSkip={next} onNext={next} skipLabel="Not now" />
            </>
          ) : null}

          {step === 3 ? (
            <>
              <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold outline-none">People into the same things</h1>
              <p className="text-sm text-muted mt-1 mb-4">Follow a few to see what they save and add. Then save your first place from the map.</p>
              {matching.length ? (
                <ul className="flex flex-col gap-2 list-none p-0 m-0">
                  {matching.map(({ p }) => (
                    <li key={p.id} className="flex items-center gap-3">
                      <Avatar name={p.displayName} src={p.avatarUrl} size={40} />
                      <span className="flex-1 min-w-0">
                        <span className="block font-semibold text-sm truncate">{p.displayName}</span>
                        <span className="block text-xs text-muted truncate">@{p.username}</span>
                      </span>
                      <FollowButton userId={p.id} following={false} signedIn size="sm" />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-muted">Nobody to suggest yet. People will show up as the community grows.</p>
              )}
              {error ? <p className="mt-3 text-sm text-danger font-medium" role="alert">{error}</p> : null}
              <Button type="button" size="lg" variant="ink" className="w-full mt-5" loading={pending} onClick={() => finish(true)}>
                Go to the map
              </Button>
            </>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function StepButtons({ pending, onSkip, onNext, nextLabel = "Next", skipLabel = "Skip" }: { pending: boolean; onSkip: () => void; onNext: () => void; nextLabel?: string; skipLabel?: string }) {
  return (
    // Wraps at large text sizes: the buttons stack and a long label takes two lines instead of running off the side.
    <div className="mt-6 flex flex-wrap gap-2">
      <Button type="button" variant="ghost" className="flex-1 basis-[5rem] h-auto min-h-11 py-2 whitespace-normal" onClick={onSkip} disabled={pending}>{skipLabel}</Button>
      <Button type="button" variant="ink" className="grow-[2] basis-[13rem] h-auto min-h-11 py-2 whitespace-normal" onClick={onNext} loading={pending}>{nextLabel}</Button>
    </div>
  );
}

/** Visible selected state: a filled circle with a check, or an empty ring. Shape and fill change, not colour alone. */
function CheckMark({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      data-check={on ? "on" : "off"}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2",
        on ? "bg-ink border-ink text-white" : "border-line-2 text-transparent",
      )}
    >
      <Check size={16} strokeWidth={3} />
    </span>
  );
}
