"use client";
import { useState, useTransition } from "react";
import { compareAction } from "@/server/actions/places";
import { useToast } from "@/components/ui/Toast";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import type { ComparisonPrompt } from "@/lib/data/types";

/**
 * "Which did you prefer?" after a star rating: a few head-to-head questions
 * against places the person rated the same, each answer halving where the new
 * place belongs. Stops when nothing is left to ask, or on "Too close to call".
 */
export function ComparePrompt({ initial, onClose }: { initial: ComparisonPrompt; onClose: () => void }) {
  const [prompt, setPrompt] = useState<ComparisonPrompt>(initial);
  const [asked, setAsked] = useState(0);
  const [pending, start] = useTransition();
  const { toast } = useToast();

  const choose = (winnerId: string, loserId: string) => {
    start(async () => {
      const res = await compareAction({ subjectId: prompt.subject.id, winnerId, loserId });
      if (!res.ok) {
        toast(res.error, "error");
        return;
      }
      setAsked((n) => n + 1);
      if (res.data.comparison) {
        setPrompt(res.data.comparison);
      } else {
        toast("Ranking updated", "success");
        onClose();
      }
    });
  };

  const { subject, opponent } = prompt;
  return (
    <Sheet open onClose={onClose} title="Which do you prefer?">
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted">
          You rated both the same. Pick the one you&apos;d rather go to again{asked ? ` (${asked} answered)` : ""}.
        </p>
        <Button type="button" variant="ink" disabled={pending} onClick={() => choose(subject.id, opponent.id)}>
          {subject.name}
        </Button>
        <Button type="button" variant="ink" disabled={pending} onClick={() => choose(opponent.id, subject.id)}>
          {opponent.name}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={onClose}>
          {asked ? "Done" : "Too close to call"}
        </Button>
      </div>
    </Sheet>
  );
}
