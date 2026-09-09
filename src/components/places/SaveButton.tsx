"use client";
import { Bookmark } from "lucide-react";
import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleSaveAction } from "@/server/actions/places";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";

export function SaveButton({ placeId, saved, signedIn, variant = "pill" }: { placeId: string; saved: boolean; signedIn: boolean; variant?: "pill" | "icon" }) {
  const [optimistic, setOptimistic] = useOptimistic(saved);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const onClick = () => {
    if (!signedIn) {
      router.push(`/auth/sign-in?next=${encodeURIComponent(`/places/${placeId}`)}`);
      return;
    }
    const next = !optimistic;
    start(async () => {
      setOptimistic(next);
      const res = await toggleSaveAction(placeId, next);
      if (!res.ok) toast(res.error, "error");
      else toast(next ? "Saved to your list" : "Removed from saved", next ? "success" : "info");
    });
  };

  if (variant === "icon") {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={pending}
        aria-pressed={optimistic}
        aria-label={optimistic ? "Unsave" : "Save"}
        className={cn(
          "h-10 w-10 inline-flex items-center justify-center rounded-full border backdrop-blur transition-colors active:scale-95",
          optimistic ? "bg-flare text-white border-flare" : "bg-surface/90 border-line text-ink hover:bg-surface",
        )}
      >
        <Bookmark size={18} fill={optimistic ? "currentColor" : "none"} />
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={optimistic}
      className={cn(
        "h-11 px-5 rounded-full font-semibold inline-flex items-center gap-2 border transition-colors active:scale-[0.97]",
        optimistic ? "bg-flare text-white border-flare" : "bg-surface border-line hover:bg-surface-2",
      )}
    >
      <Bookmark size={18} fill={optimistic ? "currentColor" : "none"} />
      {optimistic ? "Saved" : "Save"}
    </button>
  );
}
