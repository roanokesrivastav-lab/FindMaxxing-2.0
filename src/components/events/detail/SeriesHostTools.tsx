"use client";
import Link from "next/link";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { seriesHostAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";

/** 4.5a: host tools on a series occurrence: edit (this / future), cancel this one, end the series. */
export function SeriesHostTools({ eventId, seriesId, canEdit }: { eventId: string; seriesId: string; canEdit: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const run = (op: "cancel-occurrence" | "end-series", id: string, done: string, confirmText: string) => {
    if (!window.confirm(confirmText)) return;
    start(async () => {
      const res = await seriesHostAction(op, id);
      if (!res.ok) toast(res.error, "error"); else toast(done, "info");
      router.refresh();
    });
  };
  if (!canEdit) return null;
  return (
    <div className="mt-row flex flex-wrap items-center gap-item">
      <Link href={`/events/${eventId}/edit`} className="chip">Edit this or future</Link>
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={() => run("cancel-occurrence", eventId, "This one is cancelled. The next one is untouched.", "Cancel only this date? People going are told; the rest of the series stays.")}>Cancel this one</Button>
      <Button type="button" variant="danger" size="sm" disabled={pending} onClick={() => run("end-series", seriesId, "Series ended. Future dates are cancelled.", "End the whole series? Every future date is cancelled and people going are told.")}>End series</Button>
    </div>
  );
}
