"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { createCampaignAction } from "@/server/actions/ads";

export interface PromotableListing {
  kind: "place" | "event";
  id: string;
  label: string;
}

const today = () => new Date().toISOString().slice(0, 10);

/** Self-serve: promote one of your own public listings. Targeting is the listing's area and category, never people. */
export function CampaignForm({ listings }: { listings: PromotableListing[] }) {
  const [target, setTarget] = useState(listings[0] ? `${listings[0].kind}:${listings[0].id}` : "");
  const [headline, setHeadline] = useState("");
  const [body, setBody] = useState("");
  const [area, setArea] = useState<"near" | "anywhere">("near");
  const [matchCategory, setMatchCategory] = useState(true);
  const [startsOn, setStartsOn] = useState(today());
  const [days, setDays] = useState(14);
  const [budget, setBudget] = useState(50);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  if (!listings.length) return <p className="text-sm text-muted">Add a public place or an upcoming event first; you can promote only your own listings.</p>;
  const submit = () =>
    start(async () => {
      const [kind, targetId] = target.split(":") as ["place" | "event", string];
      const res = await createCampaignAction({ kind, targetId, headline, body, area, matchCategory, startsOn, days, budgetDollars: budget });
      if (!res.ok) return toast(res.error, "error");
      toast("Sent for review", "success");
      setHeadline("");
      setBody("");
      router.refresh();
    });
  const field = "h-10 rounded-xl border border-line bg-surface px-3 w-full";
  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <label className="text-sm font-semibold flex flex-col gap-1">Listing
        <select id="ad-target" className={field} value={target} onChange={(e) => setTarget(e.target.value)}>
          {listings.map((l) => <option key={`${l.kind}:${l.id}`} value={`${l.kind}:${l.id}`}>{l.kind === "place" ? "Place" : "Event"}: {l.label}</option>)}
        </select>
      </label>
      <label className="text-sm font-semibold flex flex-col gap-1">Headline
        <input id="ad-headline" className={field} value={headline} onChange={(e) => setHeadline(e.target.value)} maxLength={60} required />
      </label>
      <label className="text-sm font-semibold flex flex-col gap-1">Text <span className="font-normal text-muted">optional</span>
        <input id="ad-body" className={field} value={body} onChange={(e) => setBody(e.target.value)} maxLength={140} />
      </label>
      <fieldset className="text-sm">
        <legend className="font-semibold mb-1">Where it shows</legend>
        <label className="flex items-center gap-2"><input type="radio" name="area" checked={area === "near"} onChange={() => setArea("near")} /> When people look at the map near the listing (about 5 km)</label>
        <label className="flex items-center gap-2"><input type="radio" name="area" checked={area === "anywhere"} onChange={() => setArea("anywhere")} /> Anywhere</label>
        <label className="flex items-center gap-2 mt-1"><input type="checkbox" checked={matchCategory} onChange={(e) => setMatchCategory(e.target.checked)} /> Only when people browse its category</label>
      </fieldset>
      <div className="grid grid-cols-3 gap-2">
        <label className="text-sm font-semibold flex flex-col gap-1">Starts
          <input id="ad-start" type="date" className={field} value={startsOn} min={today()} onChange={(e) => setStartsOn(e.target.value)} />
        </label>
        <label className="text-sm font-semibold flex flex-col gap-1">Days
          <input id="ad-days" type="number" className={field} value={days} min={1} max={60} onChange={(e) => setDays(Number(e.target.value))} />
        </label>
        <label className="text-sm font-semibold flex flex-col gap-1">Budget ($)
          <input id="ad-budget" type="number" className={field} value={budget} min={20} max={1000} onChange={(e) => setBudget(Number(e.target.value))} />
        </label>
      </div>
      <p className="text-xs text-muted">${budget} buys about {(budget * 200).toLocaleString("en-US")} views ($5 per 1,000), spread evenly over {days} day{days === 1 ? "" : "s"}. An admin reviews it first; you pay once it is approved. No one is tracked: cards are chosen only by map area, category and date.</p>
      <Button type="submit" variant="ink" loading={pending} className="self-start">Send for review</Button>
    </form>
  );
}
