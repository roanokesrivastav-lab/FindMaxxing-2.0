import "server-only";

/** External metadata is not necessarily from this application's UUID users. */
export function stripeUserId(metadata: { user_id?: unknown } | null | undefined): string | undefined {
  const value = metadata?.user_id;
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : undefined;
}
