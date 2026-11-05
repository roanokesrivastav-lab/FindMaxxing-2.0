"use client";
import { useState, useTransition } from "react";
import { ALERT_RADII_KM, toCell, type NeedPlayerAlerts } from "@findmaxxing/shared/events";
import { saveNeedPlayerAlertsAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { FormField, Select } from "@/components/ui/Field";

/**
 * R2: opt in to need-players alerts. The area is stored as a coarse cell (rounded to about 1 km) plus
 * a distance; it is never shown to anyone else. Off by default.
 */
export function NeedPlayersForm({ initial, categories, defaultCenter }: { initial: NeedPlayerAlerts | null; categories: { slug: string; label: string }[]; defaultCenter: { lat: number; lng: number } }) {
  const [enabled, setEnabled] = useState(initial?.enabled ?? false);
  const [picked, setPicked] = useState<string[]>(initial?.categories ?? []);
  const [cell, setCell] = useState({ lat: initial?.cellLat ?? toCell(defaultCenter.lat), lng: initial?.cellLng ?? toCell(defaultCenter.lng) });
  const [radius, setRadius] = useState<number>(initial?.radiusKm ?? 3);
  const [where, setWhere] = useState(initial ? "Your saved area" : "The city centre");
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const locate = () => {
    if (!navigator.geolocation) return setErrors({ area: "Location isn't available in this browser" });
    navigator.geolocation.getCurrentPosition(
      (p) => { setCell({ lat: toCell(p.coords.latitude), lng: toCell(p.coords.longitude) }); setWhere("Near you (rounded to about 1 km)"); setErrors({}); },
      () => setErrors({ area: "We couldn't get your location. The city centre is used instead." }),
      { maximumAge: 600_000, timeout: 10_000 },
    );
  };
  return (
    <form
      className="flex flex-col gap-row"
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          const res = await saveNeedPlayerAlertsAction({ enabled, categories: picked, cellLat: cell.lat, cellLng: cell.lng, radiusKm: radius });
          if (!res.ok) { setErrors({ categories: res.fieldErrors?.categories, area: res.fieldErrors ? undefined : res.error }); toast(res.error, "error"); }
          else { setErrors({}); toast(enabled ? "Alerts on" : "Alerts off", "success"); }
        });
      }}
    >
      <label className="type-body text-ink flex items-center gap-item font-semibold">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-5 w-5 accent-ink" />
        Tell me when a session near me still needs players
      </label>
      <fieldset className="flex flex-col gap-item" disabled={!enabled}>
        <legend className="type-item-title text-ink">Activities</legend>
        <div className="flex flex-wrap gap-x-row gap-y-item">
          {categories.map((c) => (
            <label key={c.slug} className="type-body text-ink inline-flex items-center gap-hair">
              <input type="checkbox" className="h-5 w-5 accent-ink" checked={picked.includes(c.slug)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.slug] : p.filter((x) => x !== c.slug)))} />
              {c.label}
            </label>
          ))}
        </div>
        {errors.categories ? <p role="alert" className="type-body text-danger">{errors.categories}</p> : null}
      </fieldset>
      <fieldset className="flex flex-col gap-item" disabled={!enabled}>
        <legend className="type-item-title text-ink">Area</legend>
        <p className="type-body text-ink-2">{where}. We keep only a rough area, never your exact location, and nobody else sees it.</p>
        <div><Button type="button" variant="secondary" size="sm" onClick={locate}>Use my location</Button></div>
        {errors.area ? <p role="alert" className="type-body text-danger">{errors.area}</p> : null}
        <FormField label="Within" htmlFor="alertRadius">
          <Select id="alertRadius" value={String(radius)} onChange={(e) => setRadius(Number(e.target.value))}>
            {ALERT_RADII_KM.map((r) => <option key={r} value={r}>{r} km</option>)}
          </Select>
        </FormField>
      </fieldset>
      <p className="type-body text-muted">At most one alert per session and three a day. Quiet hours and your notification settings apply. An alert never signs you up.</p>
      <div><Button type="submit" variant="ink" loading={pending}>Save</Button></div>
    </form>
  );
}
