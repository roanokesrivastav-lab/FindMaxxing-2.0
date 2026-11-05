import type { Metadata } from "next";
import { requireViewer } from "@/lib/auth/server";
import { ProfileForm } from "@/components/forms/ProfileForm";
import { FormShell } from "@/components/layout/FormShell";

export const metadata: Metadata = { title: "Edit profile" };
export const dynamic = "force-dynamic";

export default async function EditProfilePage({ searchParams }: PageProps<"/profile/edit">) {
  const [viewer, sp] = await Promise.all([requireViewer("/profile/edit"), searchParams]);
  const welcome = !!sp.welcome;
  // Read once on the server so the cooldown date renders the same after hydration.
  const now = new Date().getTime();
  return (
    <FormShell
      title={welcome ? "Welcome to FindMaxxing" : "Edit profile"}
      subtitle={welcome ? "Tell people what you're into. Interests power the filters and who we suggest you meet." : "Interests power the filters and who we suggest you meet."}
      eyebrow={welcome ? "One more step" : "You"}
      backHref="/profile"
      tone="ink"
    >
      <ProfileForm profile={viewer.profile} now={now} />
    </FormShell>
  );
}
