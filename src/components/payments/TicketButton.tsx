"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ticket } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { formatPrice } from "@/lib/data/payments";
import { buyTicketAction } from "@/server/actions/payments";

/** "Buy ticket": holds a spot for 30 minutes and goes to checkout. */
export function TicketButton({ eventId, priceCents, signedIn, disabled }: { eventId: string; priceCents: number; signedIn: boolean; disabled?: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <Button
      type="button"
      variant="primary"
      loading={pending}
      disabled={disabled}
      onClick={() => {
        if (!signedIn) return router.push(`/auth/sign-in?next=/events/${eventId}`);
        start(async () => {
          const res = await buyTicketAction(eventId);
          if (!res.ok) toast(res.error, "error");
          else if (res.data.url.startsWith("/")) router.push(res.data.url);
          else window.location.assign(res.data.url);
        });
      }}
    >
      <Ticket size={18} /> Buy ticket · {formatPrice(priceCents)}
    </Button>
  );
}
