"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { X } from "lucide-react";
import { useImpression, type Attribution } from "@/components/interactions/impressions";
import { useToast } from "@/components/ui/Toast";
import { notInterestedAction, undoNotInterestedAction } from "@/server/actions/interactions";

/**
 * One "For you" card: seeing it counts as an impression, and "Not interested"
 * takes it out of the viewer's recommendations (with an undo).
 */
export function RecommendationCard({
  kind, id, position, attribution, href, title, children,
}: {
  kind: "place" | "event";
  id: string;
  position: number;
  attribution: Attribution;
  href: string;
  title: string;
  children: React.ReactNode;
}) {
  const ref = useImpression<HTMLLIElement>({ itemType: kind, itemId: id, surface: "for_you", position, ...attribution });
  const [hidden, setHidden] = useState(false);
  const [pending, start] = useTransition();
  const { toast } = useToast();

  const hide = () => {
    setHidden(true);
    start(async () => {
      const res = await notInterestedAction(kind, id, position, attribution);
      if (!res.ok) {
        setHidden(false);
        toast(res.error, "error");
      }
    });
  };
  const undo = () => {
    setHidden(false);
    start(async () => {
      const res = await undoNotInterestedAction(kind, id);
      if (!res.ok) {
        setHidden(true);
        toast(res.error, "error");
      }
    });
  };

  return (
    <li ref={ref} className="snap-start shrink-0 w-[80%] max-w-64 relative">
      {hidden ? (
        <div className="card p-3 h-full flex flex-col items-start justify-center gap-1 text-sm" role="status">
          <span className="font-semibold">Got it.</span>
          <span className="text-xs text-muted">We won&apos;t suggest {title} again.</span>
          <button type="button" onClick={undo} disabled={pending} className="mt-1 text-xs font-semibold text-flare-ink">
            Undo
          </button>
        </div>
      ) : (
        <>
          <Link href={href} className="card p-3 pr-8 h-full flex flex-col gap-1 hover:border-ink transition-colors">
            {children}
          </Link>
          <button
            type="button"
            onClick={hide}
            disabled={pending}
            className="absolute top-1.5 right-1.5 h-7 w-7 inline-flex items-center justify-center rounded-full text-muted hover:bg-surface-2 hover:text-ink transition-colors"
            aria-label={`Not interested in ${title}`}
            title="Not interested"
          >
            <X size={15} aria-hidden />
          </button>
        </>
      )}
    </li>
  );
}
