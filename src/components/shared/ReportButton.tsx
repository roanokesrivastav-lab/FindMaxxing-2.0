"use client";
import { Flag } from "lucide-react";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { FormField, Textarea } from "@/components/ui/Field";
import { REPORT_REASONS } from "@/lib/data/taxonomy";
import { reportAction } from "@/server/actions/places";
import { useToast } from "@/components/ui/Toast";
import type { ReportTargetType } from "@/lib/data/types";
import type { ActionResult } from "@/server/actions/result";

export function ReportButton({ targetType, targetId, signedIn, returnTo }: { targetType: ReportTargetType; targetId: string; signedIn: boolean; returnTo: string }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { toast } = useToast();
  const [state, action, pending] = useActionState(
    async (prev: ActionResult | null, formData: FormData) => {
      const res = await reportAction(prev, formData);
      if (res.ok) {
        setOpen(false);
        toast("Thanks. We'll take a look.", "success");
      }
      return res;
    },
    null,
  );

  return (
    <>
      <button
        type="button"
        onClick={() => (signedIn ? setOpen(true) : router.push(`/auth/sign-in?next=${encodeURIComponent(returnTo)}`))}
        className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-ink"
      >
        <Flag size={15} />
        Report
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="Report this listing">
        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="targetType" value={targetType} />
          <input type="hidden" name="targetId" value={targetId} />
          <fieldset className="flex flex-col gap-2">
            <legend className="text-sm font-semibold mb-1">What&apos;s wrong?</legend>
            {REPORT_REASONS.map((r) => (
              <label key={r.value} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 has-[:checked]:border-ink has-[:checked]:bg-surface-2 cursor-pointer">
                <input type="radio" name="reason" value={r.value} required className="accent-ink" />
                <span className="text-sm font-medium">{r.label}</span>
              </label>
            ))}
            {state && !state.ok && state.fieldErrors?.reason ? <p className="text-sm text-danger">{state.fieldErrors.reason}</p> : null}
          </fieldset>
          <FormField label="Details" htmlFor="report-details" hint="optional">
            <Textarea id="report-details" name="details" rows={3} maxLength={500} placeholder="Anything that helps us check it" />
          </FormField>
          {state && !state.ok && !state.fieldErrors ? <p className="text-sm text-danger">{state.error}</p> : null}
          <Button type="submit" loading={pending} variant="ink">
            Submit report
          </Button>
        </form>
      </Sheet>
    </>
  );
}
