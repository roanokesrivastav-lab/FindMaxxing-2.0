"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { Megaphone } from "lucide-react";
import type { GeoBounds } from "@/lib/data/types";
import { bboxParam } from "@/lib/map/bounds";

interface Card {
  campaignId: string;
  headline: string;
  body: string | null;
  title: string;
  subtitle: string;
  href: string;
}

/**
 * The one sponsored card of a list: fetched on its own from /api/ads with the
 * search's context (the map area and category, nothing about the viewer), so
 * it can never move or replace an organic result. Always labeled.
 */
export function SponsoredSlot({ slot, bounds, category }: { slot: "places" | "events"; bounds: GeoBounds | null; category: string | null }) {
  const [card, setCard] = useState<Card | null>(null);
  const key = `${slot}|${bounds ? bboxParam(bounds) : ""}|${category ?? ""}`;
  useEffect(() => {
    const controller = new AbortController();
    const q = new URLSearchParams({ slot });
    if (bounds) q.set("bbox", bboxParam(bounds));
    if (category) q.set("category", category);
    // Wait for the map to settle so panning doesn't count impressions.
    const timer = window.setTimeout(() => {
      fetch(`/api/ads?${q}`, { signal: controller.signal, credentials: "same-origin" })
        .then((r) => (r.ok ? r.json() : { card: null }))
        .then((d: { card: Card | null }) => setCard(d.card), () => {});
    }, 800);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the key stands for the inputs
  }, [key]);
  if (!card) return null;
  return (
    <Link href={card.href} className="card px-3.5 py-3 flex gap-3 items-start border-dashed hover:bg-surface-2" aria-label={`Sponsored: ${card.headline}. ${card.title}`} data-sponsored="">
      <span className="h-9 w-9 rounded-xl bg-paper-2 text-ink-2 inline-flex items-center justify-center shrink-0" aria-hidden>
        <Megaphone size={16} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Sponsored</span>
        <span className="block font-semibold leading-snug">{card.headline}</span>
        {card.body ? <span className="block text-sm text-ink-2">{card.body}</span> : null}
        <span className="block text-xs text-muted mt-0.5 truncate">{card.title} · {card.subtitle}</span>
      </span>
    </Link>
  );
}
