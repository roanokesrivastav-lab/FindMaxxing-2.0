"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { CalendarPlus, ListPlus, MapPin } from "lucide-react";
import { INTERESTS } from "@/lib/data/taxonomy";
import { Chip } from "@/components/ui/Chip";
import { Button } from "@/components/ui/Button";
import { FormField, Input, Select } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { savePlanAsListAction } from "@/server/actions/trips";
import type { PlanEvent, TripPlan } from "@/server/trips/planner";

const today = () => new Date().toLocaleDateString("en-CA");

/** Ask for a plan, watch it come together, then save it as a list or turn stops into events. */
export function TripPlanner({ defaultInterests, start }: { defaultInterests: string[]; start: { lat: number; lng: number; label: string } }) {
  const [date, setDate] = useState(today());
  const [from, setFrom] = useState("10:00");
  const [to, setTo] = useState("18:00");
  const [vibe, setVibe] = useState("");
  const [budget, setBudget] = useState("low");
  const [interests, setInterests] = useState<string[]>(defaultInterests.slice(0, 8));
  const [origin, setOrigin] = useState(start);
  const [status, setStatus] = useState<string[]>([]);
  const [plan, setPlan] = useState<TripPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [saving, startSave] = useTransition();
  const { toast } = useToast();

  const useLocation = () =>
    navigator.geolocation?.getCurrentPosition((p) => setOrigin({ lat: p.coords.latitude, lng: p.coords.longitude, label: "Where you are" }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setRunning(true);
    setPlan(null);
    setError(null);
    setStatus([]);
    try {
      const startIso = new Date(`${date}T${from}`).toISOString();
      const endIso = new Date(`${date}T${to}`).toISOString();
      const res = await fetch("/api/trip-plan", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ start: startIso, end: endIso, vibe, interests, budget, startPoint: origin }),
      });
      if (!res.ok || !res.body) {
        setError(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? "Planning isn't available right now.");
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line) as PlanEvent;
          if (event.type === "status") setStatus((s) => [...s, event.text]);
          else if (event.type === "plan") setPlan(event.plan);
          else setError(event.message);
        }
      }
    } catch {
      setError("Planning failed. Try again in a moment.");
    } finally {
      setRunning(false);
    }
  };

  const saveAsList = () =>
    startSave(async () => {
      if (!plan) return;
      const placeIds = plan.stops.filter((s) => s.kind === "place").map((s) => s.id);
      if (!placeIds.length) return toast("This plan has no places to save", "error");
      const res = await savePlanAsListAction({ title: plan.title.slice(0, 54), placeIds });
      if (!res.ok) return toast(res.error, "error");
      toast(`Saved ${res.data.added} place${res.data.added === 1 ? "" : "s"} to “${res.data.list.name}”`, "success");
    });

  return (
    <div className="flex flex-col gap-6">
      <form onSubmit={submit} className="card p-5 flex flex-col gap-4">
        <div className="grid grid-cols-3 gap-2">
          <FormField label="Day" htmlFor="plan-date"><Input id="plan-date" type="date" value={date} min={today()} onChange={(e) => setDate(e.target.value)} required /></FormField>
          <FormField label="From" htmlFor="plan-from"><Input id="plan-from" type="time" value={from} onChange={(e) => setFrom(e.target.value)} required /></FormField>
          <FormField label="Until" htmlFor="plan-to"><Input id="plan-to" type="time" value={to} onChange={(e) => setTo(e.target.value)} required /></FormField>
        </div>
        <FormField label="What kind of day?" htmlFor="plan-vibe" hint="optional">
          <Input id="plan-vibe" value={vibe} onChange={(e) => setVibe(e.target.value)} maxLength={300} placeholder="Slow morning, outdoors, good coffee, something social at night" />
        </FormField>
        <div role="group" aria-label="Interests" className="flex flex-wrap gap-2">
          {INTERESTS.map((i) => (
            <Chip key={i.slug} active={interests.includes(i.slug)} onClick={() => setInterests((s) => (s.includes(i.slug) ? s.filter((x) => x !== i.slug) : s.length >= 8 ? s : [...s, i.slug]))}>
              <span aria-hidden>{i.emoji}</span> {i.label}
            </Chip>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2 items-end">
          <FormField label="Budget" htmlFor="plan-budget">
            <Select id="plan-budget" value={budget} onChange={(e) => setBudget(e.target.value)}>
              <option value="free">Free</option><option value="low">$</option><option value="medium">$$</option><option value="high">$$$</option>
            </Select>
          </FormField>
          <Button type="button" variant="secondary" onClick={useLocation}><MapPin size={16} /> {origin.label}</Button>
        </div>
        <Button type="submit" variant="ink" size="lg" loading={running}>Plan my day</Button>
      </form>

      {running || status.length ? (
        <ol className="text-sm text-muted list-none p-0 m-0 flex flex-col gap-1" aria-live="polite">
          {status.map((s, i) => <li key={i}>{s}…</li>)}
        </ol>
      ) : null}
      {error ? <p className="text-sm text-danger font-medium" role="alert">{error}</p> : null}

      {plan ? (
        <section className="card p-5" aria-labelledby="plan-title">
          <h2 id="plan-title" className="text-xl font-bold">{plan.title}</h2>
          {plan.summary ? <p className="text-sm text-ink-2 mt-1">{plan.summary}</p> : null}
          <ol className="mt-4 flex flex-col gap-3 list-none p-0 m-0">
            {plan.stops.map((s) => (
              <li key={s.id} className="rounded-xl bg-surface-2 p-3">
                {s.travelMinutes ? <p className="text-xs text-muted mb-1">{s.travelMinutes} min to get there</p> : null}
                <p className="text-xs font-bold text-muted">{s.arrive}–{s.leave}</p>
                <Link href={`/${s.kind === "place" ? "places" : "events"}/${s.id}`} className="font-bold hover:underline">{s.name}</Link>
                <p className="text-sm text-ink-2 mt-0.5">{s.why}</p>
                {s.kind === "place" ? (
                  <Link href={`/events/new?placeId=${s.id}`} className="text-xs font-semibold inline-flex items-center gap-1 mt-1.5 hover:underline"><CalendarPlus size={13} /> Make it an event</Link>
                ) : null}
              </li>
            ))}
          </ol>
          {plan.dropped ? <p className="text-xs text-muted mt-3">{plan.dropped} suggested stop{plan.dropped === 1 ? "" : "s"} didn&apos;t check out and {plan.dropped === 1 ? "was" : "were"} left out.</p> : null}
          <Button type="button" variant="secondary" className="mt-4" onClick={saveAsList} loading={saving}><ListPlus size={16} /> Save as a list</Button>
        </section>
      ) : null}
    </div>
  );
}
