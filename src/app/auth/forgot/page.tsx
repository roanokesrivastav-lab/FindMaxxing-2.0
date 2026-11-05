import type { Metadata } from "next";
import { getDataMode } from "@/lib/config";
import { AuthShell } from "@/components/auth/AuthShell";
import { ForgotPasswordForm } from "@/components/auth/PasswordForms";

export const metadata: Metadata = { title: "Reset your password" };
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <AuthShell title="Forgot your password?" subtitle="Enter your email and we'll send a link to choose a new one.">
      <ForgotPasswordForm demo={getDataMode() === "demo"} />
    </AuthShell>
  );
}
