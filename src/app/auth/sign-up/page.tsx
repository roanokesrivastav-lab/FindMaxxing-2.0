import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/server";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignUpForm } from "@/components/auth/AuthForms";
import { safeAuthNext } from "@/lib/auth/redirect";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

export default async function SignUpPage({ searchParams }: PageProps<"/auth/sign-up">) {
  const [sp, viewer] = await Promise.all([searchParams, getViewer()]);
  const next = safeAuthNext(sp.next, "/welcome");
  if (viewer) redirect(next);
  return (
    <AuthShell title="Find your people" subtitle="Local knowledge, mapped. Free, no ads, no tourists.">
      <SignUpForm next={next} />
    </AuthShell>
  );
}
