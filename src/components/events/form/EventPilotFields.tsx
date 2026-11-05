"use client";
import { useState } from "react";
import type { Event } from "@/lib/data/types";
import { FormField, Input, Select, Textarea } from "@/components/ui/Field";
import { ACTIVITY_KINDS, ACTIVITY_KIND_LABELS, DECISION_LEADS_MINUTES, NEWCOMER_LIMITS, SKILL_LABELS, SKILL_LEVELS, type ActivityDetails, type ActivityKind } from "@findmaxxing/shared/events";

/**
 * Pilot event form sections (roadmap M4), shown only with pilotEvents on. 4.1: the "Your first
 * time?" block. Every field is optional; the event page shows the block only when one is filled in.
 */
export function EventPilotFields({ initial, errors }: { initial?: Event; errors: Record<string, string | undefined> }) {
  const n = initial?.newcomer ?? null;
  return (
    <>
      <ActivityFields initial={initial?.activityDetails ?? null} errors={errors} />
      <SessionRuleFields initial={initial} errors={errors} />
      <NewcomerFields n={n} errors={errors} />
      <fieldset className="flex flex-col gap-2">
        <legend className="type-item-title text-ink">Event card</legend>
        <Check name="partyPoster" label="Show it as a party poster" defaultChecked={initial?.cardStyle === "party_poster"} />
        <p className="type-body text-ink-2">For parties, shows and socials. Off, the card shows who&apos;s going and how many spots are open.</p>
      </fieldset>
    </>
  );
}

function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked: boolean }) {
  return (
    <label className="type-body text-ink flex items-center gap-item">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="h-5 w-5 accent-ink" />
      {label}
    </label>
  );
}

/** 4.2: only the small section for the chosen kind is shown (and submitted). */
function ActivityFields({ initial, errors }: { initial: ActivityDetails | null; errors: Record<string, string | undefined> }) {
  const [kind, setKind] = useState<ActivityKind | "">(initial?.kind ?? "");
  const d = (initial ?? {}) as Record<string, unknown>;
  const same = initial?.kind === kind;
  const v = (k: string) => (same && d[k] != null ? String(d[k]) : "");
  const b = (k: string) => same && d[k] === true;
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="type-item-title text-ink">Activity details</legend>
      <FormField label="Activity type" htmlFor="activityKind" hint="optional" error={errors.activityKind}>
        <Select id="activityKind" name="activityKind" value={kind} onChange={(e) => setKind(e.target.value as ActivityKind | "")} error={errors.activityKind}>
          <option value="">None</option>
          {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{ACTIVITY_KIND_LABELS[k]}</option>)}
        </Select>
      </FormField>
      {kind === "run" ? (
        <>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Distance" htmlFor="runDistance" hint="optional" error={errors.runDistance}>
              <Input id="runDistance" name="runDistance" type="number" step="0.1" min={0.5} max={100} defaultValue={v("distance")} error={errors.runDistance} />
            </FormField>
            <FormField label="Unit" htmlFor="runUnit">
              <Select id="runUnit" name="runUnit" defaultValue={v("unit") || "mi"}>
                <option value="mi">miles</option>
                <option value="km">km</option>
              </Select>
            </FormField>
            <FormField label="Pace from" htmlFor="runPaceFrom" hint="m:ss" error={errors.runPaceFrom}>
              <Input id="runPaceFrom" name="runPaceFrom" inputMode="numeric" placeholder="9:00" defaultValue={v("paceFrom")} error={errors.runPaceFrom} />
            </FormField>
            <FormField label="Pace to" htmlFor="runPaceTo" hint="m:ss" error={errors.runPaceTo}>
              <Input id="runPaceTo" name="runPaceTo" inputMode="numeric" placeholder="10:30" defaultValue={v("paceTo")} error={errors.runPaceTo} />
            </FormField>
          </div>
          <FormField label="Where you regroup" htmlFor="runRegroup" hint="optional" error={errors.runRegroup}>
            <Input id="runRegroup" name="runRegroup" maxLength={120} placeholder="e.g. At every mile marker" defaultValue={v("regroup")} error={errors.runRegroup} />
          </FormField>
          <Check name="runNoDrop" label="No-drop: nobody gets left behind" defaultChecked={b("noDrop")} />
          <FormField label="How no-drop works here" htmlFor="runNoDropNote" hint="optional" error={errors.runNoDropNote}>
            <Input id="runNoDropNote" name="runNoDropNote" maxLength={160} placeholder="e.g. A sweeper runs at the back" defaultValue={v("noDropNote")} error={errors.runNoDropNote} />
          </FormField>
        </>
      ) : kind === "volleyball" || kind === "basketball" ? (
        <>
          <FormField label="Format" htmlFor="gameFormat" hint="optional" error={errors.gameFormat}>
            <Input id="gameFormat" name="gameFormat" maxLength={40} placeholder={kind === "basketball" ? "e.g. Half-court 3s" : "e.g. 4v4 on grass"} defaultValue={v("format")} error={errors.gameFormat} />
          </FormField>
          <FormField label="Player limit" htmlFor="gamePlayerLimit" hint="optional" error={errors.gamePlayerLimit}>
            <Input id="gamePlayerLimit" name="gamePlayerLimit" type="number" min={2} max={200} defaultValue={v("playerLimit")} error={errors.gamePlayerLimit} />
          </FormField>
          <Check name="gameBeginners" label="Beginners welcome" defaultChecked={b("beginnersWelcome")} />
        </>
      ) : kind === "pickleball" ? (
        <>
          <FormField label="Level" htmlFor="pbLevel" hint="optional" error={errors.pbLevel}>
            <Select id="pbLevel" name="pbLevel" defaultValue={v("level")} error={errors.pbLevel}>
              <option value="">Any level</option>
              {SKILL_LEVELS.map((l) => <option key={l} value={l}>{SKILL_LABELS[l]}</option>)}
            </Select>
          </FormField>
          <FormField label="Singles or doubles" htmlFor="pbPlay" hint="optional" error={errors.pbPlay}>
            <Select id="pbPlay" name="pbPlay" defaultValue={v("play")} error={errors.pbPlay}>
              <option value="">Not set</option>
              <option value="singles">Singles</option>
              <option value="doubles">Doubles</option>
              <option value="either">Either</option>
            </Select>
          </FormField>
          <Check name="pbPaddles" label="Paddles available to borrow" defaultChecked={b("paddlesAvailable")} />
        </>
      ) : kind === "walk" ? (
        <FormField label="Anything to know" htmlFor="walkNote" hint="optional" error={errors.walkNote}>
          <Input id="walkNote" name="walkNote" maxLength={160} placeholder="e.g. Stroller friendly, flat route" defaultValue={v("note")} error={errors.walkNote} />
        </FormField>
      ) : null}
    </fieldset>
  );
}

