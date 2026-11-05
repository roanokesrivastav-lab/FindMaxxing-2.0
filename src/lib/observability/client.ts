"use client";

/**
 * Sends a client-side render error to /api/client-errors, which logs and
 * forwards it like a server error. Only the message, digest and path are sent.
 */
export function reportClientError(error: Error & { digest?: string }): void {
  try {
    const body = JSON.stringify({
      message: String(error.message ?? "").slice(0, 500),
      digest: error.digest ?? null,
      path: window.location.pathname,
    });
    if (!navigator.sendBeacon?.("/api/client-errors", new Blob([body], { type: "application/json" }))) {
      void fetch("/api/client-errors", { method: "POST", body, headers: { "content-type": "application/json" }, keepalive: true });
    }
  } catch {
    // Reporting must never throw from an error boundary.
  }
}
