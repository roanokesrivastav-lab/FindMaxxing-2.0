import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/AuthShell";
import { ConfirmEmailLinkForm } from "@/components/auth/ConfirmEmailLinkForm";
import { parseEmailLink } from "@/lib/auth/emailLink";

export const metadata: Metadata = { title: "Confirm", robots: { index: false } };
export const dynamic = "force-dynamic";

const COPY = {
  email: { title: "Confirm your email", subtitle: "One tap and you're in.", label: "Confirm email" },
  recovery: { title: "Reset your password", subtitle: "Continue to choose a new password.", label: "Continue" },
  email_change: { title: "Confirm your new email", subtitle: "Finish switching your account's email address.", label: "Confirm new email" },
} as const;

/**
 * Landing page for token-hash email links. Opening it changes nothing: the
 * token is spent only when the person presses the button.
 */
export default async function ConfirmPage({ searchParams }: PageProps<"/auth/confirm">) {
  const sp = await searchParams;
  const link = parseEmailLink({ tokenHash: sp.token_hash, type: sp.type, next: sp.next });
  if (!link) {
    return (
      <AuthShell title="That link didn't work" subtitle="It may be incomplete, expired or already used.">
        <p className="text-sm text-ink-2">
          If you already confirmed your email,{" "}
          <Link href="/auth/sign-in" className="font-semibold text-ink underline underline-offset-4">sign in</Link>. To reset a password,{" "}
          <Link href="/auth/forgot" className="font-semibold text-ink underline underline-offset-4">request a new link</Link>.
        </p>
      </AuthShell>
    );
  }
  const copy = COPY[link.type];
  return (
    <AuthShell title={copy.title} subtitle={copy.subtitle}>
      <ConfirmEmailLinkForm link={link} label={copy.label} />
    </AuthShell>
  );
}
