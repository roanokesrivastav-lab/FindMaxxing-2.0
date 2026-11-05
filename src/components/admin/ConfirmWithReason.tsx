"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { FormField, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { adminAction, type AdminActionInput } from "@/server/actions/admin";

/** An admin write: a button, then a sheet that says what happens and asks for the reason that goes in the audit trail. */
export function ConfirmWithReason({
  label,
  title,
  body,
  confirm,
  done,
  danger = false,
  input,
}: {
  label: string;
  title: string;
  body: string;
  confirm: string;
  done: string;
  danger?: boolean;
  input: AdminActionInput extends infer A ? (A extends unknown ? Omit<A, "reason"> : never) : never;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();
  const submit = () =>
    start(async () => {
      const res = await adminAction({ ...input, reason } as AdminActionInput);
      if (!res.ok) return setError(res.fieldErrors?.reason ?? res.error);
      toast(done, "success");
      setOpen(false);
      setReason("");
      router.refresh();
    });
  return (
    <>
      <Button type="button" size="sm" variant={danger ? "danger" : "secondary"} onClick={() => setOpen(true)}>{label}</Button>
      <Sheet open={open} onClose={() => !pending && setOpen(false)} title={title}>
        <div className="flex flex-col gap-4 pt-2">
          <p className="text-sm leading-relaxed text-ink-2">{body}</p>
          <FormField label="Reason" htmlFor="admin-reason" hint="required · kept in the audit trail" error={error ?? undefined}>
            <Textarea id="admin-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} required />
          </FormField>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setOpen(false)}>Back</Button>
            <Button type="button" variant={danger ? "danger" : "ink"} className="flex-1" loading={pending} onClick={submit}>{confirm}</Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
