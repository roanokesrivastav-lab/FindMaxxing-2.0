"use client";
import { MoreVertical, Pencil, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { deleteListAction, renameListAction } from "@/server/actions/lists";
import { ListNameForm } from "./ListNameForm";

/** Rename or delete one of the viewer's lists. Deleting keeps every place saved. */
export function ListActions({ listId, name, placeCount }: { listId: string; name: string; placeCount: number }) {
  const [sheet, setSheet] = useState<"menu" | "rename" | "delete" | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const remove = () =>
    start(async () => {
      const res = await deleteListAction(listId);
      if (!res.ok) {
        toast(res.error, "error");
        return;
      }
      setSheet(null);
      toast(`Deleted “${name}”. Its places are still saved.`, "success");
      router.push("/saved");
    });

  return (
    <>
      <button type="button" onClick={() => setSheet("menu")} aria-label="List options" className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-full bg-surface border border-line shadow-card">
        <MoreVertical size={18} />
      </button>
      <Sheet open={sheet === "menu"} onClose={() => setSheet(null)} title={name}>
        <div className="flex flex-col gap-2 pt-2">
          <button type="button" onClick={() => setSheet("rename")} className="chip justify-start">
            <Pencil size={16} /> Rename
          </button>
          <button type="button" onClick={() => setSheet("delete")} className="chip justify-start text-danger">
            <Trash2 size={16} /> Delete list
          </button>
        </div>
      </Sheet>
      <Sheet open={sheet === "rename"} onClose={() => setSheet(null)} title="Rename list">
        <ListNameForm
          initial={name}
          submitLabel="Save name"
          onSubmit={async (next) => {
            const res = await renameListAction(listId, next);
            if (res.ok) toast("List renamed", "success");
            return res;
          }}
          onDone={() => setSheet(null)}
        />
      </Sheet>
      <Sheet open={sheet === "delete"} onClose={() => !pending && setSheet(null)} title={`Delete “${name}”?`}>
        <div className="flex flex-col gap-4 pt-2">
          <p className="text-sm leading-relaxed text-ink-2">
            {placeCount
              ? `Only the list goes. ${placeCount === 1 ? "The place in it stays" : `The ${placeCount} places in it stay`} in Saved and in any other lists.`
              : "This list is empty. Nothing else changes."}
          </p>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setSheet(null)}>
              Keep it
            </Button>
            <Button type="button" variant="danger" className="flex-1" loading={pending} onClick={remove}>
              Delete list
            </Button>
          </div>
        </div>
      </Sheet>
    </>
  );
}
