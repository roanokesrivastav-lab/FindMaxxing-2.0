"use client";

import { useOptimistic, useTransition } from "react";
import { useToast } from "@/components/ui/Toast";
import { setAnalyticsOptOutAction } from "@/server/actions/analytics";

/** "Share anonymous usage" switch. Off means nothing about this account is recorded. */
export function AnalyticsToggle({ optedOut }: { optedOut: boolean }) {
  const [optimistic, setOptimistic] = useOptimistic(optedOut);
  const [, start] = useTransition();
  const { toast } = useToast();
  const sharing = !optimistic;
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        role="switch"
        className="mt-1 h-5 w-5 accent-ink"
        checked={sharing}
        onChange={(e) => {
          const optOut = !e.target.checked;
          start(async () => {
            setOptimistic(optOut);
            const res = await setAnalyticsOptOutAction(optOut);
            if (!res.ok) toast(res.error, "error");
          });
        }}
      />
      <span className="text-sm">
        <span className="font-semibold block">Share anonymous usage</span>
        <span className="text-muted">Counts like &ldquo;someone saved a place&rdquo;, under a scrambled id, never your name, email or location. Kept 180 days. Your browser&apos;s Do Not Track or Global Privacy Control setting turns this off too.</span>
      </span>
    </label>
  );
}
