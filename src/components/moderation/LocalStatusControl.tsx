"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { FormField, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { setLocalStatusAction } from "@/server/actions/moderation";

/** Revoke or restore someone's local status, with a reason kept in the history. */
export function LocalStatusControl({ userId, revoked }: { userId: string; revoked: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const submit = () =>
    start(async () => {
      const res = await setLocalStatusAction({ userId, revoked: !revoked, reason });
      if (!res.ok) {
        setError(res.fieldErrors?.reason ?? res.error);
        return;
      }
      toast(revoked ? "Local status restored" : "Local status revoked", "success");
      setOpen(false);
      setReason("");
      router.refresh();
    });

  return (
    <div className="card p-4">
      <p className="text-sm">
        {revoked ? "This person's local status is revoked: locals-only places are hidden from them, whatever their home city." : "This person counts as a local wherever the usual rules say so."}
      </p>
      <Button type="button" size="sm" variant={revoked ? "secondary" : "danger"} className="mt-3" onClick={() => setOpen(true)}>
        {revoked ? "Restore local status" : "Revoke local status"}
      </Button>
      <Sheet open={open} onClose={() => !pending && setOpen(false)} title={revoked ? "Restore local status?" : "Revoke local status?"}>
        <div className="flex flex-col gap-4 pt-2">
          <p className="text-sm leading-relaxed text-ink-2">
            {revoked
              ? "They count as a local again where their home city or contributions say so. Their places, saves and lists are untouched either way."
              : "They stop seeing locals-only places and events everywhere, including ones they saved. Their own places, saves and lists stay; nothing is deleted."}
          </p>
          <FormField label="Reason" htmlFor="local-reason" hint="required · kept in the history" error={error ?? undefined}>
            <Textarea id="local-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} required />
          </FormField>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setOpen(false)}>Back</Button>
            <Button type="button" variant={revoked ? "ink" : "danger"} className="flex-1" loading={pending} onClick={submit}>
              {revoked ? "Restore" : "Revoke"}
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
