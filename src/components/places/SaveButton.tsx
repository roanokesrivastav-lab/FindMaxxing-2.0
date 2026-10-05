"use client";
import { Bookmark, Check } from "lucide-react";
import { useOptimistic, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toggleSaveAction } from "@/server/actions/places";
import { createListAction, setListMembershipAction } from "@/server/actions/lists";
import type { SavedList } from "@/lib/data/types";
import { Sheet } from "@/components/ui/Sheet";
import { useToast } from "@/components/ui/Toast";
import { ListNameForm } from "@/components/saved/ListNameForm";
import { cn } from "@/lib/utils/cn";
import { pluralize } from "@/lib/utils/format";

type MemberChange = { listId: string; inList: boolean } | { clear: true };

/**
 * The bookmark, plus the lists that organize it. One tap on an unsaved place
 * still saves it, then offers the lists; on a saved place it opens them.
 *
 * `saved`, `lists` and `memberIds` come from the server. Each action
 * revalidates, so its response carries the new props in the same transition;
 * the optimistic values only bridge the wait.
 */
export function SaveButton({
  placeId,
  saved,
  signedIn,
  lists = [],
  memberIds = [],
  variant = "pill",
}: {
  placeId: string;
  saved: boolean;
  signedIn: boolean;
  lists?: SavedList[];
  memberIds?: string[];
  variant?: "pill" | "icon";
}) {
  const [optimisticSaved, setOptimisticSaved] = useOptimistic(saved);
  const [members, changeMembers] = useOptimistic(memberIds, (current: string[], change: MemberChange) => {
    if ("clear" in change) return [];
    return change.inList ? [...new Set([...current, change.listId])] : current.filter((id) => id !== change.listId);
  });
  const [open, setOpen] = useState(false);
  const [, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const save = () =>
    start(async () => {
      setOptimisticSaved(true);
      const res = await toggleSaveAction(placeId, true);
      if (!res.ok) toast(res.error, "error");
    });

  const onButton = () => {
    if (!signedIn) {
      router.push(`/auth/sign-in?next=${encodeURIComponent(`/places/${placeId}`)}`);
      return;
    }
    if (!optimisticSaved) save();
    setOpen(true);
  };

  const toggleSaved = () => {
    if (!optimisticSaved) return save();
    const hadLists = members.length;
    start(async () => {
      setOptimisticSaved(false);
      changeMembers({ clear: true });
      const res = await toggleSaveAction(placeId, false);
      if (!res.ok) toast(res.error, "error");
      else toast(hadLists ? "Removed from saved and from every list" : "Removed from saved", "info");
    });
  };

  const toggleList = (list: SavedList) => {
    const inList = !members.includes(list.id);
    start(async () => {
      changeMembers({ listId: list.id, inList });
      // Adding to a list saves the place too.
      if (inList) setOptimisticSaved(true);
      const res = await setListMembershipAction(list.id, placeId, inList);
      if (!res.ok) toast(res.error, "error");
    });
  };

  const label = optimisticSaved ? "Saved" : "Save";
  return (
    <>
      {variant === "icon" ? (
        <button
          type="button"
          onClick={onButton}
          aria-pressed={optimisticSaved}
          aria-haspopup="dialog"
          aria-label={optimisticSaved ? "Saved. Organize into lists" : "Save"}
          className={cn(
            "h-10 w-10 inline-flex items-center justify-center rounded-full border backdrop-blur transition-colors active:scale-95",
            optimisticSaved ? "bg-flare text-white border-flare" : "bg-surface/90 border-line text-ink hover:bg-surface",
          )}
        >
          <Bookmark size={18} fill={optimisticSaved ? "currentColor" : "none"} />
        </button>
      ) : (
        <button
          type="button"
          onClick={onButton}
          aria-pressed={optimisticSaved}
          aria-haspopup="dialog"
          className={cn(
            "h-11 px-5 rounded-full font-semibold inline-flex items-center gap-2 border transition-colors active:scale-[0.97]",
            optimisticSaved ? "bg-flare text-white border-flare" : "bg-surface border-line hover:bg-surface-2",
          )}
        >
          <Bookmark size={18} fill={optimisticSaved ? "currentColor" : "none"} />
          {label}
        </button>
      )}

      <Sheet open={open} onClose={() => setOpen(false)} title="Save to">
        <div className="flex flex-col gap-1 pt-1" role="group" aria-label="Where this place is saved">
          <ListRow
            checked={optimisticSaved}
            onToggle={toggleSaved}
            title="Saved places"
            detail={optimisticSaved ? (members.length ? "Unsaving also removes it from your lists" : "In no list yet") : "Not saved"}
            emphasis
          />
          {lists.length ? <p className="text-xs font-bold uppercase tracking-wider text-muted mt-3 mb-1 px-1">Your lists</p> : null}
          {lists.map((list) => (
            <ListRow
              key={list.id}
              checked={members.includes(list.id)}
              onToggle={() => toggleList(list)}
              title={list.name}
              detail={pluralize(list.placeCount, "place")}
            />
          ))}
        </div>
        <div className="mt-4 pt-4 border-t border-line">
          <p className="text-sm font-semibold mb-2">New list</p>
          <ListNameForm
            compact
            submitLabel="Create"
            onSubmit={async (name) => {
              const res = await createListAction(name, placeId);
              if (res.ok) toast(`Added to “${res.data.list.name}”`, "success");
              return res;
            }}
          />
        </div>
        <Link href="/saved" onClick={() => setOpen(false)} className="mt-4 block text-center text-sm font-semibold text-muted hover:text-ink">
          See all saved places and lists
        </Link>
      </Sheet>
    </>
  );
}

function ListRow({ checked, onToggle, title, detail, emphasis = false }: { checked: boolean; onToggle: () => void; title: string; detail: string; emphasis?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={`${title}. ${detail}`}
      onClick={onToggle}
      className="flex items-center gap-3 rounded-2xl px-3 py-2.5 text-left hover:bg-surface-2 transition-colors"
    >
      <span
        className={cn(
          "h-6 w-6 shrink-0 rounded-md border-2 inline-flex items-center justify-center transition-colors",
          checked ? "bg-flare border-flare text-white" : "border-line-2 bg-surface",
        )}
        aria-hidden
      >
        {checked ? <Check size={15} strokeWidth={3} /> : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className={cn("block truncate", emphasis ? "font-bold" : "font-semibold")}>{title}</span>
        <span className="block text-xs text-muted truncate">{detail}</span>
      </span>
    </button>
  );
}
