import "server-only";
import { createHmac } from "node:crypto";
import type { AnalyticsEventName } from "@/lib/data/types";

/**
 * Optional copies of first-party events to a hosted analytics tool. Off unless
 * configured; first-party events are the source of truth either way.
 *   POSTHOG_KEY (+ POSTHOG_HOST)  — events with a pseudonymous distinct id:
 *                                   an HMAC of the user id under
 *                                   ANALYTICS_FORWARD_SECRET (required with it)
 *   PLAUSIBLE_DOMAIN              — custom events with no user identifier at all
 * Neither gets an IP address from us (the requests come from the server), an
 * email, or a raw user id.
 */
export function forwardingEnabled(): boolean {
  return !!((process.env.POSTHOG_KEY && process.env.ANALYTICS_FORWARD_SECRET) || process.env.PLAUSIBLE_DOMAIN);
}

export async function forwardEvent(userId: string, name: AnalyticsEventName, props: Record<string, unknown>): Promise<void> {
  const sends: Promise<unknown>[] = [];
  if (process.env.POSTHOG_KEY && process.env.ANALYTICS_FORWARD_SECRET) {
    const distinctId = createHmac("sha256", process.env.ANALYTICS_FORWARD_SECRET).update(userId).digest("hex");
    sends.push(
      fetch(`${process.env.POSTHOG_HOST ?? "https://us.i.posthog.com"}/capture/`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ api_key: process.env.POSTHOG_KEY, event: name, distinct_id: distinctId, properties: { ...props, $ip: null } }),
        signal: AbortSignal.timeout(2000),
      }),
    );
  }
  if (process.env.PLAUSIBLE_DOMAIN) {
    sends.push(
      fetch("https://plausible.io/api/event", {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "FindMaxxing server" },
        body: JSON.stringify({ name, domain: process.env.PLAUSIBLE_DOMAIN, url: `https://${process.env.PLAUSIBLE_DOMAIN}/`, props }),
        signal: AbortSignal.timeout(2000),
      }),
    );
  }
  await Promise.allSettled(sends);
}
