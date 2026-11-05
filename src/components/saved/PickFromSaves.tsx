"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Navigation, Shuffle } from "lucide-react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Surface } from "@/components/ui/Surface";
import { PlaceGlyph } from "@/components/ui/PlaceGlyph";
import { useToast } from "@/components/ui/Toast";
import { pickFromSavesAction, type PickView } from "@/server/actions/saves";
import { getCategory } from "@/lib/data/taxonomy";
import { photoSrc } from "@/lib/images/sizes";
import { pluralize } from "@/lib/utils/format";

/**
 * "Pick somewhere from my saves" (3.6): one place from the viewer's own saves under the
 * library filters currently applied, a random pick that does not repeat until every
 * match was shown, with Pick again, Open and Directions.
 */
export function PickFromSaves({ filters, filtered }: { filters: { q: string; tag: string | null; status: string | null; category: string | null }; filtered: boolean }) {
  const [result, setResult] = useState<PickView | null>(null);
  const [round, setRound] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const { toast } = useToast();

  // Not `loading`: a disabled button drops keyboard focus, and "Pick again" should keep it.
  const pick = () => {
    if (pending) return;
    start(async () => {
      const res = await pickFromSavesAction(filters, round);
      if (!res.ok) return toast(res.error, "error");
      setResult(res.data);
      if (res.data.kind === "picked") setRound(res.data.round);
    });
  };

  return (
    <div className="mt-row flex flex-col gap-item" data-pick="">
      <div>
        <Button type="button" variant={result?.kind === "picked" ? "secondary" : "ink"} size="md" onClick={pick} aria-busy={pending}>
          <Shuffle size={16} aria-hidden /> {result?.kind === "picked" ? "Pick again" : "Pick somewhere from my saves"}
        </Button>
        <p className="type-body text-ink-2 mt-hair">{filtered ? "Picks from the saves matching your filters." : "Picks from all your saves. Filter first to narrow it."}</p>
      </div>
      <div aria-live="polite">
        {result?.kind === "picked" ? (
          <Surface variant="raised" className="p-row flex flex-col gap-item" data-pick-result={result.place.id}>
            <div className="flex items-center gap-row">
              {result.place.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={photoSrc(result.place.photoUrl, "sm")} alt="" className="h-14 w-14 shrink-0 rounded-xl object-cover bg-paper-2" />
              ) : (
                <PlaceGlyph categorySlug={result.place.categorySlug} size={56} />
              )}
              <div className="min-w-0">
                <p className="type-item-title break-words">{result.place.name}</p>
                <p className="type-body text-ink-2">
                  {[getCategory(result.place.categorySlug).label, result.place.neighborhood].filter(Boolean).join(" · ")}
                </p>
                <p className="type-body text-ink-2">Picked at random from {pluralize(result.matches, "match", "matches")}.</p>
              </div>
            </div>
            <div className="flex flex-wrap gap-item">
              <Link href={`/places/${result.place.id}`} className={buttonClass("ink", "sm")}>Open</Link>
              <a href={`https://www.google.com/maps/dir/?api=1&destination=${result.place.lat},${result.place.lng}`} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
                <Navigation size={14} aria-hidden /> Directions
              </a>
            </div>
          </Surface>
        ) : result?.kind === "none" ? (
          <Surface variant="inset" className="p-row flex flex-col gap-item" data-pick-none="">
            <p className="type-body text-ink">Nothing in your saves matches these filters.</p>
            {result.widening ? (
              <Link href={result.widening.href} className={buttonClass("secondary", "sm")}>
                Try {result.widening.label} ({pluralize(result.widening.count, "place")})
              </Link>
            ) : null}
          </Surface>
        ) : result?.kind === "empty" ? (
          <p className="type-body text-ink-2">You have no saves to pick from yet.</p>
        ) : null}
      </div>
    </div>
  );
}
