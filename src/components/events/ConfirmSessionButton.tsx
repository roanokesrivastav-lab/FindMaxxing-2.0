"use client";
import { useTransition } from "react";
import { confirmSessionAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";

/** Host only: says the session is on, which blocks the automatic cancel at the deadline (roadmap 4.3). */
export function ConfirmSessionButton({ eventId }: { eventId: string }) {
  const [pending, start] = useTransition();
  const { toast } = useToast();
  return (
    <Button
      type="button"
      variant="pulse"
      loading={pending}
      onClick={() => start(async () => {
        const res = await confirmSessionAction(eventId);
        toast(res.ok ? "Confirmed. It's on." : res.error, res.ok ? "success" : "error");
      })}
    >
      Confirm it&apos;s on
    </Button>
  );
}
