import type { Metadata } from "next";
import { OfflineLists } from "@/components/pwa/OfflineLists";

export const metadata: Metadata = { title: "Offline" };
// Rendered per request like every page, so its scripts carry the CSP nonce; the
// service worker fetches its copy without cookies, so the copy is anonymous.
export const dynamic = "force-dynamic";

export default function OfflinePage() {
  return (
    <div className="max-w-md mx-auto px-4 pt-12 pb-nav md:pb-10 text-center">
      <div className="h-14 w-14 mx-auto rounded-2xl bg-paper-2 inline-flex items-center justify-center text-3xl" aria-hidden>📡</div>
      <h1 className="text-2xl font-bold mt-4">You&apos;re offline</h1>
      <p className="text-muted mt-2">This page needs a connection. Your saved lists you opened recently still work:</p>
      <OfflineLists />
    </div>
  );
}
