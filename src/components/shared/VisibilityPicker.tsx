"use client";
import { useState } from "react";
import { Globe, ShieldCheck } from "lucide-react";
import { FieldError, FieldLabel } from "@/components/ui/Field";
import { cn } from "@/lib/utils/cn";

const OPTIONS = [
  {
    value: "public",
    label: "Everyone",
    hint: "Anyone browsing the map can find it.",
    icon: Globe,
  },
  {
    value: "locals",
    label: "Locals only",
    hint: "Only people who call this city home, or who have added a place here, can see it.",
    icon: ShieldCheck,
  },
] as const;

/**
 * Trust-tier choice on the add-place form. Locals-only is the
 * protect-the-hidden-gem option: the rule for who qualifies is spelled out
 * rather than left implicit, because it decides who sees the contribution.
 */
export function VisibilityPicker({
  name = "visibility",
  initial = "public",
  error,
}: {
  name?: string;
  initial?: "public" | "locals";
  error?: string;
}) {
  const [value, setValue] = useState<"public" | "locals">(initial);
  const active = OPTIONS.find((o) => o.value === value);

  return (
    <div data-field={name}>
      <FieldLabel>Who can see it</FieldLabel>
      <div className="grid grid-cols-2 gap-2">
        {OPTIONS.map((o) => {
          const Icon = o.icon;
          const isActive = value === o.value;
          return (
            <button
              key={o.value}
              type="button"
              onClick={() => setValue(o.value)}
              aria-pressed={isActive}
              className={cn(
                "rounded-2xl border px-3 py-3 flex items-center gap-2.5 text-left transition-colors",
                isActive ? "bg-ink text-white border-ink" : "bg-surface border-line hover:bg-surface-2",
              )}
            >
              <Icon size={18} className="shrink-0" />
              <span className="text-sm font-semibold">{o.label}</span>
            </button>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted">{active?.hint}</p>
      <input type="hidden" name={name} value={value} />
      <FieldError>{error}</FieldError>
    </div>
  );
}
