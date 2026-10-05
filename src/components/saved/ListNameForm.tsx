"use client";
import { useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/Button";
import { FieldError, Input } from "@/components/ui/Field";
import { SAVED_LIST_NAME_MAX } from "@/lib/data/savedLists";
import type { ActionResult } from "@/server/actions/result";

/**
 * One name field and a submit button, for creating and renaming lists. The
 * server normalizes and checks the name (blank, too long, already taken) and
 * its message lands under the field.
 */
export function ListNameForm({
  initial = "",
  submitLabel,
  placeholder = "e.g. Date night, Rainy day",
  onSubmit,
  onDone,
  compact = false,
}: {
  initial?: string;
  submitLabel: string;
  placeholder?: string;
  onSubmit: (name: string) => Promise<ActionResult<unknown>>;
  onDone?: () => void;
  compact?: boolean;
}) {
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    start(async () => {
      const result = await onSubmit(name);
      if (!result.ok) {
        setError(result.fieldErrors?.name ?? result.error);
        return;
      }
      setError(null);
      if (!initial) setName("");
      onDone?.();
    });
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-1.5" noValidate>
      <div className={compact ? "flex gap-2" : "flex flex-col gap-3"}>
        <Input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder={placeholder}
          maxLength={SAVED_LIST_NAME_MAX + 20}
          aria-label="List name"
          error={error ?? undefined}
          autoFocus={!compact}
          className={compact ? "flex-1 min-w-0" : undefined}
        />
        <Button type="submit" variant="ink" loading={pending} disabled={!name.trim()}>
          {submitLabel}
        </Button>
      </div>
      <FieldError>{error ?? undefined}</FieldError>
    </form>
  );
}
