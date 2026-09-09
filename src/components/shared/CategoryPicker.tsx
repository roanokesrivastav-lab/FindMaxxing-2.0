"use client";
import { useState } from "react";
import type { Category } from "@/lib/data/taxonomy";
import { FieldError, FieldLabel } from "@/components/ui/Field";
import { cn } from "@/lib/utils/cn";

export function CategoryPicker({
  name,
  categories,
  initial,
  error,
  label = "Category",
}: {
  name: string;
  categories: Category[];
  initial?: string;
  error?: string;
  label?: string;
}) {
  const [value, setValue] = useState<string | undefined>(initial);
  return (
    <div data-field={name}>
      <FieldLabel>{label}</FieldLabel>
      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
        {categories.map((c) => {
          const active = value === c.slug;
          return (
            <button
              key={c.slug}
              type="button"
              onClick={() => setValue(c.slug)}
              aria-pressed={active}
              className={cn(
                "flex flex-col items-center gap-1 rounded-2xl border px-2 py-3 text-xs font-semibold transition-all active:scale-95",
                active ? "text-white border-transparent shadow-card" : "bg-surface border-line text-ink-2 hover:bg-surface-2",
              )}
              style={active ? { background: c.color } : undefined}
            >
              <span className="text-xl leading-none" aria-hidden>
                {c.emoji}
              </span>
              <span className="leading-tight text-center">{c.label}</span>
            </button>
          );
        })}
      </div>
      {value ? <input type="hidden" name={name} value={value} /> : null}
      <FieldError>{error}</FieldError>
    </div>
  );
}
