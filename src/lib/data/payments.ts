/**
 * Payment rules shared by both repositories. The database raises
 * "payments:<key>" (0022_payments.sql); the demo repository throws the same.
 */
import { DataError } from "./types";

export const MIN_PRICE_CENTS = 100;
export const MAX_PRICE_CENTS = 50_000;
export const HOLD_MINUTES = 30;
/** Plus perks (keep in step with 0022_payments.sql). */
export const PLUS_LIST_CAP = 1000;
export const PLUS_MONTHLY_PRICE = "$4";

const ERRORS = {
  not_found: ["That event isn't available", "not_found"],
  event_closed: ["This event is no longer selling tickets", "invalid"],
  bad_price: ["Prices go from $1 to $500", "invalid"],
  price_locked: ["The price can't change once people are going or tickets are sold", "conflict"],
  no_payout_account: ["Set up payouts before selling tickets", "forbidden"],
  free_event: ["This event is free: just join it", "invalid"],
  already_going: ["You're already going", "conflict"],
  ticket_required: ["This event needs a ticket", "forbidden"],
  price_via_function: ["Set the price from the event page", "forbidden"],
  supporter_is_earned: ["The supporter badge comes with Plus", "forbidden"],
  demo_only: ["The demo checkout only works in demo mode", "forbidden"],
} as const satisfies Record<string, readonly [string, DataError["code"]]>;

export type PaymentsErrorKey = keyof typeof ERRORS;

export function paymentsError(key: PaymentsErrorKey): DataError {
  const [message, code] = ERRORS[key];
  return new DataError(message, code);
}

export function parsePaymentsMessage(message: string): DataError | null {
  const m = /payments:([a-z_]+)/.exec(message);
  return m && m[1] in ERRORS ? paymentsError(m[1] as PaymentsErrorKey) : null;
}

export function formatPrice(cents: number, currency = "usd"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
}
