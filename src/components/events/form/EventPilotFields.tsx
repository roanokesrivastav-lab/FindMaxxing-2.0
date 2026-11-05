"use client";
import type { Event } from "@/lib/data/types";
import { FormField, Input, Textarea } from "@/components/ui/Field";
import { NEWCOMER_LIMITS } from "@findmaxxing/shared/events";

/**
 * Pilot event form sections (roadmap M4), shown only with pilotEvents on. 4.1: the "Your first
 * time?" block. Every field is optional; the event page shows the block only when one is filled in.
 */
export function EventPilotFields({ initial, errors }: { initial?: Event; errors: Record<string, string | undefined> }) {
  const n = initial?.newcomer ?? null;
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
      <label className="type-body text-ink flex items-center gap-item">
        <input type="checkbox" name="newcomerSolo" defaultChecked={!!n?.soloWelcome} className="h-5 w-5 accent-ink" />
        Coming alone is normal here
      </label>
    </fieldset>
  );
}
