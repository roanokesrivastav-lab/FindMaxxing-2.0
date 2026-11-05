"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { FormField, Input, Select } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { addOccasionNoteAction, removeOccasionNoteAction } from "@/server/actions/tips";
import { OCCASIONS, OCCASION_LABEL, OCCASION_NOTE_MAX, type Occasion, type Polarity } from "@/lib/places/occasions";

export function AddOccasionForm({ placeId, signedIn }: { placeId: string; signedIn: boolean }) {
  const [open, setOpen] = useState(false);
  const [polarity, setPolarity] = useState<Polarity>("best");
  const [occasion, setOccasion] = useState<Occasion>(OCCASIONS[0]);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();
  if (!signedIn) return null;
  if (!open) {
    return (
      <div className="mt-item">
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
          Add best for / less suited
        </Button>
      </div>
    );
  }
  const submit = () =>
    start(async () => {
      const res = await addOccasionNoteAction({ placeId, polarity, occasion, note });
      if (!res.ok) return toast(res.error, "error");
      setNote("");
      setOpen(false);
      toast("Note added", "success");
      router.refresh();
    });
  return (
    <div className="mt-item flex flex-col gap-item" data-add-occasion="">
      <FormField label="This place is" htmlFor={`${id}-pol`}>
        <Select id={`${id}-pol`} value={polarity} onChange={(e) => setPolarity(e.target.value as Polarity)}>
          <option value="best">Good for</option>
          <option value="less">Less suited for</option>
        </Select>
      </FormField>
      <FormField label="Occasion" htmlFor={`${id}-occ`}>
        <Select id={`${id}-occ`} value={occasion} onChange={(e) => setOccasion(e.target.value as Occasion)}>
          {OCCASIONS.map((o) => (
            <option key={o} value={o}>
              {OCCASION_LABEL[o]}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Why (optional)" htmlFor={`${id}-note`} hint={`${note.length}/${OCCASION_NOTE_MAX}`}>
        <Input id={`${id}-note`} maxLength={OCCASION_NOTE_MAX} value={note} onChange={(e) => setNote(e.target.value)} />
      </FormField>
      <div className="flex gap-item">
        <Button type="button" size="sm" variant="ink" onClick={submit} loading={pending}>
          Add note
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function RemoveOccasionButton({ placeId, noteId }: { placeId: string; noteId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <button
      type="button"
      disabled={pending}
      className="ml-item font-semibold underline-offset-4 hover:underline"
      onClick={() =>
        start(async () => {
          const res = await removeOccasionNoteAction(placeId, noteId);
          if (!res.ok) return toast(res.error, "error");
          toast("Note removed", "success");
          router.refresh();
        })
      }
    >
      Remove
    </button>
  );
}
