"use client";
import { useEffect, useRef, type RefObject } from "react";

/**
 * Holds back the owning form's submission while `busy` (e.g. photos are still
 * being shrunk in the browser), so the form never submits without files the
 * user already picked.
 *
 * A native listener on the <form> itself: it runs before the event bubbles to
 * React's root listener, so stopping it there blocks both `onSubmit` handlers
 * (useFormSubmit) and `<form action>` actions, whatever triggered the submit.
 */
export function useHoldSubmit(fieldRef: RefObject<HTMLElement | null>, busy: boolean, onHeld: () => void) {
  const state = useRef({ busy, onHeld });
  useEffect(() => {
    state.current = { busy, onHeld };
  });

  useEffect(() => {
    const form = fieldRef.current?.closest("form");
    if (!form) return;
    const onSubmit = (event: SubmitEvent) => {
      if (!state.current.busy) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      state.current.onHeld();
    };
    form.addEventListener("submit", onSubmit);
    return () => form.removeEventListener("submit", onSubmit);
  }, [fieldRef]);
}
