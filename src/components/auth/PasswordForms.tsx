"use client";
import Link from "next/link";
import { useActionState } from "react";
import { MailCheck } from "lucide-react";
import { useFormSubmit } from "@/lib/forms/useFormSubmit";
import { requestPasswordResetAction, resetPasswordAction } from "@/server/actions/account";
import { Button } from "@/components/ui/Button";
import { FormField, Input } from "@/components/ui/Field";
import type { ActionResult } from "@/server/actions/result";

export function ForgotPasswordForm({ demo }: { demo: boolean }) {
  const [state, action, pending] = useActionState(requestPasswordResetAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const { formRef, onSubmit } = useFormSubmit(action, state as ActionResult | null);

  if (state?.ok) {
    return (
      <div className="flex flex-col items-center gap-2 text-center" role="status">
        <MailCheck className="text-moss" size={32} />
        <h2 className="font-bold text-lg">Check your email</h2>
        <p className="text-sm text-muted">If an account uses that address, we sent it a link to choose a new password. The link works once, for an hour.</p>
        {demo && state.data.demoLink ? (
          <div className="mt-3 w-full rounded-xl bg-surface-2 p-3 text-left">
            <p className="text-xs font-bold uppercase tracking-wider text-muted">Demo mode · no email is sent</p>
            <Link href={state.data.demoLink} className="mt-1 block text-sm font-semibold underline underline-offset-4 break-all">
              Open the reset link
            </Link>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      <FormField label="Email" htmlFor="email" error={errors.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required error={errors.email} />
      </FormField>
      {state && !state.ok && !Object.keys(errors).length ? (
        <p className="text-sm text-danger font-medium" role="alert">{state.error}</p>
      ) : null}
      <Button type="submit" size="lg" variant="ink" loading={pending} className="w-full">
        Send reset link
      </Button>
      <p className="text-sm text-muted text-center">
        Remembered it?{" "}
        <Link href="/auth/sign-in" className="font-semibold text-ink underline underline-offset-4">Sign in</Link>
      </p>
    </form>
  );
}

export function ResetPasswordForm({ token }: { token: string | null }) {
  const [state, action, pending] = useActionState(resetPasswordAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const { formRef, onSubmit } = useFormSubmit(action, state);
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      {token ? <input type="hidden" name="token" value={token} /> : null}
      <FormField label="New password" htmlFor="password" hint="8+ characters" error={errors.password}>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} error={errors.password} />
      </FormField>
      <FormField label="Type it again" htmlFor="confirm" error={errors.confirm}>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required minLength={8} error={errors.confirm} />
      </FormField>
      {state && !state.ok && !Object.keys(errors).length ? (
        <p className="text-sm text-danger font-medium" role="alert">
          {state.error}{" "}
          <Link href="/auth/forgot" className="underline underline-offset-4">Request a new link</Link>
        </p>
      ) : null}
      <Button type="submit" size="lg" variant="ink" loading={pending} className="w-full">
        Save new password
      </Button>
    </form>
  );
}
