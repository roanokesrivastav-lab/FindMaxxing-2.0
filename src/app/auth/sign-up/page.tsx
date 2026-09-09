import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/server";
import { AuthShell } from "@/components/auth/AuthShell";
import { SignUpForm } from "@/components/auth/AuthForms";

export const metadata: Metadata = { title: "Create account" };
export const dynamic = "force-dynamic";

function safeNext(v: unknown): string {
  return typeof v === "string" && v.startsWith("/") && !v.startsWith("//") ? v : "/profile/edit?welcome=1";
}

export default async function SignUpPage({ searchParams }: PageProps<"/auth/sign-up">) {
  const [sp, viewer] = await Promise.all([searchParams, getViewer()]);
  const next = safeNext(sp.next);
  if (viewer) redirect(next);
  return (
    <AuthShell title="Find your people" subtitle="Local knowledge, mapped. Free, no ads, no tourists.">
      <SignUpForm next={next} />
    </AuthShell>
  );
}
