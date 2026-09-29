"use client";
import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import type { Page, Place } from "@/lib/data/types";
import { Input } from "@/components/ui/Field";
import { getJson } from "@/components/shared/getJson";

export interface PlaceOption {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  categorySlug: string;
  city?: string;
}

export const toPlaceOption = (p: Place): PlaceOption => ({
  id: p.id,
  name: p.name,
  lat: p.lat,
  lng: p.lng,
  address: p.address,
  categorySlug: p.categorySlug,
  city: p.city,
});

const RESULTS = 20;
const DEBOUNCE_MS = 250;

/**
 * Search-as-you-type place selector. Queries /api/discover/places instead of
 * shipping every place to the browser; with nothing typed it lists the newest.
 * Submits the chosen place's id as `placeId` (empty for "somewhere else").
 */
export function PlacePicker({
  id,
  name,
  value,
  onChange,
  describedBy,
}: {
  id: string;
  name: string;
  value: PlaceOption | null;
  onChange: (place: PlaceOption | null) => void;
  describedBy?: string;
}) {
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [results, setResults] = useState<PlaceOption[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setStatus("loading");
      try {
        const q = new URLSearchParams({ limit: String(RESULTS) });
        if (text.trim()) q.set("q", text.trim());
        const page = await getJson<Page<Place>>(`/api/discover/places?${q}`, controller.signal);
        if (controller.signal.aborted) return;
        setResults(page.items.map(toPlaceOption));
        setStatus("idle");
      } catch {
        if (controller.signal.aborted) return;
        setStatus("error");
      }
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [open, text, attempt]);

  const choose = (place: PlaceOption | null) => {
    onChange(place);
    setText("");
    setOpen(false);
  };

  return (
    <div className="flex flex-col gap-2">
      <input type="hidden" name={name} value={value?.id ?? ""} />
      {value ? (
        <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface px-3 py-2.5">
          <span className="font-semibold truncate">{value.name}</span>
          <button type="button" className="text-xs font-semibold text-flare-600 shrink-0" onClick={() => choose(null)}>
            Somewhere else
          </button>
        </div>
      ) : (
        <>
          <Input
            id={id}
            type="search"
            role="combobox"
            aria-expanded={open}
            aria-controls={`${id}-results`}
            aria-describedby={describedBy}
            autoComplete="off"
            value={text}
            placeholder="Search places, or leave blank to set your own below"
            onFocus={() => setOpen(true)}
            onChange={(e) => {
              setText(e.target.value);
              setOpen(true);
            }}
          />
          {open ? (
            <div id={`${id}-results`} role="listbox" aria-label="Places" className="rounded-xl border border-line bg-surface max-h-64 overflow-y-auto">
              {results.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  className="w-full text-left px-3 py-2 text-sm hover:bg-surface-2 flex flex-col"
                  onClick={() => choose(p)}
                >
                  <span className="font-semibold">{p.name}</span>
                  {p.address ? <span className="text-xs text-muted truncate">{p.address}</span> : null}
                </button>
              ))}
              {status === "loading" ? (
                <p className="px-3 py-2 text-xs text-muted inline-flex items-center gap-1">
                  <Loader2 size={12} className="animate-spin" /> Searching
                </p>
              ) : null}
              {status === "idle" && results.length === 0 ? <p className="px-3 py-2 text-xs text-muted">No places match. Set the location below.</p> : null}
              {status === "error" ? (
                <p className="px-3 py-2 text-xs text-danger" role="alert">
                  Couldn&apos;t load places.{" "}
                  <button type="button" className="font-semibold underline" onClick={() => setAttempt((n) => n + 1)}>
                    Retry
                  </button>
                </p>
              ) : null}
              <button type="button" className="w-full text-left px-3 py-2 text-xs font-semibold text-muted border-t border-line hover:bg-surface-2" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
