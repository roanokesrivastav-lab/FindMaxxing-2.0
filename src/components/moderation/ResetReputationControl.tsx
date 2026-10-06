"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { FormField, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { resetReputationAction } from "@/server/actions/moderation";

/** Moderators: wipe a gamed reputation back to the start, with a reason kept in the history. */
export function ResetReputationControl({ userId, level }: { userId: string; level: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const submit = () =>
    start(async () => {
      const res = await resetReputationAction({ userId, reason });
      if (!res.ok) return setError(res.fieldErrors?.reason ?? res.error);
      toast("Reputation reset", "success");
      setOpen(false);
      setReason("");
      router.refresh();
    });
  return (
    <div className="card p-4">
      <p className="text-sm">Current level: <b>{level}</b>.</p>
      <Button type="button" size="sm" variant="secondary" className="mt-3" onClick={() => setOpen(true)}>Reset reputation</Button>
      <Sheet open={open} onClose={() => !pending && setOpen(false)} title="Reset this person's reputation?">
        <div className="flex flex-col gap-4 pt-2">
          <p className="text-sm leading-relaxed text-ink-2">Everything they earned so far stops counting and their level goes back to New; they can earn it again from now on. Their places, events and saves are untouched.</p>
          <FormField label="Reason" htmlFor="rep-reason" hint="required · kept in the history" error={error ?? undefined}>
            <Textarea id="rep-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} required />
          </FormField>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setOpen(false)}>Back</Button>
            <Button type="button" variant="danger" className="flex-1" loading={pending} onClick={submit}>Reset</Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
