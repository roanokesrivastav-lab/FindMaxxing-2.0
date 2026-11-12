"use client";

import { useState } from "react";
import { readableInk } from "@/lib/utils/contrast";
import { InterestIcon } from "@/components/ui/TaxonomyIcon";

/**
 * The small picture at the start of an interest row (roadmap 1.2). A photo when
 * one is supplied and loads; otherwise a tinted glyph tile in the PlaceGlyph
 * style, so the row is complete either way. Decorative: the row's label names
 * the interest.
 */
export function InterestThumb({ slug, src, color, size = 48 }: { slug: string; src?: string | null; color: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (src && !failed) {
    return (
      // Plain <img>, as elsewhere in the app (thumbnails are pre-sized).
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        data-thumb="photo"
        className="shrink-0 rounded-xl object-cover bg-paper-2"
        style={{ width: size, height: size }}
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span
      data-thumb="glyph"
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-xl"
      style={{ width: size, height: size, background: `${color}1f`, color: readableInk(color) }}
    >
      <InterestIcon slug={slug} size={Math.round(size * 0.45)} />
    </span>
  );
}
