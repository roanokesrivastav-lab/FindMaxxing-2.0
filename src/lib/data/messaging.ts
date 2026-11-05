/**
 * Messaging rules shared by both repositories. The database raises
 * "messaging:<key>" from start_direct() and the messages trigger
 * (0020_messaging.sql); the demo repository throws the same keys.
 */
import { DataError } from "./types";

export const MAX_MESSAGE_LENGTH = 2000;
export const MESSAGE_PAGE_SIZE = 50;
export const MAX_MESSAGE_PAGE = 101;

/** Who you may start a direct conversation with, in the words the UI shows. */
export const DIRECT_MESSAGE_RULE = "You can message people who follow you back, or who are going to an event you're going to.";

const ERRORS = {
  not_allowed: [DIRECT_MESSAGE_RULE, "forbidden"],
  blocked: ["You can't message this person.", "forbidden"],
  closed: ["This event's chat is closed.", "forbidden"],
  not_found: ["That conversation doesn't exist.", "not_found"],
  empty: ["Write a message first.", "invalid"],
  too_long: [`Keep messages under ${MAX_MESSAGE_LENGTH} characters.`, "invalid"],
  self: ["You can't block or message yourself.", "invalid"],
} as const satisfies Record<string, readonly [string, DataError["code"]]>;

export type MessagingErrorKey = keyof typeof ERRORS;

export function messagingError(key: MessagingErrorKey): DataError {
  const [message, code] = ERRORS[key];
  return new DataError(message, code);
}

/** Maps "messaging:<key>" from a database error message, or null for anything else. */
export function parseMessagingMessage(message: string): DataError | null {
  const m = /messaging:([a-z_]+)/.exec(message);
  return m && m[1] in ERRORS ? messagingError(m[1] as MessagingErrorKey) : null;
}

/** The pair key of a direct conversation: both ids, sorted, as the database builds it. */
export function directKey(a: string, b: string): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Trimmed body, or a messaging error. */
export function normalizeMessageBody(body: string): string {
  const text = (body ?? "").trim();
  if (!text) throw messagingError("empty");
  if (text.length > MAX_MESSAGE_LENGTH) throw messagingError("too_long");
  return text;
}
