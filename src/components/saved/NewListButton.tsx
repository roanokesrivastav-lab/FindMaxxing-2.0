"use client";
import { Plus } from "lucide-react";
import { useState } from "react";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { createListAction } from "@/server/actions/lists";
import { ListNameForm } from "./ListNameForm";

/** Starts an empty list. Places go in from their own page's Save button. */
export function NewListButton({ className = "chip shrink-0" }: { className?: string }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        <Plus size={15} /> New list
      </button>
      <Sheet open={open} onClose={() => setOpen(false)} title="New list">
        <p className="text-sm text-muted -mt-1 mb-4">Group places however you like. A place can be in as many lists as you want.</p>
        <ListNameForm
          submitLabel="Create list"
          onSubmit={async (name) => {
            const res = await createListAction(name);
            if (res.ok) toast(`Created “${res.data.list.name}”`, "success");
            return res;
          }}
          onDone={() => setOpen(false)}
        />
      </Sheet>
    </>
  );
}
