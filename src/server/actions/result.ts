import { DataError } from "@/lib/data/types";
import type { FieldErrors } from "@/lib/validation/schemas";

export type ActionResult<T = undefined> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: FieldErrors; code?: string };

export function fail(error: string, fieldErrors?: FieldErrors, code?: string): ActionResult<never> {
  return { ok: false, error, fieldErrors, code };
}

export function succeed<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

/** Convert thrown errors into a safe ActionResult without leaking internals. */
export function toFailure(err: unknown): ActionResult<never> {
  if (err instanceof DataError) return fail(err.message, undefined, err.code);
  // Next.js redirect()/notFound() throw; let those propagate.
  if (err && typeof err === "object" && "digest" in err && typeof (err as { digest?: unknown }).digest === "string") throw err;
  console.error("[action]", err);
  return fail("Something went wrong. Please try again.", undefined, "unknown");
}

export function str(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

export function strList(formData: FormData, key: string): string[] {
  return formData.getAll(key).filter((v): v is string => typeof v === "string");
}
