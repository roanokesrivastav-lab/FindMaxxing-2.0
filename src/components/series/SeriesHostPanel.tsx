"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { SeriesHost } from "@findmaxxing/shared/events";
import { setSeriesHostAction } from "@/server/actions/events";
import { useToast } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";
import { FormField, Input } from "@/components/ui/Field";

/** 4.5b: the owner adds a backup host by username or removes one; removal takes effect at once. */
export function SeriesHostPanel({ seriesId, hosts }: { seriesId: string; hosts: SeriesHost[] }) {
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | undefined>();
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const run = (who: string, on: boolean) => start(async () => {
    const res = await setSeriesHostAction(seriesId, who, on);
    if (!res.ok) { setError(res.fieldErrors?.hostUsername ?? res.error); return; }
    setError(undefined);
    setUsername("");
    toast(on ? "Backup host added" : "Backup host removed", "info");
    router.refresh();
  });
  return (
    <div className="mt-row flex flex-col gap-item">
      {hosts.filter((h) => h.role === "backup").map((h) => (
        <div key={h.userId} className="flex flex-wrap items-center justify-between gap-item">
          <span className="type-body text-ink">{h.displayName} <span className="text-muted">(backup)</span></span>
          <button type="button" disabled={pending} onClick={() => run(h.userId, false)} className="type-body font-semibold text-danger underline underline-offset-4 min-h-6">
            Remove<span className="sr-only"> {h.displayName}</span>
          </button>
        </div>
      ))}
      <form className="flex flex-wrap items-end gap-item" onSubmit={(e) => { e.preventDefault(); if (username.trim()) run(username, true); }}>
        <div className="min-w-0 flex-1 basis-[12rem]">
          <FormField label="Add a backup host" htmlFor="hostUsername" hint="their username" error={error}>
            <Input id="hostUsername" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="@username" autoComplete="off" error={error} />
          </FormField>
        </div>
        <Button type="submit" variant="secondary" loading={pending}>Add</Button>
      </form>
    </div>
  );
}
