"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { LocateFixed, MapPin } from "lucide-react";
import { INTERESTS } from "@/lib/data/taxonomy";
import { HOME_CITY_COOLDOWN_DAYS } from "@/lib/data/types";
import { Chip } from "@/components/ui/Chip";
import { Button } from "@/components/ui/Button";
import { FormField, Input } from "@/components/ui/Field";
import { Avatar } from "@/components/ui/Avatar";
import { FollowButton } from "@/components/profile/FollowButton";
import { Logo } from "@/components/layout/Logo";
import { finishOnboardingAction, saveOnboardingStepAction } from "@/server/actions/onboarding";
import { formatInZone } from "@/lib/utils/format";
import { useViewerTime } from "@/components/time/ViewerTime";

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
      const tags = toMap && res.data.interests.length ? `?tags=${encodeURIComponent(res.data.interests.slice(0, 8).join(","))}&welcome=1` : "?welcome=1";
      router.replace(`/${tags}`);
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

  const toggle = (slug: string) =>
    setInterests((s) => (s.includes(slug) ? s.filter((x) => x !== slug) : s.length >= 12 ? s : [...s, slug]));
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
              <h1 ref={headingRef} tabIndex={-1} className="text-2xl font-bold outline-none">Welcome, {displayName.split(" ")[0]}. What are you into?</h1>
              <p className="text-sm text-muted mt-1 mb-4">The map starts filtered to these, and we suggest people who share them.</p>
              <div className="flex flex-wrap gap-2" role="group" aria-label="Interests">
                {INTERESTS.map((i) => (
                  <Chip key={i.slug} active={interests.includes(i.slug)} onClick={() => toggle(i.slug)}>
                    <span aria-hidden>{i.emoji}</span> {i.label}
                  </Chip>
                ))}
              </div>
              <StepButtons pending={pending} onSkip={next} onNext={() => save({ interests })} nextLabel={interests.length ? "Next" : "Next without interests"} />
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
    <div className="mt-6 flex gap-2">
      <Button type="button" variant="ghost" className="flex-1" onClick={onSkip} disabled={pending}>{skipLabel}</Button>
      <Button type="button" variant="ink" className="flex-1" onClick={onNext} loading={pending}>{nextLabel}</Button>
    </div>
  );
}