const leadLabel = (m: number) => (m < 1440 ? `${m / 60} hour${m === 60 ? "" : "s"} before the start` : `${m / 1440} day${m === 1440 ? "" : "s"} before the start`);

/** 4.3: minimum attendance, when the host decides, and whether the venue is booked. */
function SessionRuleFields({ initial, errors }: { initial?: Event; errors: Record<string, string | undefined> }) {
  // The stored deadline as the nearest lead option (the form offers fixed leads).
  const lead = initial?.decisionDeadline
    ? DECISION_LEADS_MINUTES.reduce((best, m) => (Math.abs(Date.parse(initial.startsAt) - Date.parse(initial.decisionDeadline!) - m * 60_000) < Math.abs(Date.parse(initial.startsAt) - Date.parse(initial.decisionDeadline!) - best * 60_000) ? m : best), DECISION_LEADS_MINUTES[0])
    : "";
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="type-item-title text-ink">Does it need enough people?</legend>
      <FormField label="Minimum people" htmlFor="minAttendance" hint="optional" error={errors.minAttendance}>
        <Input id="minAttendance" name="minAttendance" type="number" min={2} max={5000} defaultValue={initial?.minAttendance ?? ""} placeholder="e.g. 8 for a 4v4 game" error={errors.minAttendance} />
      </FormField>
      <FormField label="Decide by" htmlFor="decisionLead" hint="optional" error={errors.decisionLead}>
        <Select id="decisionLead" name="decisionLead" defaultValue={String(lead)} error={errors.decisionLead}>
          <option value="">No deadline</option>
          {DECISION_LEADS_MINUTES.map((m) => <option key={m} value={m}>{leadLabel(m)}</option>)}
        </Select>
      </FormField>
      <p className="type-body text-ink-2 -mt-2">If fewer than the minimum have signed up by then, it&apos;s called off and everyone going is told. You can confirm it&apos;s happening earlier.</p>
      <Check name="venueUnconfirmed" label="The venue isn't booked yet" defaultChecked={initial?.venueStatus === "unconfirmed"} />
    </fieldset>
  );
}

function NewcomerFields({ n, errors }: { n: Event["newcomer"]; errors: Record<string, string | undefined> }) {
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="type-item-title text-ink">For first-timers</legend>
      <p className="type-body text-ink-2 -mt-2">Optional. Shown as &ldquo;Your first time?&rdquo; on the event page.</p>
      <FormField label="Where exactly to find you" htmlFor="newcomerMeetingSpot" hint="optional" error={errors.newcomerMeetingSpot}>
        <Input id="newcomerMeetingSpot" name="newcomerMeetingSpot" maxLength={NEWCOMER_LIMITS.meetingSpot} defaultValue={n?.meetingSpot ?? ""} placeholder="e.g. By the north goal, orange cones" error={errors.newcomerMeetingSpot} autoComplete="off" />
      </FormField>
      <FormField label="Who welcomes newcomers" htmlFor="newcomerWelcomer" hint="optional" error={errors.newcomerWelcomer}>
        <Input id="newcomerWelcomer" name="newcomerWelcomer" maxLength={NEWCOMER_LIMITS.welcomer} defaultValue={n?.welcomer ?? ""} placeholder="e.g. Maya, in the blue cap" error={errors.newcomerWelcomer} autoComplete="off" />
      </FormField>
      <FormField label="What to bring" htmlFor="newcomerBring" hint="optional" error={errors.newcomerBring}>
        <Textarea id="newcomerBring" name="newcomerBring" maxLength={NEWCOMER_LIMITS.bring} defaultValue={n?.bring ?? ""} placeholder="e.g. Water, a light and a dark shirt" error={errors.newcomerBring} />
      </FormField>
      <Check name="newcomerSolo" label="Coming alone is normal here" defaultChecked={!!n?.soloWelcome} />
    </fieldset>
  );
}
