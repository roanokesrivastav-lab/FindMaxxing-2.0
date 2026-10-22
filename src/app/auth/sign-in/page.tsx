import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/auth/server";
import { getDataMode } from "@/lib/config";
import { AuthShell } from "@/components/auth/AuthShell";
import { DemoPersonas, SignInForm } from "@/components/auth/AuthForms";
import { SEED_USERS } from "@/lib/seed/seed-data";
import { safeAuthNext } from "@/lib/auth/redirect";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: PageProps<"/auth/sign-in">) {
  const [sp, viewer] = await Promise.all([searchParams, getViewer()]);
  const next = safeAuthNext(sp.next);
  if (viewer) redirect(next);
  const demo = getDataMode() === "demo";
  return (
    <AuthShell
      title="Welcome back"
      subtitle="Sign in to save, contribute and join."
      aside={
        demo ? (
          <div className="mt-6">
            <p className="text-xs font-bold uppercase tracking-wider text-muted mb-2">Demo mode · pick a persona</p>
            <DemoPersonas
              personas={SEED_USERS.slice(0, 4).map((u) => ({ email: u.email, displayName: u.displayName, username: u.username, bio: u.bio }))}
              next={next}
            />
            <p className="mt-3 text-xs text-muted">
              Or use any seeded email (e.g. <code>maya@example.com</code>) with password <code>findmaxxing</code>.
            </p>
          </div>
        ) : null
      }
    >
      {sp.error === "callback" ? <p className="mb-3 text-sm text-danger font-medium">That link couldn&apos;t sign you in here. If you opened it on another device or browser, your email may already be confirmed: sign in with your password.</p> : null}
      <SignInForm next={next} />
    </AuthShell>
  );
}
