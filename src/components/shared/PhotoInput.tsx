"use client";
import { ImagePlus, X } from "lucide-react";
import { useRef, useState } from "react";
import { FieldError, FieldLabel } from "@/components/ui/Field";
import { IMAGE_TYPES, isAllowedImage } from "@/lib/validation/schemas";
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

  const onChange = (file: File | undefined) => {
    setLocalError(null);
    if (!file) {
      setPreview(currentUrl ?? null);
      return;
    }
    const problem = isAllowedImage(file);
    if (problem) {
      setLocalError(problem);
      if (inputRef.current) inputRef.current.value = "";
      return;
    }
    setPreview(URL.createObjectURL(file));
  };

  const clear = () => {
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
          <input
            ref={inputRef}
            type="file"
            name={name}
            accept={IMAGE_TYPES.join(",")}
            className="sr-only"
            onChange={(e) => onChange(e.target.files?.[0])}
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
