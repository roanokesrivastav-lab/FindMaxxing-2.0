"use client";
import { useState } from "react";
import { FormField, Input, Select } from "@/components/ui/Field";
import { ACTIVITY_KINDS, ACTIVITY_KIND_LABELS, COURT_FORMATS, PICKLEBALL_LEVELS, PICKLEBALL_PLAY, WALK_PACES, type ActivityDetails, type ActivityKind } from "@/lib/activity";

const FORMAT_LABELS: Record<(typeof COURT_FORMATS)[number], string> = { "2v2": "2 v 2", "3v3": "3 v 3", "4v4": "4 v 4", "5v5": "5 v 5", "6v6": "6 v 6", open: "Open play" };
const LEVEL_LABELS: Record<(typeof PICKLEBALL_LEVELS)[number], string> = { beginner: "Beginners", intermediate: "Played a fair bit", advanced: "Experienced", all: "All levels" };
const PLAY_LABELS: Record<(typeof PICKLEBALL_PLAY)[number], string> = { singles: "Singles", doubles: "Doubles", both: "Singles and doubles" };
const PACE_LABELS: Record<(typeof WALK_PACES)[number], string> = { easy: "Easy", moderate: "Moderate", brisk: "Brisk" };

function Check({ name, label, defaultChecked }: { name: string; label: string; defaultChecked?: boolean }) {
  return (
    <label className="flex items-center gap-2 text-sm font-medium min-h-11">
      <input type="checkbox" name={name} defaultChecked={defaultChecked} className="h-5 w-5 accent-pulse" />
      {label}
    </label>
  );
}

/**
 * The small activity section of the event form (roadmap 4.2). Only the fields
 * for the chosen kind are rendered, so only they are submitted. Field names
 * are "activity.<field>" (read by activityFromFields).
 */
export function ActivityFields({ initial, errors }: { initial?: ActivityDetails | null; errors: Record<string, string | undefined> }) {
  const [kind, setKind] = useState<ActivityKind | "">(initial?.kind ?? "");
  // Stored values only prefill the kind they belong to.
  const v = (initial && initial.kind === kind ? initial : {}) as Record<string, string | number | boolean | undefined>;
  const err = (field: string) => errors[`activity.${field}`];
  const text = (field: string) => (v[field] === undefined ? "" : String(v[field]));
  return (
    <fieldset className="flex flex-col gap-3">
      <FormField label="Activity" htmlFor="activity.kind" hint="optional" error={err("kind")}>
        <Select id="activity.kind" name="activity.kind" value={kind} onChange={(e) => setKind(e.target.value as ActivityKind | "")} error={err("kind")}>
          <option value="">Nothing specific</option>
          {ACTIVITY_KINDS.map((k) => <option key={k} value={k}>{ACTIVITY_KIND_LABELS[k]}</option>)}
        </Select>
      </FormField>
      {kind === "run" ? (
        <div key="run" className="flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-3">
            <FormField label="Miles" htmlFor="activity.distanceMiles" error={err("distanceMiles")}>
              <Input id="activity.distanceMiles" name="activity.distanceMiles" type="number" step="0.1" min={0.1} max={100} defaultValue={text("distanceMiles")} error={err("distanceMiles")} />
            </FormField>
            <FormField label="Pace from" htmlFor="activity.paceFrom" hint="per mile" error={err("paceFrom")}>
              <Input id="activity.paceFrom" name="activity.paceFrom" placeholder="9:00" maxLength={5} defaultValue={text("paceFrom")} error={err("paceFrom")} />
            </FormField>
            <FormField label="Pace to" htmlFor="activity.paceTo" hint="per mile" error={err("paceTo")}>
              <Input id="activity.paceTo" name="activity.paceTo" placeholder="10:30" maxLength={5} defaultValue={text("paceTo")} error={err("paceTo")} />
            </FormField>
          </div>
          <Check name="activity.regroup" label="We regroup along the way" defaultChecked={v.regroup === true} />
          <Check name="activity.noDrop" label="No-drop: the group waits, nobody is left behind" defaultChecked={v.noDrop === true} />
        </div>
      ) : null}
      {kind === "volleyball" || kind === "basketball" ? (
        <div key={kind} className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Format" htmlFor="activity.format" error={err("format")}>
              <Select id="activity.format" name="activity.format" defaultValue={text("format")} error={err("format")}>
                <option value="">Not set</option>
                {COURT_FORMATS.map((f) => <option key={f} value={f}>{FORMAT_LABELS[f]}</option>)}
              </Select>
            </FormField>
            <FormField label="Player limit" htmlFor="activity.playerLimit" error={err("playerLimit")}>
              <Input id="activity.playerLimit" name="activity.playerLimit" type="number" min={2} max={60} defaultValue={text("playerLimit")} error={err("playerLimit")} />
            </FormField>
          </div>
          <Check name="activity.beginnersWelcome" label="Beginners welcome" defaultChecked={v.beginnersWelcome === true} />
        </div>
      ) : null}
      {kind === "pickleball" ? (
        <div key="pickleball" className="flex flex-col gap-3">
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Who it suits" htmlFor="activity.level" error={err("level")}>
              <Select id="activity.level" name="activity.level" defaultValue={text("level")} error={err("level")}>
                <option value="">Not set</option>
                {PICKLEBALL_LEVELS.map((l) => <option key={l} value={l}>{LEVEL_LABELS[l]}</option>)}
              </Select>
            </FormField>
            <FormField label="Play" htmlFor="activity.play" error={err("play")}>
              <Select id="activity.play" name="activity.play" defaultValue={text("play")} error={err("play")}>
                <option value="">Not set</option>
                {PICKLEBALL_PLAY.map((p) => <option key={p} value={p}>{PLAY_LABELS[p]}</option>)}
              </Select>
            </FormField>
          </div>
          <Check name="activity.paddlesAvailable" label="Paddles available to borrow" defaultChecked={v.paddlesAvailable === true} />
        </div>
      ) : null}
      {kind === "walk" ? (
        <div key="walk" className="grid grid-cols-2 gap-3">
          <FormField label="Miles" htmlFor="activity.distanceMiles" hint="optional" error={err("distanceMiles")}>
            <Input id="activity.distanceMiles" name="activity.distanceMiles" type="number" step="0.1" min={0.1} max={100} defaultValue={text("distanceMiles")} error={err("distanceMiles")} />
          </FormField>
          <FormField label="Pace" htmlFor="activity.pace" hint="optional" error={err("pace")}>
            <Select id="activity.pace" name="activity.pace" defaultValue={text("pace")} error={err("pace")}>
              <option value="">Not set</option>
              {WALK_PACES.map((p) => <option key={p} value={p}>{PACE_LABELS[p]}</option>)}
            </Select>
          </FormField>
        </div>
      ) : null}
    </fieldset>
  );
}
