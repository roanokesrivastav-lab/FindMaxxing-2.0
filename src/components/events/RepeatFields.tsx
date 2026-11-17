"use client";
import { useState } from "react";
import { FormField, Input, Select } from "@/components/ui/Field";

const DAYS: [number, string, string][] = [[1, "Mon", "Monday"], [2, "Tue", "Tuesday"], [3, "Wed", "Wednesday"], [4, "Thu", "Thursday"], [5, "Fri", "Friday"], [6, "Sat", "Saturday"], [7, "Sun", "Sunday"]];

/**
 * Make the session repeat (roadmap 4.5a). Off by default: the event is a
 * one-off unless the host turns this on. The days are ISO weekdays; the time
 * and length come from the Starts and Ends fields above, in the zone they
 * were typed in. The first four weeks are created at once and the rest as
 * the weeks come round.
 */
export function RepeatFields({ errors, defaultWeekday }: { errors: Record<string, string | undefined>; /** ISO weekday of the chosen date, pre-ticked. */ defaultWeekday: number }) {
  const [on, setOn] = useState(false);
  return (
    <fieldset className="flex flex-col gap-3" data-repeat-fields="">
      <label className="flex items-center gap-2 text-sm font-medium min-h-11">
        <input type="checkbox" name="repeat" value="weekly" checked={on} onChange={(e) => setOn(e.target.checked)} className="h-5 w-5 accent-pulse" />
        Repeats every week
      </label>
      {on ? (
        <div className="flex flex-col gap-3 pl-1">
          <div role="group" aria-labelledby="repeat-days-label">
            <p id="repeat-days-label" className="text-sm font-medium mb-1.5">On these days</p>
            <div className="flex flex-wrap gap-2">
              {DAYS.map(([n, short, long]) => (
                <label key={n} className="chip h-9 cursor-pointer has-[:checked]:bg-pulse has-[:checked]:text-white">
                  <input type="checkbox" name="weekday" value={n} defaultChecked={n === defaultWeekday} className="sr-only" aria-label={long} />
                  {short}
                </label>
              ))}
            </div>
            {errors.weekday ? <p className="text-sm text-danger mt-1" role="alert">{errors.weekday}</p> : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Every" htmlFor="repeatInterval" error={errors.repeat}>
              <Select id="repeatInterval" name="repeatInterval" defaultValue="1" error={errors.repeat}>
                <option value="1">week</option>
                <option value="2">2 weeks</option>
                <option value="3">3 weeks</option>
                <option value="4">4 weeks</option>
              </Select>
            </FormField>
            <FormField label="Until" htmlFor="repeatUntil" hint="optional" error={errors.repeatUntil}>
              <Input id="repeatUntil" name="repeatUntil" type="date" error={errors.repeatUntil} />
            </FormField>
          </div>
          <p className="text-xs text-muted -mt-1">The next four weeks are created now; later sessions appear as the weeks come round. Each session has its own list of people going and its own chat.</p>
        </div>
      ) : null}
    </fieldset>
  );
}

/** Which sessions an edit of a series occurrence applies to (edit page only). */
export function ApplyToFields() {
  return (
    <fieldset className="flex flex-col gap-2" data-apply-to="">
      <legend className="text-sm font-medium">This session repeats. Apply these changes to</legend>
      <label className="flex items-center gap-2 text-sm min-h-11">
        <input type="radio" name="applyTo" value="this" defaultChecked className="h-5 w-5 accent-pulse" />
        This session only
      </label>
      <label className="flex items-center gap-2 text-sm min-h-11">
        <input type="radio" name="applyTo" value="future" className="h-5 w-5 accent-pulse" />
        This and future sessions
      </label>
      <p className="text-xs text-muted">Future sessions keep anything you changed on them alone. A new time moves sessions people have joined; sessions nobody has joined are remade.</p>
    </fieldset>
  );
}
