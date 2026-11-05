"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { FormField, Input, Select, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { addTipAction, confirmTipAction, suggestTipCorrectionAction } from "@/server/actions/tips";
import { TIP_KINDS, TIP_KIND_LABEL, TIP_MAX, type TipKind } from "@/lib/places/tips";

/** "Still true?" and "Suggest a correction" for one tip (2.6). The author cannot confirm their own. */
export function TipActions({ placeId, tipId, signedIn, isAuthor }: { placeId: string; tipId: string; signedIn: boolean; isAuthor: boolean }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const fieldId = useId();
  if (!signedIn) return null;

  const confirm = () =>
    start(async () => {
      const res = await confirmTipAction(placeId, tipId);
      if (!res.ok) return toast(res.error, "error");
      toast("Thanks: marked as still true", "success");
      router.refresh();
    });
  const correct = () =>
    start(async () => {
      const res = await suggestTipCorrectionAction(placeId, tipId, text);
      if (!res.ok) return toast(res.error, "error");
      setText("");
      setOpen(false);
      toast("Correction suggested", "success");
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-item">
      <div className="flex flex-wrap items-center gap-item">
        {isAuthor ? (
          <span className="type-body text-ink-2">You wrote this tip, so others confirm it.</span>
        ) : (
          <Button type="button" size="sm" variant="secondary" onClick={confirm} loading={pending}>
            Still true?
          </Button>
        )}
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls={fieldId}>
          Suggest a correction
        </Button>
      </div>
      {open ? (
        <div id={fieldId} className="flex flex-col gap-item">
          <FormField label="What's changed?" htmlFor={`${fieldId}-text`}>
            <Textarea id={`${fieldId}-text`} rows={2} maxLength={TIP_MAX} value={text} onChange={(e) => setText(e.target.value)} />
          </FormField>
          <div>
            <Button type="button" size="sm" variant="ink" onClick={correct} loading={pending} disabled={!text.trim()}>
              Send correction
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Add a local tip with its kind; a temporary condition needs an end date. */
export function AddTipForm({ placeId, signedIn }: { placeId: string; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [kind, setKind] = useState<TipKind>("practical");
  const [ends, setEnds] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  if (!signedIn) return null;

  const submit = () =>
    start(async () => {
      const expiresAt = kind === "temporary" && ends ? new Date(`${ends}T23:59:00`).toISOString() : null;
      const res = await addTipAction({ placeId, body, kind, expiresAt });
      if (!res.ok) return toast(res.error, "error");
      setBody("");
      setEnds("");
      setOpen(false);
      toast("Tip added", "success");
      router.refresh();
    });

  if (!open) {
    return (
      <div className="mt-item">
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Add a tip
        </Button>
      </div>
    );
  }
  return (
    <div className="mt-item flex flex-col gap-item" data-add-tip="">
      <FormField label="Your tip" htmlFor={`${id}-body`} hint={`${body.length}/${TIP_MAX}`}>
        <Textarea id={`${id}-body`} rows={3} maxLength={TIP_MAX} value={body} onChange={(e) => setBody(e.target.value)} />
      </FormField>
      <FormField label="Kind" htmlFor={`${id}-kind`}>
        <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as TipKind)}>
          {TIP_KINDS.map((k) => (
            <option key={k} value={k}>
              {TIP_KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </FormField>
      {kind === "temporary" ? (
        <FormField label="Ends on" htmlFor={`${id}-ends`} hint="Temporary conditions disappear after this date">
          <Input id={`${id}-ends`} type="date" value={ends} onChange={(e) => setEnds(e.target.value)} />
        </FormField>
      ) : null}
      <div className="flex gap-item">
        <Button type="button" size="sm" variant="ink" onClick={submit} loading={pending} disabled={!body.trim() || (kind === "temporary" && !ends)}>
          Add tip
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
