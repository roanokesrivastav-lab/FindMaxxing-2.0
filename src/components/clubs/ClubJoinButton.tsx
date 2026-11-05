"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { clubMemberAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";

/** R3: join or leave. Joining a club never signs you up for a session. */
export function ClubJoinButton({ clubId, member, owner, signedIn }: { clubId: string; member: boolean; owner: boolean; signedIn: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  if (owner) return null;
  return (
    <Button
      type="button"
      variant={member ? "secondary" : "ink"}
      aria-pressed={member}
      loading={pending}
      onClick={() => {
        if (!signedIn) return router.push(`/auth/sign-in?next=${encodeURIComponent(`/clubs/${clubId}`)}`);
        start(async () => {
          const res = await clubMemberAction(clubId, member ? "leave" : "join");
          if (!res.ok) toast(res.error, "error"); else toast(member ? "You left the club" : "You joined the club", "info");
          router.refresh();
        });
      }}
    >
      {member ? "Leave club" : "Join club"}
    </Button>
  );
}

/** R3: the owner removes a member. */
export function RemoveMemberButton({ clubId, userId, name }: { clubId: string; userId: string; name: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <button type="button" disabled={pending} className="type-body font-semibold text-danger underline underline-offset-4 min-h-6"
      onClick={() => start(async () => { const res = await clubMemberAction(clubId, "remove", userId); if (!res.ok) toast(res.error, "error"); router.refresh(); })}>
      Remove<span className="sr-only"> {name}</span>
    </button>
  );
}
