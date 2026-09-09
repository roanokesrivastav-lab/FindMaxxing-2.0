"use client";
import { Check, UserPlus } from "lucide-react";
import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toggleAttendanceAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";

export function JoinButton({
  eventId,
  joined,
  signedIn,
  full,
  ended,
  cancelled = false,
  size = "lg",
}: {
  eventId: string;
  joined: boolean;
  signedIn: boolean;
  full: boolean;
  ended: boolean;
  cancelled?: boolean;
  size?: "md" | "lg";
}) {
  const [optimistic, setOptimistic] = useOptimistic(joined);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const disabled = ended || (!optimistic && (cancelled || full));

  const onClick = () => {
    if (!signedIn) {
      router.push(`/auth/sign-in?next=${encodeURIComponent(`/events/${eventId}`)}`);
      return;
    }
    const next = !optimistic;
    start(async () => {
      setOptimistic(next);
      const res = await toggleAttendanceAction(eventId, next);
      if (!res.ok) toast(res.error, "error");
      else toast(next ? "You're in! See you there." : "You left this event", next ? "success" : "info");
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending || disabled}
      aria-pressed={optimistic}
      className={cn(
        "rounded-full font-semibold inline-flex items-center justify-center gap-2 transition-colors active:scale-[0.97] disabled:opacity-60 disabled:active:scale-100",
        size === "lg" ? "h-13 px-7 text-base" : "h-11 px-4 text-sm shrink-0",
        optimistic ? "bg-moss-100 text-moss border border-moss/30" : "bg-pulse text-white hover:bg-pulse-600 shadow-[0_8px_20px_-8px_rgba(107,76,255,0.7)]",
      )}
    >
      {optimistic ? <Check size={18} strokeWidth={2.5} /> : <UserPlus size={18} />}
      {cancelled && !optimistic ? "Event cancelled" : ended ? "Event ended" : optimistic ? "You're going" : full ? "Event full" : "Join event"}
    </button>
  );
}
