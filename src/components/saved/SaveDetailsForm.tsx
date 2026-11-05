"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Lock, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { FormField, Input, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { updateSaveDetailsAction } from "@/server/actions/saves";
import { SAVE_NOTE_MAX, SAVE_RECOMMENDED_MAX, SAVE_STATUSES, SAVE_STATUS_LABEL, normalizeTag, type SaveDetails, type SaveStatus } from "@/lib/places/saves";

/** The "Only you" marker next to every private field (3.1). Text plus a shape, never colour alone. */
export function OnlyYou() {
  return (
    <span className="type-body text-ink-2 inline-flex items-center gap-hair font-normal" data-only-you="">
      <Lock size="0.9em" aria-hidden /> Only you
    </span>
  );
}

/**
 * Why you saved it (3.1): status, private note, personal tags (with suggestions you
 * can take or dismiss), who recommended it, and where you found it. Shown only to the
 * owner, only after the one-tap save; nothing here is ever required.
 */
export function SaveDetailsForm({ details, suggestions }: { details: SaveDetails; suggestions: string[] }) {
  const [status, setStatus] = useState<SaveStatus>(details.status);
  const [note, setNote] = useState(details.note ?? "");
  const [tags, setTags] = useState<string[]>(details.tags);
  const [tagDraft, setTagDraft] = useState("");
  const [recommendedBy, setRecommendedBy] = useState(details.recommendedBy ?? "");
  const [sourceUrl, setSourceUrl] = useState(details.sourceUrl ?? "");
  const [dismissed, setDismissed] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  const offered = dismissed ? [] : suggestions.filter((s) => !tags.includes(s));

  const addTag = (raw: string) => {
    const t = normalizeTag(raw);
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setTagDraft("");
  };
  const save = () =>
    start(async () => {
      const res = await updateSaveDetailsAction(details.placeId, { status, note, tags, recommendedBy, sourceUrl });
      if (!res.ok) return toast(res.error, "error");
      toast("Saved for you", "success");
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-row" data-save-details="">
      <fieldset className="flex flex-col gap-item">
        <legend className="type-body font-semibold text-ink flex flex-wrap items-center gap-item">
          Status <OnlyYou />
        </legend>
        <div className="flex flex-wrap gap-item">
          {SAVE_STATUSES.map((s) => (
            <label key={s} className="chip h-9 cursor-pointer has-[:checked]:bg-ink has-[:checked]:text-white">
              <input type="radio" name={`${id}-status`} value={s} checked={status === s} onChange={() => setStatus(s)} className="sr-only" />
              {SAVE_STATUS_LABEL[s]}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-item">
        <label htmlFor={`${id}-tag`} className="type-body font-semibold text-ink flex flex-wrap items-center gap-item">
          Your tags <OnlyYou />
        </label>
        {tags.length ? (
          <ul className="list-none m-0 p-0 flex flex-wrap gap-item">
            {tags.map((t) => (
              <li key={t} className="chip h-8 text-xs">
                {t}
                <button type="button" aria-label={`Remove tag ${t}`} onClick={() => setTags(tags.filter((x) => x !== t))} className="inline-flex">
                  <X size={14} aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex gap-item">
          <Input id={`${id}-tag`} value={tagDraft} maxLength={24} placeholder="Add a tag" onChange={(e) => setTagDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addTag(tagDraft); } }} />
          <Button type="button" size="sm" variant="secondary" onClick={() => addTag(tagDraft)} disabled={!tagDraft.trim()}>
            Add
          </Button>
        </div>
        {offered.length ? (
          <div className="flex flex-wrap items-center gap-item" data-tag-suggestions="">
            <span className="type-body text-ink-2">Suggested:</span>
            {offered.map((s) => (
              <button key={s} type="button" className="chip h-8 text-xs" onClick={() => addTag(s)}>
                + {s}
              </button>
            ))}
            <button type="button" className="type-body text-ink-2 underline underline-offset-4" onClick={() => setDismissed(true)}>
              Not now
            </button>
          </div>
        ) : null}
      </div>

      <FormField label="Private note" htmlFor={`${id}-note`} hint="Only you">
        <Textarea id={`${id}-note`} rows={3} maxLength={SAVE_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why you saved it" />
      </FormField>
      <FormField label="Recommended by" htmlFor={`${id}-rec`} hint="Only you">
        <Input id={`${id}-rec`} maxLength={SAVE_RECOMMENDED_MAX} value={recommendedBy} onChange={(e) => setRecommendedBy(e.target.value)} placeholder="Who told you about it" />
      </FormField>
      <FormField label="Where you found it" htmlFor={`${id}-src`} hint="Only you">
        <Input id={`${id}-src`} type="url" maxLength={500} value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://" />
      </FormField>
      <div>
        <Button type="button" variant="ink" size="sm" onClick={save} loading={pending}>
          Save details
        </Button>
      </div>
    </div>
  );
}
