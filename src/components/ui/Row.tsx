import Link from "next/link";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils/cn";
import { PlaceGlyph } from "@/components/ui/PlaceGlyph";

/**
 * A comparable item on a flat surface (roadmap 1.1): optional media, title, meta
 * line, trailing slot. Photography-led: a photo leads when there is one, and the
 * PlaceGlyph stands in when there isn't, so the row is complete either way.
 * Long titles wrap (two lines, then clamp). At large text sizes (200%) the row wraps:
 * the text block moves under the media rather than shrinking to a few characters.
 */
export type RowMedia = { photo: { src: string; alt: string } } | { categorySlug: string };

export function Row({
  title,
  meta,
  trailing,
  media,
  href,
  as: Tag = "div",
  className,
}: {
  title: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  media?: RowMedia;
  href?: string;
  as?: "div" | "li";
  className?: string;
}) {
  const body = (
    <>
      {media ? (
        "photo" in media ? (
          // Plain <img>, as elsewhere in the app (photos are pre-sized; see README "Images").
          // eslint-disable-next-line @next/next/no-img-element
          <img src={media.photo.src} alt={media.photo.alt} className="h-14 w-14 shrink-0 rounded-xl object-cover bg-paper-2" loading="lazy" />
        ) : (
          <PlaceGlyph categorySlug={media.categorySlug} size={56} />
        )
      ) : null}
      {/* basis 10rem: at large text sizes the text block drops under the media instead of being squeezed. */}
      <span className="flex min-w-0 flex-1 basis-[10rem] flex-col gap-hair">
        <span className="type-item-title text-ink line-clamp-2 break-words">{title}</span>
        {meta ? <span className="type-body text-ink-2 break-words">{meta}</span> : null}
      </span>
      {trailing ? <span className="type-body shrink-0 text-ink-2">{trailing}</span> : null}
    </>
  );
  const rowClass = "flex flex-wrap items-center gap-x-row gap-y-item py-row";
  return (
    <Tag data-row="" className={cn("surface-flat", className)}>
      {href ? (
        <Link href={href} className={cn(rowClass, "rounded-xl hover:bg-paper-2/60")}>
          {body}
        </Link>
      ) : (
        <div className={rowClass}>{body}</div>
      )}
    </Tag>
  );
}
