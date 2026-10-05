"use client";
import { ImagePlus, Loader2, X } from "lucide-react";
import { useRef, useState } from "react";
import { FieldError, FieldLabel } from "@/components/ui/Field";
import { IMAGE_ORIGINAL_MAX_BYTES, IMAGE_TYPES, isAllowedImage } from "@/lib/validation/schemas";
import { useHoldSubmit } from "@/lib/forms/useHoldSubmit";
import { shrinkForUpload } from "@/lib/images/client";
import { cn } from "@/lib/utils/cn";

export function PhotoInput({
  name,
  label = "Photo",
  hint = "optional",
  error,
  shape = "wide",
  currentUrl,
}: {
  name: string;
  label?: string;
  hint?: string;
  error?: string;
  shape?: "wide" | "round";
  currentUrl?: string | null;
}) {
  const [preview, setPreview] = useState<string | null>(currentUrl ?? null);
  const [localError, setLocalError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [preparing, setPreparing] = useState(false);
  // Only the latest pick may write back: an earlier, slower shrink must not replace it.
  const pick = useRef(0);

  // Submitting now would send the original, or nothing, instead of the shrunk photo.
  useHoldSubmit(inputRef, preparing, () => setLocalError("The photo is still being prepared. Try again in a moment."));

  const reject = (problem: string) => {
    setLocalError(problem);
    setPreview(currentUrl ?? null);
    if (inputRef.current) inputRef.current.value = "";
  };

  const onChange = async (file: File | undefined) => {
    const token = ++pick.current;
    setLocalError(null);
    if (!file) {
      setPreparing(false);
      setPreview(currentUrl ?? null);
      return;
    }
    // The original may be large: it only has to fit once shrunk.
    const problem = isAllowedImage(file, IMAGE_ORIGINAL_MAX_BYTES);
    if (problem) {
      setPreparing(false);
      return reject(problem);
    }
    setPreparing(true);
    const shrunk = await shrinkForUpload(file);
    if (token !== pick.current) return;
    setPreparing(false);
    const tooBig = isAllowedImage(shrunk);
    if (tooBig) return reject(tooBig);
    // Send the shrunk copy: swap it into the input the form submits.
    if (shrunk !== file && inputRef.current) {
      const dt = new DataTransfer();
      dt.items.add(shrunk);
      inputRef.current.files = dt.files;
    }
    setPreview(URL.createObjectURL(shrunk));
  };

  const clear = () => {
    pick.current += 1;
    setPreparing(false);
    if (inputRef.current) inputRef.current.value = "";
    setPreview(currentUrl ?? null);
  };

  return (
    <div>
      <FieldLabel hint={hint}>{label}</FieldLabel>
      <div className={cn("relative", shape === "round" ? "w-28 h-28" : "w-full aspect-[16/9]")}>
        <label
          className={cn(
            "absolute inset-0 flex flex-col items-center justify-center gap-1.5 border-2 border-dashed border-line-2 bg-surface-2 text-muted cursor-pointer hover:border-ink hover:text-ink transition-colors overflow-hidden",
            shape === "round" ? "rounded-full" : "rounded-2xl",
          )}
        >
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="Preview" className="absolute inset-0 w-full h-full object-cover" />
          ) : (
            <>
              <ImagePlus size={shape === "round" ? 20 : 26} />
              {shape === "wide" ? <span className="text-sm font-semibold">Add a photo</span> : null}
            </>
          )}
          {preparing ? (
            <span className="absolute inset-0 flex items-center justify-center gap-1.5 bg-surface-2/80 text-xs font-semibold text-muted" aria-live="polite">
              <Loader2 size={14} className="animate-spin" /> Preparing
            </span>
          ) : null}
          <input
            ref={inputRef}
            type="file"
            name={name}
            accept={IMAGE_TYPES.join(",")}
            className="sr-only"
            onChange={(e) => void onChange(e.target.files?.[0])}
          />
        </label>
        {preview && preview !== currentUrl ? (
          <button
            type="button"
            onClick={clear}
            className="absolute top-2 right-2 h-8 w-8 rounded-full bg-ink/80 text-white inline-flex items-center justify-center"
            aria-label="Remove photo"
          >
            <X size={16} />
          </button>
        ) : null}
      </div>
      <FieldError>{localError ?? error}</FieldError>
    </div>
  );
}
