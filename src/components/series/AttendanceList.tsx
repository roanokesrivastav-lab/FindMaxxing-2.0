"use client";
import { useState, useTransition } from "react";
import { setAttendedAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";

/** 4.5b: after a session, a host ticks who actually came. Never inferred from RSVPs. */
export function AttendanceList({ eventId, people }: { eventId: string; people: { userId: string; displayName: string; attended: boolean | null }[] }) {
  const [state, setState] = useState(() => Object.fromEntries(people.map((p) => [p.userId, p.attended])));
  const [pending, start] = useTransition();
  const { toast } = useToast();
  return (
    <fieldset className="mt-item flex flex-col gap-hair">
      <legend className="type-body font-semibold text-ink">Who came?</legend>
      {people.map((p) => (
        <label key={p.userId} className="type-body text-ink flex items-center gap-item">
          <input
            type="checkbox"
            className="h-5 w-5 accent-ink"
            checked={state[p.userId] === true}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.checked;
              start(async () => {
                const res = await setAttendedAction(eventId, p.userId, next);
                if (!res.ok) toast(res.error, "error"); else setState((s) => ({ ...s, [p.userId]: next }));
              });
            }}
          />
          {p.displayName}
        </label>
      ))}
    </fieldset>
  );
}
