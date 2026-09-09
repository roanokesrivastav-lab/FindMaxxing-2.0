"use client";

import Link from "next/link";
import { MoreVertical, Pencil, Trash2, XCircle } from "lucide-react";
import { useState, useTransition } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { deletePlaceAction } from "@/server/actions/places";
import { cancelEventAction, deleteEventAction } from "@/server/actions/events";

export function OwnerActions({ kind, id, canEdit, canCancel, canDelete }: { kind: "place" | "event"; id: string; canEdit: boolean; canCancel?: boolean; canDelete?: boolean }) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState<"cancel" | "delete" | null>(null);
  const [pending, start] = useTransition();
  const { toast } = useToast();
  const destructive = confirm !== null;

  const submit = () => {
    start(async () => {
      const result = kind === "place"
        ? await deletePlaceAction(id)
        : confirm === "cancel" ? await cancelEventAction(id) : await deleteEventAction(id);
      if (!result.ok) toast(result.error, "error");
      else { setConfirm(null); setOpen(false); toast(kind === "place" || confirm === "delete" ? "Deleted" : "Event cancelled", "success"); }
    });
  };

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label="Owner actions" className="h-10 w-10 inline-flex items-center justify-center rounded-full bg-surface/90 backdrop-blur border border-line shadow-card">
        <MoreVertical size={18} />
      </button>
      <Sheet open={open} onClose={() => !pending && setOpen(false)} title={kind === "place" ? "Manage place" : "Manage event"}>
        <div className="flex flex-col gap-2 pt-2">
          {canEdit ? <Link href={`/${kind}s/${id}/edit`} onClick={() => setOpen(false)} className="chip justify-start"><Pencil size={16} /> Edit</Link> : null}
          {kind === "event" && canCancel ? <button type="button" onClick={() => setConfirm("cancel")} className="chip justify-start"><XCircle size={16} /> Cancel event</button> : null}
          {canDelete ? <button type="button" onClick={() => setConfirm("delete")} className="chip justify-start text-danger"><Trash2 size={16} /> Delete permanently</button> : null}
        </div>
      </Sheet>
      <Sheet open={destructive} onClose={() => !pending && setConfirm(null)} title={confirm === "cancel" ? "Cancel this event?" : kind === "place" ? "Delete this place permanently?" : "Delete this event permanently?"}>
        <div className="flex flex-col gap-4 pt-2">
          <p className="text-sm leading-relaxed text-ink-2">{confirm === "cancel" ? "This event will remain available to attendees and by direct link, but nobody else can join it." : kind === "place" ? "This cannot be undone. Ratings, saves, tags, photos, and uploaded photo objects will be removed. Linked events will keep their location details." : "This cannot be undone. Events with other attendees must be cancelled instead."}</p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setConfirm(null)}>Keep it</Button>
            <Button type="button" variant="danger" className="flex-1" loading={pending} onClick={submit}>{confirm === "cancel" ? "Cancel event" : "Delete permanently"}</Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
