"use client";
import { ImagePlus, Loader2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { FieldError, FieldLabel } from "@/components/ui/Field";
import { IMAGE_BATCH_MAX_BYTES, IMAGE_ORIGINAL_MAX_BYTES, IMAGE_TYPES, isAllowedImage } from "@/lib/validation/schemas";
import { useHoldSubmit } from "@/lib/forms/useHoldSubmit";
import { shrinkForUpload } from "@/lib/images/client";
import { MAX_PLACE_PHOTOS } from "@/lib/data/types";

interface Picked {
  file: File;
  url: string;
  key: string;
}

/**
 * Multi-file image picker for a place's gallery.
 *
 * A file input's own FileList can't be edited, so removing one preview would
 * otherwise be impossible. This keeps the chosen files in state and rewrites
 * the input's FileList through a DataTransfer, which keeps the whole thing
 * working inside a plain <form action> with no client-side submit handler.
 */
export function MultiPhotoInput({
  name = "photos",
  label = "Photos",
  hint,
  error,
  max = MAX_PLACE_PHOTOS,
}: {
  name?: string;
  label?: string;
  hint?: string;
  error?: string;
  max?: number;
}) {
  const [picked, setPicked] = useState<Picked[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const objectUrls = useRef(new Set<string>());
  // The latest picked list, for merging shrunk files that finish after other changes.
  const pickedRef = useRef(picked);
  useEffect(() => {
    pickedRef.current = picked;
  });

  // Submitting now would send the form without the photos still being shrunk.
  useHoldSubmit(inputRef, preparing > 0, () => setLocalError("Photos are still being prepared. Try again in a moment."));

  // Keep the real input in sync with our state so the form submits the right set.
  const syncFiles = useCallback(() => {
    if (!inputRef.current) return;
    const dt = new DataTransfer();
    for (const p of picked) dt.items.add(p.file);
    inputRef.current.files = dt.files;
  }, [picked]);

  useEffect(syncFiles, [syncFiles]);

  // A form reset clears the input's FileList while our previews stay on screen,
  // which would silently submit zero photos on the next attempt. Re-apply the
  // files whenever the owning form resets, whatever triggered it.
  useEffect(() => {
    const form = inputRef.current?.form;
    if (!form) return;
    const onReset = () => queueMicrotask(syncFiles);
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, [syncFiles]);

  // Release object URLs when the component goes away.
  useEffect(() => {
    const urls = objectUrls.current;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);

  const add = async (files: FileList | null) => {
    if (!files?.length) return;
    setLocalError(null);
    const incoming = Array.from(files);
    const room = max - picked.length - preparing;
    if (room <= 0) {
      setLocalError(`Up to ${max} photos`);
      return;
    }
    const candidates: { file: File; key: string }[] = [];
    const seen = new Set(picked.map((p) => p.key));
    for (const file of incoming.slice(0, room)) {
      // The original may be large: it only has to fit once shrunk (checked below).
      const problem = isAllowedImage(file, IMAGE_ORIGINAL_MAX_BYTES);
      if (problem) {
        setLocalError(problem);
        continue;
      }
      // Keyed on the original, so picking the same photo twice is still caught after shrinking.
      const key = `${file.name}-${file.size}-${file.lastModified}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({ file, key });
    }
    if (incoming.length > room) setLocalError(`Only the first ${room} added. Up to ${max} photos.`);
    if (!candidates.length) return;

    setPreparing((n) => n + candidates.length);
    const shrunk = await Promise.all(candidates.map(async (c) => ({ ...c, file: await shrinkForUpload(c.file) })));

    const next = [...pickedRef.current];
    let total = next.reduce((sum, p) => sum + p.file.size, 0);
    let problem: string | null = null;
    for (const c of shrunk) {
      if (next.length >= max || next.some((p) => p.key === c.key)) continue;
      const tooBig = isAllowedImage(c.file);
      if (tooBig) {
        problem = tooBig;
        continue;
      }
      // One submission carries every photo; past this the server would refuse the whole form.
      if (total + c.file.size > IMAGE_BATCH_MAX_BYTES) {
        problem = "Those photos are too large to send together. Remove one or pick smaller photos.";
        continue;
      }
      total += c.file.size;
      const url = URL.createObjectURL(c.file);
      objectUrls.current.add(url);
      next.push({ file: c.file, url, key: c.key });
    }
    pickedRef.current = next;
    setPicked(next);
    setPreparing((n) => n - candidates.length);
    if (problem) setLocalError(problem);
  };

  const remove = (key: string) => {
    setPicked((prev) => {
      const gone = prev.find((p) => p.key === key);
      if (gone) {
        URL.revokeObjectURL(gone.url);
        objectUrls.current.delete(gone.url);
      }
      return prev.filter((p) => p.key !== key);
    });
    setLocalError(null);
  };

  return (
    <div data-field={name}>
      <FieldLabel hint={hint ?? `${picked.length}/${max}`}>{label}</FieldLabel>

      <div className="grid grid-cols-3 gap-2">
        {picked.map((p) => (
          <div key={p.key} className="relative aspect-square rounded-xl overflow-hidden bg-surface-2 border border-line">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={p.url} alt="Selected" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={() => remove(p.key)}
              className="absolute top-1 right-1 h-7 w-7 rounded-full bg-ink/80 text-white inline-flex items-center justify-center"
              aria-label="Remove this photo"
            >
              <X size={14} />
            </button>
          </div>
        ))}

        {Array.from({ length: preparing }, (_, i) => (
          <div key={`preparing-${i}`} className="aspect-square rounded-xl bg-surface-2 border border-line text-muted flex flex-col items-center justify-center gap-1" aria-live="polite">
            <Loader2 size={18} className="animate-spin" />
            <span className="text-[11px] font-semibold">Preparing</span>
          </div>
        ))}

        {picked.length + preparing < max ? (
          <label className="aspect-square rounded-xl border-2 border-dashed border-line-2 bg-surface-2 text-muted hover:border-ink hover:text-ink transition-colors cursor-pointer flex flex-col items-center justify-center gap-1">
            <ImagePlus size={22} />
            <span className="text-[11px] font-semibold">Add</span>
            <input
              type="file"
              accept={IMAGE_TYPES.join(",")}
              multiple
              className="sr-only"
              onChange={(e) => {
                void add(e.target.files);
                e.target.value = "";
              }}
            />
          </label>
        ) : null}
      </div>

      {/* The field the form actually submits. */}
      <input ref={inputRef} type="file" name={name} accept={IMAGE_TYPES.join(",")} multiple className="sr-only" tabIndex={-1} aria-hidden />

      <FieldError>{localError ?? error}</FieldError>
    </div>
  );
}
