"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Star } from "lucide-react";
import type { ViewerParticipation } from "@findmaxxing/shared/events";
import { participationAction, toggleAttendanceAction, type ParticipationOp } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { JoinButton } from "@/components/events/JoinButton";
import { deadlineText } from "@/lib/events/readiness";

/**
 * Roadmap 4.4: the one primary action for a free event, by the viewer's status. Not going: Join (or
 * Join waitlist when every seat is taken or held) plus Interested. Waitlisted: Leave waitlist. Offered:
 * Accept spot / Decline, with the time it is held until. Going: today's "You're going" toggle.
 */
export function ParticipationActions({
  eventId, status, offerExpiresAt, full, ended, cancelled, signedIn, timeZone, now,
}: {
  eventId: string;
  status: ViewerParticipation;
  offerExpiresAt: string | null;
  full: boolean;
  ended: boolean;
  cancelled: boolean;
  signedIn: boolean;
  timeZone: string;
  now: number;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const act = (op: ParticipationOp, done: (s: string) => string) =>
    start(async () => {
      const res = await participationAction(eventId, op);
      if (!res.ok) toast(res.error, "error");
      else toast(done(res.data.status), res.data.status === "offer_expired" ? "error" : "info");
      router.refresh();
    });
  const joinWaitlist = () =>
    start(async () => {
      if (!signedIn) return router.push(`/auth/sign-in?next=${encodeURIComponent(`/events/${eventId}`)}`);
      const res = await toggleAttendanceAction(eventId, true);
      if (!res.ok) toast(res.error, "error");
      else toast(res.data.status === "going" ? "A spot was free: you're in!" : "You're on the waitlist. We'll tell you if a spot opens.", "success");
      router.refresh();
    });

  if (status === "going" || ended || cancelled) {
    return <JoinButton eventId={eventId} joined={status === "going"} signedIn={signedIn} full={full} ended={ended} cancelled={cancelled} size="md" />;
  }
  if (status === "offered") {
    return (
      <div className="flex flex-wrap items-center gap-item">
        <Button type="button" variant="pulse" loading={pending} onClick={() => act("accept", (s) => (s === "going" ? "You're in! See you there." : "That offer ran out, sorry."))}>Accept spot</Button>
        <Button type="button" variant="secondary" disabled={pending} onClick={() => act("decline", () => "Offer declined. The spot goes to the next person.")}>Decline</Button>
        {offerExpiresAt ? <span className="type-body text-ink-2 w-full">Held for you until {deadlineText(offerExpiresAt, timeZone, now)}.</span> : null}
      </div>
    );
  }
  if (status === "waitlisted") {
    return <Button type="button" variant="secondary" loading={pending} onClick={() => act("leave", () => "You left the waitlist")}>Leave waitlist</Button>;
  }
  const interested = status === "interested";
  return (
    <div className="flex flex-wrap items-center gap-item">
      {full ? (
        <Button type="button" variant="pulse" loading={pending} onClick={joinWaitlist}>Join waitlist</Button>
      ) : (
        <JoinButton eventId={eventId} joined={false} signedIn={signedIn} full={false} ended={ended} cancelled={cancelled} size="md" />
      )}
      {signedIn ? (
        <Button type="button" variant="ghost" aria-pressed={interested} disabled={pending} onClick={() => act(interested ? "interest-off" : "interest-on", (s) => (s === "interested" ? "Marked as interested" : "No longer interested"))}>
          <Star size={16} aria-hidden fill={interested ? "currentColor" : "none"} /> Interested
        </Button>
      ) : null}
    </div>
  );
}
