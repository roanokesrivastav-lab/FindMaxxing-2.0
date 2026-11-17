"use client";
import { useState, useTransition } from "react";
import { cancelOccurrenceAction, endSeriesAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { Sheet } from "@/components/ui/Sheet";

/**
 * Host tools for one session of a series (roadmap 4.5a). A backup host can
 * cancel this session; only the owner can end the series. Both confirm first.
 */
export function SeriesHostTools({ eventId, seriesId, isOwner }: { eventId: string; seriesId: string; isOwner: boolean }) {
  const [confirm, setConfirm] = useState<"cancel" | "end" | null>(null);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const submit = () => start(async () => {
    const res = confirm === "cancel" ? await cancelOccurrenceAction(eventId) : await endSeriesAction(seriesId, eventId);
    if (!res.ok) toast(res.error, "error");
    else { toast(confirm === "cancel" ? "This session is cancelled" : "Series ended", "success"); setConfirm(null); }
  });
  return (
    <div className="card p-4 mt-3 flex flex-wrap items-center gap-3" data-series-host-tools="">
      <p className="flex-1 min-w-0 basis-[12rem] text-sm text-ink-2">
        This is one session of a repeating series. Cancelling it leaves the other sessions as they are{isOwner ? "; ending the series cancels every later session" : ""}.
      </p>
      <div className="flex gap-2">
        <Button type="button" variant="secondary" onClick={() => setConfirm("cancel")}>Cancel this session</Button>
        {isOwner ? <Button type="button" variant="danger" onClick={() => setConfirm("end")}>End series</Button> : null}
      </div>
      <Sheet open={confirm !== null} onClose={() => !pending && setConfirm(null)} title={confirm === "cancel" ? "Cancel this session?" : "End this series?"}>
        <div className="flex flex-col gap-4 pt-2">
          <p className="text-sm leading-relaxed text-ink-2">
            {confirm === "cancel"
              ? "Everyone going is told. The next session is not affected, and this date will not be created again."
              : "Every later session is cancelled and everyone going to them is told. Sessions up to today stay as they are."}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setConfirm(null)}>Keep it</Button>
            <Button type="button" variant="danger" className="flex-1" loading={pending} onClick={submit}>{confirm === "cancel" ? "Cancel session" : "End series"}</Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}
