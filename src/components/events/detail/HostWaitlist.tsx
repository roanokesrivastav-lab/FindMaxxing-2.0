"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import type { HostParticipant } from "@findmaxxing/shared/events";
import { hostRemoveParticipantAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { SectionHeader } from "@/components/ui/SectionHeader";

/** 4.4: the waitlist with names, for the host only (D-K). Everyone else sees the count. */
export function HostWaitlist({ eventId, rows }: { eventId: string; rows: HostParticipant[] }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  if (!rows.length) return null;
  return (
    <section aria-labelledby="ev-waitlist">
      <SectionHeader id="ev-waitlist" title="Waitlist (only you see names)" />
      <ol>
        {rows.map((r) => (
          <li key={r.userId} className="surface-flat flex flex-wrap items-center justify-between gap-item py-item">
            <span className="type-body text-ink font-semibold min-w-0 break-words">{r.displayName}</span>
            <span className="flex items-center gap-item">
              <StatusLabel tone={r.status === "offered" ? "pending" : "neutral"}>{r.status === "offered" ? "Offered a spot" : "Waiting"}</StatusLabel>
              <button
                type="button"
                disabled={pending}
                className="type-body font-semibold text-danger underline underline-offset-4 min-h-6"
                onClick={() => start(async () => {
                  const res = await hostRemoveParticipantAction(eventId, r.userId);
                  if (!res.ok) toast(res.error, "error"); else toast(`${r.displayName} removed`, "info");
                  router.refresh();
                })}
              >
                Remove<span className="sr-only"> {r.displayName}</span>
              </button>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
