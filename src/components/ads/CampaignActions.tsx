"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import type { CampaignStatus } from "@/lib/data/types";
import { payCampaignAction, reviewCampaignAction, setCampaignPausedAction } from "@/server/actions/ads";

export function CampaignActions({ id, status }: { id: string; status: CampaignStatus }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: unknown }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return toast(res.error ?? "Something went wrong", "error");
      const url = (res.data as { url?: string } | undefined)?.url;
      if (url) return url.startsWith("/") ? router.push(url) : window.location.assign(url);
      router.refresh();
    });
  if (status === "awaiting_payment") return <Button type="button" size="sm" variant="ink" loading={pending} onClick={() => run(() => payCampaignAction(id))}>Pay and start</Button>;
  if (status === "active") return <Button type="button" size="sm" variant="secondary" loading={pending} onClick={() => run(() => setCampaignPausedAction(id, true))}>Pause</Button>;
  if (status === "paused") return <Button type="button" size="sm" variant="secondary" loading={pending} onClick={() => run(() => setCampaignPausedAction(id, false))}>Resume</Button>;
  return null;
}

export function ReviewButtons({ id }: { id: string }) {
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const review = (approve: boolean) =>
    start(async () => {
      const res = await reviewCampaignAction({ campaignId: id, approve, note });
      if (!res.ok) return toast(res.error, "error");
      toast(approve ? "Approved: waiting for payment" : "Rejected", "success");
      router.refresh();
    });
  return (
    <div className="flex flex-wrap items-center gap-2 mt-2">
      <label htmlFor={`note-${id}`} className="sr-only">Reason</label>
      <input id={`note-${id}`} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Reason (needed to reject)" maxLength={500} className="h-9 flex-1 min-w-40 rounded-xl border border-line bg-surface px-3 text-sm" />
      <Button type="button" size="sm" variant="ink" loading={pending} onClick={() => review(true)}>Approve</Button>
      <Button type="button" size="sm" variant="danger" disabled={pending} onClick={() => review(false)}>Reject</Button>
    </div>
  );
}
