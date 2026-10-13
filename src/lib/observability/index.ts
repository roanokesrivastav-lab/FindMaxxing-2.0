/**
 * Error reporting and structured logs, provider-agnostic.
 *
 * Every server error is logged as one JSON line (what Vercel and most log
 * drains index best). Forwarding is off unless configured:
 *   SENTRY_DSN          — sent to Sentry's envelope endpoint over plain fetch
 *                         (no SDK, so nothing to bundle when it is unused)
 *   ERROR_WEBHOOK_URL   — a JSON POST to any endpoint (Slack relay, Logtail…)
 * Reports are fire-and-forget: monitoring must never fail the request.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type ErrorContext = Record<string, unknown>;

/** Context keys that might carry personal data are dropped before anything leaves the process. */
const SENSITIVE = /pass(word)?|token|secret|authorization|cookie|email/i;

function scrub(context: ErrorContext): ErrorContext {
  return Object.fromEntries(Object.entries(context).filter(([key]) => !SENSITIVE.test(key)));
}

function describe(err: unknown): { name: string; message: string; stack?: string; digest?: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack, digest: (err as { digest?: string }).digest };
  }
  if (err && typeof err === "object" && "message" in err) return { name: "Error", message: String((err as { message: unknown }).message) };
  return { name: "Error", message: String(err) };
}

export function log(level: LogLevel, message: string, fields: ErrorContext = {}): void {
  const line = JSON.stringify({ level, message, time: new Date().toISOString(), ...scrub(fields) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function reportingEnabled(): boolean {
  return !!(process.env.SENTRY_DSN || process.env.ERROR_WEBHOOK_URL);
}

/** Logs the error and, when configured, forwards it. Never throws. */
export function reportError(err: unknown, context: ErrorContext = {}): void {
  const error = describe(err);
  const safe = scrub(context);
  log("error", error.message, { error: error.name, stack: error.stack, digest: error.digest, ...safe });
  if (!reportingEnabled()) return;
  void forward(error, safe).catch(() => {
    // Monitoring is best effort.
  });
}

async function forward(error: ReturnType<typeof describe>, context: ErrorContext): Promise<void> {
  const sends: Promise<unknown>[] = [];
  const dsn = process.env.SENTRY_DSN ? parseSentryDsn(process.env.SENTRY_DSN) : null;
  if (dsn) sends.push(sendToSentry(dsn, error, context));
  if (process.env.ERROR_WEBHOOK_URL) {
    sends.push(
      fetch(process.env.ERROR_WEBHOOK_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error, context, environment: environment(), time: new Date().toISOString() }),
        signal: AbortSignal.timeout(3000),
      }),
    );
  }
  await Promise.allSettled(sends);
}

function environment(): string {
  return process.env.VERCEL_ENV || process.env.NODE_ENV || "development";
}

export interface SentryDsn {
  publicKey: string;
  host: string;
  projectId: string;
  protocol: string;
}

/** `https://<key>@<host>/<project>` → its parts, or null when malformed. */
export function parseSentryDsn(dsn: string): SentryDsn | null {
  try {
    const url = new URL(dsn);
    const projectId = url.pathname.replace(/^\//, "");
    if (!url.username || !projectId) return null;
    return { publicKey: url.username, host: url.host, projectId, protocol: url.protocol.replace(":", "") };
  } catch {
    return null;
  }
}

/** One event in Sentry's envelope format: a header line, an item header line, the event. */
export function sentryEnvelope(dsn: SentryDsn, error: ReturnType<typeof describe>, context: ErrorContext, eventId: string): string {
  const event = {
    event_id: eventId,
    timestamp: Date.now() / 1000,
    platform: "javascript",
    level: "error",
    environment: environment(),
    exception: { values: [{ type: error.name, value: error.message, stacktrace: error.stack ? { frames: [] } : undefined }] },
    extra: { ...context, stack: error.stack, digest: error.digest },
  };
  return [JSON.stringify({ event_id: eventId, sent_at: new Date().toISOString() }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");
}

async function sendToSentry(dsn: SentryDsn, error: ReturnType<typeof describe>, context: ErrorContext): Promise<void> {
  const eventId = crypto.randomUUID().replace(/-/g, "");
  await fetch(`${dsn.protocol}://${dsn.host}/api/${dsn.projectId}/envelope/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-sentry-envelope",
      "x-sentry-auth": `Sentry sentry_version=7, sentry_client=findmaxxing/1.0, sentry_key=${dsn.publicKey}`,
    },
    body: sentryEnvelope(dsn, error, context, eventId),
    signal: AbortSignal.timeout(3000),
  });
}
