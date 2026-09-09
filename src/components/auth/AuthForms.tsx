"use client";
import Link from "next/link";
import { useActionState } from "react";
import { useFormSubmit } from "@/lib/forms/useFormSubmit";
import { signInAction, signUpAction, demoQuickSignInAction } from "@/server/actions/auth";
import { Button } from "@/components/ui/Button";
import { FormField, Input } from "@/components/ui/Field";
import { Avatar } from "@/components/ui/Avatar";
import { MailCheck } from "lucide-react";

export function SignInForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signInAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const { formRef, onSubmit } = useFormSubmit(action, state);
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <FormField label="Email" htmlFor="email" error={errors.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required error={errors.email} />
      </FormField>
      <FormField label="Password" htmlFor="password" error={errors.password}>
        <Input id="password" name="password" type="password" autoComplete="current-password" required error={errors.password} />
      </FormField>
      {state && !state.ok && !Object.keys(errors).length ? (
        <p className="text-sm text-danger font-medium" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" size="lg" variant="ink" loading={pending} className="w-full mt-1">
        Sign in
      </Button>
      <p className="text-sm text-muted text-center">
        New here?{" "}
        <Link href={`/auth/sign-up?next=${encodeURIComponent(next)}`} className="font-semibold text-ink underline underline-offset-4">
          Create an account
        </Link>
      </p>
    </form>
  );
}

export function SignUpForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState(signUpAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const { formRef, onSubmit } = useFormSubmit(action, state);

  if (state?.ok) {
    return (
      <div className="card p-6 text-center flex flex-col items-center gap-2">
        <MailCheck className="text-moss" size={32} />
        <h2 className="font-bold text-lg">Check your email</h2>
        <p className="text-sm text-muted">We sent a confirmation link. Open it to finish creating your account.</p>
      </div>
    );
  }

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="next" value={next} />
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Display name" htmlFor="displayName" error={errors.displayName}>
          <Input id="displayName" name="displayName" autoComplete="name" required maxLength={50} error={errors.displayName} />
        </FormField>
        <FormField label="Username" htmlFor="username" error={errors.username}>
          <Input id="username" name="username" autoComplete="username" required minLength={3} maxLength={24} pattern="[a-zA-Z0-9_]+" error={errors.username} />
        </FormField>
      </div>
      <FormField label="Email" htmlFor="email" error={errors.email}>
        <Input id="email" name="email" type="email" autoComplete="email" required error={errors.email} />
      </FormField>
      <FormField label="Password" htmlFor="password" hint="8+ characters" error={errors.password}>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={8} error={errors.password} />
      </FormField>
      {state && !state.ok && !Object.keys(errors).length ? (
        <p className="text-sm text-danger font-medium" role="alert">
          {state.error}
        </p>
      ) : null}
      <Button type="submit" size="lg" loading={pending} className="w-full mt-1">
        Create account
      </Button>
      <p className="text-sm text-muted text-center">
        Already have one?{" "}
        <Link href={`/auth/sign-in?next=${encodeURIComponent(next)}`} className="font-semibold text-ink underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function DemoPersonas({ personas, next }: { personas: { email: string; displayName: string; username: string; bio: string }[]; next: string }) {
  return (
    <div className="flex flex-col gap-2">
      {personas.map((p) => (
        <form key={p.email} action={demoQuickSignInAction}>
          <input type="hidden" name="email" value={p.email} />
          <input type="hidden" name="next" value={next} />
          <button type="submit" className="w-full card flex items-center gap-3 p-3 text-left hover:bg-surface-2 transition-colors active:scale-[0.99]">
            <Avatar name={p.displayName} size={38} />
            <span className="min-w-0 flex-1">
              <span className="block font-semibold text-sm truncate">
                {p.displayName} <span className="text-muted font-medium">@{p.username}</span>
              </span>
              <span className="block text-xs text-muted truncate">{p.bio}</span>
            </span>
          </button>
        </form>
      ))}
    </div>
  );
}
