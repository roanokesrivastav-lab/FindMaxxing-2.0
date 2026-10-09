"use client";
import { useEffect } from "react";

/** Installs the service worker (the pwa flag): the app can be added to a home screen and saved lists open offline. */
export function RegisterServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator) || process.env.NODE_ENV !== "production") return;
    navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
  }, []);
  return null;
}

/** Signing out (or deleting the account) must not leave private pages on the device. */
export async function forgetPrivatePages() {
  try {
    const reg = await navigator.serviceWorker?.getRegistration("/");
    reg?.active?.postMessage({ type: "forget-private-pages" });
    if ("caches" in window) for (const k of await caches.keys()) if (k.startsWith("fm-pages-")) await caches.delete(k);
  } catch {
    // No worker or no cache: nothing to forget.
  }
}
