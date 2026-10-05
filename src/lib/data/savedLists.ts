/**
 * Saved-list rules shared by the Supabase and demo repositories (and the
 * database, whose check constraint and cap trigger say the same thing).
 */
import { DataError } from "./types";

export const SAVED_LIST_NAME_MAX = 60;
export const MAX_SAVED_LISTS = 100;

/**
 * Whitespace for list names, spelled out character by character (it is exactly
 * what JavaScript's \s matches) so the database can use the identical class:
 * public.normalize_list_name in 0009_saved_lists.sql. A locale-dependent class
 * on either side would let the two disagree on what is blank or a duplicate.
 */
export const LIST_NAME_SPACE = "[\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]";
const SPACE_RUNS = new RegExp(`${LIST_NAME_SPACE}+`, "g");

/** Whitespace runs become one space, ends trimmed; throws DataError("invalid") when empty or too long. */
export function normalizeListName(raw: string): string {
  const name = raw.replace(SPACE_RUNS, " ").replace(/^ | $/g, "");
  if (!name) throw new DataError("Give the list a name", "invalid");
  if (name.length > SAVED_LIST_NAME_MAX) throw new DataError(`Keep list names under ${SAVED_LIST_NAME_MAX + 1} characters`, "invalid");
  return name;
}

/** The uniqueness key of a normalized name: saved_lists_owner_name_idx is on lower(name). */
export function listNameKey(name: string): string {
  return name.toLowerCase();
}

export function duplicateListName(name: string): DataError {
  return new DataError(`You already have a list called “${name}”`, "conflict");
}

export const LIST_LIMIT_ERROR = `You can have at most ${MAX_SAVED_LISTS} lists`;
