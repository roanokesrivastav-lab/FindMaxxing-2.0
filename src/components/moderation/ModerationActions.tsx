"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { FormField, Textarea } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { resolveReportsAction } from "@/server/actions/moderation";
import type { ModerationAction, ReportTargetType } from "@/lib/data/types";

const COPY: Record<ModerationAction, { button: string; title: string; body: (n: number) => string; confirm: string; done: string; reasonRequired: boolean }> = {
  dismiss: {
    button: "Dismiss reports",
    title: "Dismiss these reports?",
    body: (n) => `All ${n} open report${n === 1 ? "" : "s"} close as dismissed. The content stays exactly as it is. Reporters see that their report was resolved, not by whom.`,
    confirm: "Dismiss",
    done: "Reports dismissed",
    reasonRequired: false,
  },
  review: {
    button: "Mark reviewed",
    title: "Mark reviewed with no action?",
    body: (n) => `All ${n} open report${n === 1 ? "" : "s"} close as reviewed. The content stays up.`,
    confirm: "Mark reviewed",
    done: "Marked reviewed",
    reasonRequired: false,
  },
  remove: {
    button: "Remove content",
    title: "Remove this for everyone?",
    body: (n) =>
      `It disappears from the map, lists, saved lists and its own page for everyone, its owner included. The owner sees "removed by moderators" on their profile with the reason below.${n ? ` ${n} open report${n === 1 ? "" : "s"} close as reviewed.` : ""} Nothing is deleted, so it can be restored.`,
    confirm: "Remove",
    done: "Removed",
    reasonRequired: true,
  },
  restore: {
    button: "Restore content",
    title: "Restore this?",
    body: (n) => `It is published again and shows up for everyone who could see it before.${n ? ` ${n} open report${n === 1 ? "" : "s"} close as dismissed.` : ""}`,
    confirm: "Restore",
    done: "Restored",
    reasonRequired: false,
  },
};

/**
 * Pick an action, then confirm it with a reason. Every decision resolves all
 * open reports on the target together (one database transaction).
 */
export function ModerationActions({ targetType, targetId, status, openReports }: { targetType: ReportTargetType; targetId: string; status: string; openReports: number }) {
  const [action, setAction] = useState<ModerationAction | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const available: ModerationAction[] = [
    ...(openReports ? (["dismiss", "review"] as const) : []),
    ...(targetType !== "profile" && status !== "removed" ? (["remove"] as const) : []),
    ...(status === "removed" ? (["restore"] as const) : []),
  ];
  if (!available.length) return <p className="text-sm text-muted">Nothing to decide: no open reports.</p>;

  const close = () => {
    if (pending) return;
    setAction(null);
    setError(null);
  };
  const submit = () => {
    if (!action) return;
    start(async () => {
      const res = await resolveReportsAction({ targetType, targetId, action, reason });
      if (!res.ok) {
        setError(res.fieldErrors?.reason ?? res.error);
        return;
      }
      toast(COPY[action].done, "success");
      setAction(null);
      setReason("");
      router.refresh();
    });
  };

  const copy = action ? COPY[action] : null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {available.map((a) => (
          <Button key={a} type="button" variant={a === "remove" ? "danger" : "secondary"} size="sm" onClick={() => setAction(a)}>
            {COPY[a].button}
          </Button>
        ))}
      </div>
      <Sheet open={action !== null} onClose={close} title={copy?.title}>
        {copy ? (
          <div className="flex flex-col gap-4 pt-2">
            <p className="text-sm leading-relaxed text-ink-2">{copy.body(openReports)}</p>
            <FormField label="Reason" htmlFor="moderation-reason" hint={copy.reasonRequired ? (targetType === "message" ? "required · kept in the history" : "required · the owner sees it") : "optional · kept in the history"} error={error ?? undefined}>
              <Textarea id="moderation-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} required={copy.reasonRequired} />
            </FormField>
            <div className="flex gap-2">
              <Button type="button" variant="secondary" className="flex-1" onClick={close}>Back</Button>
              <Button type="button" variant={action === "remove" ? "danger" : "ink"} className="flex-1" loading={pending} onClick={submit}>
                {copy.confirm}
              </Button>
            </div>
          </div>
        ) : null}
      </Sheet>
    </>
  );
}
