"use client";
import { useEffect } from "react";
import { reportClientError } from "@/lib/observability/client";

/** Replaces the root layout when it fails to render, so it brings its own <html>. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportClientError(error), [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", padding: "4rem 1rem", textAlign: "center" }}>
        <h1 style={{ fontSize: "1.5rem" }}>Something broke</h1>
        <p>We hit an error loading FindMaxxing. Try again in a moment.</p>
        <button type="button" onClick={reset} style={{ marginTop: "1rem", padding: "0.6rem 1.2rem", borderRadius: 999 }}>
          Try again
        </button>
      </body>
    </html>
  );
}
