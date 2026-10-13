"use client";
import { useEffect, useState } from "react";

/** The saved-list pages this device has a copy of (read from the service worker's cache). */
export function OfflineLists() {
  const [paths, setPaths] = useState<string[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!("caches" in window)) return [];
      const names = (await caches.keys()).filter((k) => k.startsWith("fm-pages-"));
      const keys = (await Promise.all(names.map(async (n) => (await (await caches.open(n)).keys()).map((r) => new URL(r.url).pathname)))).flat();
      return [...new Set(keys)].sort();
    })().then((p) => {
      if (!cancelled) setPaths(p ?? []);
    }, () => !cancelled && setPaths([]));
    return () => {
      cancelled = true;
    };
  }, []);
  if (paths === null) return null;
  if (!paths.length) return <p className="text-sm text-muted mt-4">None yet: open Saved while online and it will be here next time.</p>;
  return (
    <ul className="card divide-y divide-line mt-4 text-left">
      {paths.map((p) => (
        <li key={p}>
          {/* Plain links: a full navigation lets the service worker answer from its copy. */}
          <a href={p} className="block px-4 py-3 font-semibold hover:bg-surface-2">{p === "/saved" ? "All saved places" : "A saved list"}</a>
        </li>
      ))}
    </ul>
  );
}
