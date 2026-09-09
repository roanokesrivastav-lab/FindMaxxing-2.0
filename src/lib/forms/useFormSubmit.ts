"use client";
import { startTransition, useCallback, useEffect, useRef, type FormEvent } from "react";
import type { ActionResult } from "@/server/actions/result";

/**
 * Submits a server action without letting React reset the form.
 *
 * React 19 clears every uncontrolled field after a `<form action={fn}>` action
 * settles, including when it returns a validation error. That silently destroys
 * whatever the user typed and wipes the FileList behind the photo picker.
 * Calling the action inside a transition from `onSubmit` keeps the DOM intact,
 * so a failed submit leaves the form exactly as the user left it.
 *
 * Also moves focus to the first field the server complained about, since the
 * submit button sits in a sticky bar and the failing field is often off-screen.
 */
export function useFormSubmit(
  action: (formData: FormData) => void,
  state: ActionResult | null,
  options: { onBeforeSubmit?: (formData: FormData) => void } = {},
) {
  const { onBeforeSubmit } = options;
  const formRef = useRef<HTMLFormElement>(null);
  const handledState = useRef<ActionResult | null>(null);

  const onSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const formData = new FormData(form);
      onBeforeSubmit?.(formData);
      startTransition(() => action(formData));
    },
    [action, onBeforeSubmit],
  );

  useEffect(() => {
    if (!state || state === handledState.current) return;
    handledState.current = state;
    if (state.ok) return;

    const firstField = Object.keys(state.fieldErrors ?? {})[0];
    if (!firstField) return;

    const form = formRef.current;
    if (!form) return;

    // Named inputs first; the pickers are not inputs, so they carry data-field.
    const target =
      form.querySelector<HTMLElement>(`[name="${CSS.escape(firstField)}"]`) ??
      form.querySelector<HTMLElement>(`[data-field="${CSS.escape(firstField)}"]`);
    if (!target) return;

    target.scrollIntoView({ behavior: "smooth", block: "center" });
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) {
      target.focus({ preventScroll: true });
    }
  }, [state]);

  return { formRef, onSubmit };
}
