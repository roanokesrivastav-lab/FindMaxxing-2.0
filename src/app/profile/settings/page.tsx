import type { Metadata } from "next";
import Link from "next/link";
import { KeyRound } from "lucide-react";
import { requireViewer } from "@/lib/auth/server";
import { PageHeader } from "@/components/ui/PageHeader";
import { BackButton } from "@/components/ui/BackButton";
import { DeleteAccount } from "@/components/profile/DeleteAccount";
import { AnalyticsToggle } from "@/components/profile/AnalyticsToggle";
import { getRepository } from "@/lib/data";
import { featureEnabled } from "@/lib/config";

export const metadata: Metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const viewer = await requireViewer("/profile/settings");
  const analytics = featureEnabled("analytics");
  const optedOut = analytics ? await (await getRepository()).analytics.optedOut(viewer.id) : false;
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="mb-4">
        <BackButton fallback="/profile" />
      </div>
      <PageHeader eyebrow="You" title="Settings" subtitle={viewer.email ? `Signed in as ${viewer.email}` : undefined} />

      <section className="card p-5" aria-labelledby="password-heading">
        <h2 id="password-heading" className="font-bold">Password</h2>
        <p className="text-sm text-muted mt-1">We&apos;ll email you a link to choose a new one.</p>
        <Link href="/auth/forgot" className="chip mt-3 inline-flex">
          <KeyRound size={14} /> Reset password
        </Link>
      </section>

      {analytics ? (
        <section className="card p-5 mt-5" aria-labelledby="privacy-heading">
          <h2 id="privacy-heading" className="font-bold mb-3">Privacy</h2>
          <AnalyticsToggle optedOut={optedOut} />
        </section>
      ) : null}

      <section className="card p-5 mt-5 border-danger/40" aria-labelledby="delete-heading">
        <h2 id="delete-heading" className="font-bold">Delete account</h2>
        <p className="text-sm text-muted mt-1 mb-3">Removes your account and everything you added. You&apos;ll be asked for your password.</p>
        <DeleteAccount />
      </section>
    </div>
  );
}
