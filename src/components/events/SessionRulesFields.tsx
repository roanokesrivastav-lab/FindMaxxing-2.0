"use client";
import { FormField, Input, Select } from "@/components/ui/Field";
import type { Event } from "@/lib/data/types";

const LEADS: [number, string][] = [[60, "1 hour before"], [120, "2 hours before"], [180, "3 hours before"], [360, "6 hours before"], [720, "12 hours before"], [1440, "The day before"]];

/**
 * Minimum attendance, when the host decides, and whether the venue is booked
 * (roadmap 4.3). The hidden "sessionRules" field tells the action these were
 * on the form, so an empty minimum means "no minimum", not "keep".
 */
export function SessionRulesFields({ initial, errors }: { initial?: Event; errors: Record<string, string | undefined> }) {
  const lead = initial?.decisionDeadline ? Math.round((Date.parse(initial.startsAt) - Date.parse(initial.decisionDeadline)) / 60_000) : null;
  const custom = lead !== null && lead > 0 && !LEADS.some(([m]) => m === lead);
  return (
    <fieldset className="flex flex-col gap-3">
      <input type="hidden" name="sessionRules" value="1" />
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Minimum to go ahead" htmlFor="minAttendance" hint="optional" error={errors.minAttendance}>
          <Input id="minAttendance" name="minAttendance" type="number" min={2} max={5000} defaultValue={initial?.minAttendance ?? ""} placeholder="No minimum" error={errors.minAttendance} />
        </FormField>
        <FormField label="Decide by" htmlFor="decisionLeadMinutes" hint="needs a minimum" error={errors.decisionLeadMinutes}>
          <Select id="decisionLeadMinutes" name="decisionLeadMinutes" defaultValue={lead !== null && lead > 0 ? String(lead) : ""} error={errors.decisionLeadMinutes}>
            <option value="">No set time</option>
            {custom ? <option value={lead!}>{lead} minutes before</option> : null}
            {LEADS.map(([m, label]) => <option key={m} value={m}>{label}</option>)}
          </Select>
        </FormField>
      </div>
      <p className="text-xs text-muted -mt-1">If fewer people are going at that time, the event is cancelled and everyone going is told. You can confirm it yourself before then.</p>
      <label className="flex items-center gap-2 text-sm font-medium min-h-11">
        <input type="checkbox" name="venueUnconfirmed" defaultChecked={initial?.venueStatus === "unconfirmed"} className="h-5 w-5 accent-pulse" />
        The venue isn&apos;t confirmed yet
      </label>
    </fieldset>
  );
}
