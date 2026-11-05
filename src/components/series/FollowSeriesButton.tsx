"use client";
import { useOptimistic, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff } from "lucide-react";
import { followSeriesAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";

/** 4.5b: follow = updates only. It never signs anyone up for a session. */
export function FollowSeriesButton({ seriesId, following, signedIn }: { seriesId: string; following: boolean; signedIn: boolean }) {
  const [on, setOn] = useOptimistic(following);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <Button
      type="button"
      variant={on ? "secondary" : "ink"}
      aria-pressed={on}
      disabled={pending}
      onClick={() => {
        if (!signedIn) return router.push(`/auth/sign-in?next=${encodeURIComponent(`/series/${seriesId}`)}`);
        start(async () => {
          setOn(!on);
          const res = await followSeriesAction(seriesId, !on);
          if (!res.ok) toast(res.error, "error");
          else toast(res.data.following ? "Following: you'll hear about schedule changes and cancellations" : "Unfollowed", "info");
          router.refresh();
        });
      }}
    >
      {on ? <BellOff size={16} aria-hidden /> : <Bell size={16} aria-hidden />} {on ? "Following" : "Follow"}
    </Button>
  );
}
