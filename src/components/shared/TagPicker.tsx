"use client";
import { useState } from "react";
import { INTERESTS } from "@/lib/data/taxonomy";
import { Chip } from "@/components/ui/Chip";
import { FieldError, FieldLabel } from "@/components/ui/Field";

export function TagPicker({
  name,
  label = "Tags",
  hint,
  initial = [],
  max = 8,
  error,
}: {
  name: string;
  label?: string;
  hint?: string;
  initial?: string[];
  max?: number;
  error?: string;
}) {
  const [selected, setSelected] = useState<string[]>(initial);
  const toggle = (slug: string) =>
    setSelected((s) => (s.includes(slug) ? s.filter((x) => x !== slug) : s.length >= max ? s : [...s, slug]));
  return (
    <div data-field={name}>
      <FieldLabel hint={hint ?? `${selected.length}/${max}`}>{label}</FieldLabel>
      <div className="flex flex-wrap gap-2">
        {INTERESTS.map((i) => (
          <Chip key={i.slug} active={selected.includes(i.slug)} onClick={() => toggle(i.slug)}>
            <span aria-hidden>{i.emoji}</span> {i.label}
          </Chip>
        ))}
      </div>
      {selected.map((s) => (
        <input key={s} type="hidden" name={name} value={s} />
      ))}
      <FieldError>{error}</FieldError>
    </div>
  );
}
