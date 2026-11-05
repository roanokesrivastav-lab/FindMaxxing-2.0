import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/AuthShell";
import { ResetPasswordForm } from "@/components/auth/PasswordForms";

export const metadata: Metadata = { title: "Choose a new password", robots: { index: false } };
export const dynamic = "force-dynamic";

/**
 * Reached from the reset email: Supabase's recovery link goes through
 * /auth/callback, which signs the user in for this one step. In demo mode the
 * link carries a one-time token instead. Validity is checked on submit, so the
 * page itself never says whether a link is real.
 */
export default async function ResetPasswordPage({ searchParams }: PageProps<"/auth/reset">) {
  const sp = await searchParams;
  const token = typeof sp.token === "string" ? sp.token : null;
  return (
    <AuthShell title="Choose a new password" subtitle="You'll be signed in once it's saved.">
      <ResetPasswordForm token={token} />
    </AuthShell>
  );
}
