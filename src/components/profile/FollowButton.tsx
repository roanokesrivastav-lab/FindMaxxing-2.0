"use client";
import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { UserCheck, UserPlus } from "lucide-react";
import { toggleFollowAction } from "@/server/actions/profile";
import { useToast } from "@/components/ui/Toast";
import { cn } from "@/lib/utils/cn";

export function FollowButton({ userId, following, signedIn, size = "md" }: { userId: string; following: boolean; signedIn: boolean; size?: "sm" | "md" }) {
  const [optimistic, setOptimistic] = useOptimistic(following);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const onClick = () => {
    if (!signedIn) {
      router.push(`/auth/sign-in?next=/people`);
      return;
    }
    const next = !optimistic;
    start(async () => {
      setOptimistic(next);
      const res = await toggleFollowAction(userId, next);
      if (!res.ok) toast(res.error, "error");
    });
  };

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={optimistic}
      className={cn(
        "rounded-full font-semibold inline-flex items-center gap-1.5 border transition-colors active:scale-[0.97] shrink-0",
        size === "sm" ? "h-9 px-3.5 text-sm" : "h-11 px-5",
        optimistic ? "bg-surface border-line text-ink-2" : "bg-ink text-white border-ink hover:bg-ink-2",
      )}
    >
      {optimistic ? <UserCheck size={16} /> : <UserPlus size={16} />}
      {optimistic ? "Following" : "Follow"}
    </button>
  );
}
