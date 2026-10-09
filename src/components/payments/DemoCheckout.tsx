"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { demoCancelCheckoutAction, demoPayTicketAction, demoSetPlusAction } from "@/server/actions/payments";

/** The buttons of the labeled demo checkout. Nothing here touches money. */
export function DemoCheckout({ kind, ticketId, eventId }: { kind: "ticket" | "plus" | "manage"; ticketId?: string; eventId?: string | null }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const back = kind === "ticket" ? (eventId ? `/events/${eventId}` : "/profile/tickets") : "/plus";
  const pay = () =>
    start(async () => {
      if (kind === "ticket") {
        const res = await demoPayTicketAction(ticketId!);
        if (!res.ok) return toast(res.error, "error");
        router.push(res.data.outcome === "confirmed" ? `${back}?ticket=success` : `${back}?ticket=refunded`);
      } else {
        const res = await demoSetPlusAction(kind === "plus");
        if (!res.ok) return toast(res.error, "error");
        router.push(kind === "plus" ? "/plus?status=success" : "/plus");
      }
    });
  const cancel = () =>
    start(async () => {
      if (kind === "ticket" && ticketId) await demoCancelCheckoutAction(ticketId);
      router.push(back);
    });
  return (
    <div className="flex flex-wrap gap-2 mt-5">
      <Button type="button" variant="ink" onClick={pay} loading={pending}>
        {kind === "manage" ? "Cancel Plus (demo)" : "Pay (demo, no charge)"}
      </Button>
      <Button type="button" variant="secondary" onClick={cancel} disabled={pending}>{kind === "manage" ? "Keep Plus" : "Cancel"}</Button>
    </div>
  );
}
