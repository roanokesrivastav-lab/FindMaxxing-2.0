"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { confirmSessionAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";

/** 4.3: the host confirms the session is happening, which stops the deadline auto-cancel. */
export function ConfirmSessionButton({ eventId }: { eventId: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <Button
      type="button"
      variant="secondary"
      loading={pending}
      onClick={() =>
        start(async () => {
          const res = await confirmSessionAction(eventId);
          if (!res.ok) toast(res.error, "error");
          else {
            toast("Confirmed: it's happening", "success");
            router.refresh();
          }
        })
      }
    >
      Confirm it&apos;s happening
    </Button>
  );
}
