"use client";
import Link from "next/link";
import { useActionState } from "react";
import { useFormSubmit } from "@/lib/forms/useFormSubmit";
import { confirmEmailLinkAction } from "@/server/actions/auth";
import { Button } from "@/components/ui/Button";
import type { EmailLink } from "@/lib/auth/emailLink";

export function ConfirmEmailLinkForm({ link, label }: { link: EmailLink; label: string }) {
  const [state, action, pending] = useActionState(confirmEmailLinkAction, null);
  const { formRef, onSubmit } = useFormSubmit(action, state);
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="token_hash" value={link.tokenHash} />
      <input type="hidden" name="type" value={link.type} />
      <input type="hidden" name="next" value={link.next} />
      {state && !state.ok ? (
        <p className="text-sm text-danger font-medium" role="alert">
          {state.error}{" "}
          <Link href="/auth/sign-in" className="font-semibold text-ink underline underline-offset-4">Sign in</Link>
        </p>
      ) : null}
      <Button type="submit" size="lg" variant="ink" loading={pending} className="w-full">
        {label}
      </Button>
    </form>
  );
}
