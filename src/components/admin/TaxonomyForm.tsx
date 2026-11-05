"use client";

import { useActionState } from "react";
import { useFormSubmit } from "@/lib/forms/useFormSubmit";
import { upsertTaxonomyAction } from "@/server/actions/admin";
import { Button } from "@/components/ui/Button";
import { FormField, Input } from "@/components/ui/Field";
import type { TaxonomyEntry } from "@/lib/data/types";

/** Add a category or interest, or edit one (slugs never change once created). */
export function TaxonomyForm({ entry, kind }: { entry?: TaxonomyEntry; kind: TaxonomyEntry["kind"] }) {
  const [state, action, pending] = useActionState(upsertTaxonomyAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const { formRef, onSubmit } = useFormSubmit(action, state);
  const id = (f: string) => `${kind}-${entry?.slug ?? "new"}-${f}`;
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-3">
      <input type="hidden" name="kind" value={kind} />
      {entry ? <input type="hidden" name="slug" value={entry.slug} /> : (
        <FormField label="Slug" htmlFor={id("slug")} hint="permanent" error={errors.slug}>
          <Input id={id("slug")} name="slug" required maxLength={40} placeholder="e.g. disc-golf" error={errors.slug} />
        </FormField>
      )}
      <div className="grid grid-cols-[1fr_5rem_5rem] gap-2">
        <FormField label="Label" htmlFor={id("label")} error={errors.label}><Input id={id("label")} name="label" defaultValue={entry?.label} required maxLength={40} error={errors.label} /></FormField>
        <FormField label="Emoji" htmlFor={id("emoji")}><Input id={id("emoji")} name="emoji" defaultValue={entry?.emoji} required maxLength={8} /></FormField>
        <FormField label="Order" htmlFor={id("order")}><Input id={id("order")} name="sortOrder" type="number" min={0} max={999} defaultValue={entry?.sortOrder ?? 0} /></FormField>
      </div>
      {kind === "category" ? (
        <div className="grid grid-cols-2 gap-2">
          <FormField label="Colour" htmlFor={id("color")}><Input id={id("color")} name="color" defaultValue={entry?.color ?? "#62636b"} pattern="#[0-9a-fA-F]{6}" required /></FormField>
          <FormField label="Used for" htmlFor={id("scope")}>
            <select id={id("scope")} name="scope" defaultValue={entry?.scope ?? "both"} className="field">
              <option value="both">Places and events</option><option value="place">Places</option><option value="event">Events</option>
            </select>
          </FormField>
        </div>
      ) : null}
      <FormField label="Reason" htmlFor={id("reason")} hint="kept in the audit trail" error={errors.reason}><Input id={id("reason")} name="reason" required maxLength={500} error={errors.reason} /></FormField>
      {state && !state.ok && !Object.keys(errors).length ? <p className="text-sm text-danger" role="alert">{state.error}</p> : null}
      {state?.ok ? <p className="text-sm text-moss" role="status">Saved.</p> : null}
      <Button type="submit" size="sm" variant="ink" loading={pending}>{entry ? "Save" : "Add"}</Button>
    </form>
  );
}
