"use client";

import { useActionState, useState } from "react";
import { Trash2 } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { FormField, Input } from "@/components/ui/Field";
import { useFormSubmit } from "@/lib/forms/useFormSubmit";
import { deleteAccountAction } from "@/server/actions/account";
import { forgetPrivatePages } from "@/components/pwa/RegisterServiceWorker";

/** Delete account, behind a confirmation that says exactly what goes and what stays. */
export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState(deleteAccountAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const { formRef, onSubmit } = useFormSubmit(action, state);
  return (
    <>
      <Button type="button" variant="danger" onClick={() => setOpen(true)}>
        <Trash2 size={16} /> Delete account
      </Button>
      <Sheet open={open} onClose={() => !pending && setOpen(false)} title="Delete your account?">
        <form ref={formRef} onSubmit={(e) => { void forgetPrivatePages(); onSubmit(e); }} className="flex flex-col gap-4 pt-2">
          <div className="text-sm leading-relaxed text-ink-2 flex flex-col gap-2">
            <p>This cannot be undone. Cleanup starts immediately and retries if a service is temporarily unavailable. Your account is closed to new contributions while cleanup runs.</p>
            <ul className="list-disc pl-5 flex flex-col gap-1">
              <li>your profile, interests and avatar</li>
              <li>every place and event you added, with their photos, ratings, saves and attendees</li>
              <li>photos you added to other people&apos;s places</li>
              <li>your ratings and reviews, saved places and lists</li>
              <li>who you follow, your followers, and the events you joined</li>
              <li>your messages, chats, blocks, notifications, devices, plan and sponsored cards</li>
            </ul>
            <p>Plus subscriptions are canceled so they stop renewing. Buyers of tickets to your future events are queued for refunds; refunds can take time to reach their bank.</p>
            <p>Reports you filed and historical payment records stay without your profile attached.</p>
          </div>
          <FormField label="Enter your password to confirm" htmlFor="delete-password" error={errors.password}>
            <Input id="delete-password" name="password" type="password" autoComplete="current-password" required error={errors.password} />
          </FormField>
          {state && !state.ok && !Object.keys(errors).length ? (
            <p className="text-sm text-danger font-medium" role="alert">{state.error}</p>
          ) : null}
          <div className="flex gap-2">
            <Button type="button" variant="secondary" className="flex-1" onClick={() => setOpen(false)}>{state && !state.ok && state.code === "unavailable" ? "Close" : "Keep my account"}</Button>
            <Button type="submit" variant="danger" className="flex-1" loading={pending}>Delete everything</Button>
          </div>
        </form>
      </Sheet>
    </>
  );
}
