"use client";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { NOTIFICATION_TYPES } from "@/lib/notifications";
import type { NotificationSettings, NotificationType } from "@/lib/data/types";
import { saveNotificationSettingsAction } from "@/server/actions/notifications";

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => new Date(2000, 0, 1, h).toLocaleTimeString("en-US", { hour: "numeric" });

/** Per-type choices (notify at all, and also push) and quiet hours. */
export function NotificationSettingsForm({ initial, pushAvailable }: { initial: NotificationSettings; pushAvailable: boolean }) {
  const [muted, setMuted] = useState(new Set(initial.mutedTypes));
  const [push, setPush] = useState(new Set(initial.pushTypes));
  const [quietStart, setQuietStart] = useState(initial.quietStart);
  const [quietEnd, setQuietEnd] = useState(initial.quietEnd);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const toggle = (set: Set<NotificationType>, update: (s: Set<NotificationType>) => void, type: NotificationType, on: boolean) => {
    const next = new Set(set);
    if (on) next.add(type);
    else next.delete(type);
    update(next);
  };
  const save = () =>
    start(async () => {
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || initial.timeZone;
      const res = await saveNotificationSettingsAction({ mutedTypes: [...muted], pushTypes: [...push], quietStart, quietEnd, timeZone });
      toast(res.ok ? "Notification settings saved" : res.error, res.ok ? "success" : "error");
    });

  return (
    <div className="flex flex-col gap-4">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-muted">
            <th scope="col" className="font-semibold py-1">Tell me when</th>
            <th scope="col" className="font-semibold py-1 w-16 text-center">In app</th>
            {pushAvailable ? <th scope="col" className="font-semibold py-1 w-16 text-center">Push</th> : null}
          </tr>
        </thead>
        <tbody>
          {NOTIFICATION_TYPES.map(({ type, label }) => {
            const on = !muted.has(type);
            return (
              <tr key={type} className="border-t border-line">
                <th scope="row" className="font-medium py-2 pr-2 text-left">{label}</th>
                <td className="text-center">
                  <input type="checkbox" className="h-4 w-4 accent-ink" aria-label={`${label}: in app`} checked={on} onChange={(e) => toggle(muted, setMuted, type, !e.target.checked)} />
                </td>
                {pushAvailable ? (
                  <td className="text-center">
                    <input type="checkbox" className="h-4 w-4 accent-ink" aria-label={`${label}: push`} checked={on && push.has(type)} disabled={!on} onChange={(e) => toggle(push, setPush, type, e.target.checked)} />
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
      {pushAvailable ? (
        <fieldset className="flex flex-wrap items-center gap-2 text-sm">
          <legend className="font-semibold mb-1.5">Quiet hours</legend>
          <label htmlFor="quiet-start" className="sr-only">Quiet from</label>
          <select id="quiet-start" className="h-9 rounded-xl border border-line bg-surface px-2" value={quietStart ?? ""} onChange={(e) => {
            const v = e.target.value === "" ? null : Number(e.target.value);
            setQuietStart(v);
            setQuietEnd(v === null ? null : (quietEnd ?? 8));
          }}>
            <option value="">Off</option>
            {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
          </select>
          {quietStart !== null ? (
            <>
              <span>to</span>
              <label htmlFor="quiet-end" className="sr-only">Quiet until</label>
              <select id="quiet-end" className="h-9 rounded-xl border border-line bg-surface px-2" value={quietEnd ?? 8} onChange={(e) => setQuietEnd(Number(e.target.value))}>
                {HOURS.map((h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
              </select>
            </>
          ) : null}
          <p className="basis-full text-xs text-muted">Pushes wait until quiet hours end. You get at most a few pushes a day; the rest stay here in the app.</p>
        </fieldset>
      ) : null}
      <Button type="button" variant="ink" onClick={save} loading={pending} className="self-start">
        Save notification settings
      </Button>
    </div>
  );
}
