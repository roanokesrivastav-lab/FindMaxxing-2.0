"use client";
import { X } from "lucide-react";
import { useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import { setListMembershipAction } from "@/server/actions/lists";

/** Takes a place out of one list. It stays saved, and in any other lists. */
export function RemoveFromListButton({ listId, placeId, placeName }: { listId: string; placeId: string; placeName: string }) {
  const [pending, start] = useTransition();
  const { toast } = useToast();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await setListMembershipAction(listId, placeId, false);
          if (!res.ok) toast(res.error, "error");
          else toast(`Removed ${placeName} from this list. It's still saved.`, "info");
        })
      }
      aria-label={`Remove ${placeName} from this list`}
      className="absolute right-2 top-2 z-10 h-8 w-8 rounded-full bg-ink/80 text-white inline-flex items-center justify-center disabled:opacity-50"
    >
      <X size={15} />
    </button>
  );
}
