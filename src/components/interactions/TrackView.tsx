"use client";

import { useEffect } from "react";
import { logItemAction } from "@/server/actions/interactions";

/** Records one view of a detail page when it mounts (signed-in viewers only; the server decides the rest). */
export function TrackView({ kind, id }: { kind: "place" | "event"; id: string }) {
  useEffect(() => {
    void logItemAction(kind, id, "view").catch(() => undefined);
  }, [kind, id]);
  return null;
}

/** The Directions link, recording that the viewer asked for directions. */
export function DirectionsLink({ kind, id, href, children, className }: { kind: "place" | "event"; id: string; href: string; children: React.ReactNode; className?: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={className}
      data-active="true"
      onClick={() => void logItemAction(kind, id, "directions").catch(() => undefined)}
    >
      {children}
    </a>
  );
}
