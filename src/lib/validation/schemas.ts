import { z } from "zod";
import { isValidTimestamp } from "@/lib/data/discovery";
import { CATEGORY_MAP, EVENT_CATEGORIES, INTEREST_MAP, PLACE_CATEGORIES } from "@/lib/data/taxonomy";

const placeCategorySlugs = PLACE_CATEGORIES.map((c) => c.slug) as [string, ...string[]];
const eventCategorySlugs = EVENT_CATEGORIES.map((c) => c.slug) as [string, ...string[]];

const trimmed = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .min(min, `${label} must be at least ${min} characters`)
    .max(max, `${label} must be under ${max} characters`);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

/**
 * Longest event we accept. An end time at or before the start is treated as
 * running past midnight; beyond this the times are more likely a typo.
 */
export const MAX_EVENT_HOURS = 18;

export const latSchema = z.coerce.number().min(-90).max(90);
export const lngSchema = z.coerce.number().min(-180).max(180);

export const visibilitySchema = z
  .enum(["public", "locals"], { message: "Pick who can see this" })
  .default("public");

export const tagsSchema = z
  .array(z.string().trim().toLowerCase())
  .max(8, "Pick up to 8 tags")
  .default([])
  .transform((tags) => Array.from(new Set(tags.filter((t) => t in INTEREST_MAP))));

export const placeSchema = z.object({
  name: trimmed(2, 80, "Name"),
  description: trimmed(10, 1000, "Description"),
  localTip: optionalText(280),
  categorySlug: z.enum(placeCategorySlugs, { message: "Pick a category" }),
  lat: latSchema,
  lng: lngSchema,
  address: optionalText(160),
  neighborhood: optionalText(80),
  city: trimmed(2, 80, "City"),
  tags: tagsSchema,
  visibility: visibilitySchema,
});
export type PlaceFormValues = z.input<typeof placeSchema>;
export const updatePlaceSchema = placeSchema;
export type UpdatePlaceFormValues = z.input<typeof updatePlaceSchema>;

export const eventSchema = z
  .object({
    title: trimmed(3, 90, "Title"),
    description: trimmed(10, 1200, "Description"),
    placeId: z.string().uuid().optional().or(z.literal("")).transform((v) => (v ? v : null)),
    locationName: trimmed(2, 120, "Location name"),
    address: optionalText(160),
    // Events retain this in their address snapshot rather than a separate DB
    // column, but validating it keeps the progressive address flow consistent.
    // Events retain this in their address snapshot rather than a separate DB
    // column. Older callers may omit it; the current form requires it in the UI.
    city: optionalText(80),
    lat: latSchema,
    lng: lngSchema,
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date"),
    startTime: z.string().regex(/^\d{2}:\d{2}$/, "Pick a start time"),
    endTime: z
      .string()
      .regex(/^\d{2}:\d{2}$/)
      .optional()
      .or(z.literal(""))
      .transform((v) => (v ? v : null)),
    categorySlug: z.enum(eventCategorySlugs, { message: "Pick a category" }),
    capacity: z
      .union([z.literal(""), z.coerce.number().int().min(2, "Capacity must be at least 2").max(5000)])
      .optional()
      .transform((v) => (v === "" || v === undefined ? null : v)),
    tags: tagsSchema,
    /** Minutes offset of the client's timezone (from Date#getTimezoneOffset). */
    tzOffsetMinutes: z.coerce.number().int().min(-840).max(840).default(0),
  })
  .superRefine((v, ctx) => {
    const { startsAt, endsAt } = combineDateTime(v.date, v.startTime, v.endTime, v.tzOffsetMinutes);
    if (Number.isNaN(startsAt.getTime())) {
      ctx.addIssue({ code: "custom", path: ["date"], message: "Invalid date/time" });
      return;
    }
    if (startsAt.getTime() < Date.now() - 60 * 60 * 1000) {
      ctx.addIssue({ code: "custom", path: ["date"], message: "Events must start in the future" });
    }
    if (endsAt) {
      // An end at or before the start is rolled forward a day, because an event
      // running 9pm–1am is normal. That roll also turns a 6pm–5pm typo into a
      // silent 23-hour event, so anything implausibly long is rejected here.
      const hours = (endsAt.getTime() - startsAt.getTime()) / 3_600_000;
      if (hours > MAX_EVENT_HOURS) {
        ctx.addIssue({
          code: "custom",
          path: ["endTime"],
          message: `That runs ${Math.round(hours)} hours. Check the start and end times.`,
        });
      }
    }
  });
export type EventFormValues = z.input<typeof eventSchema>;
export const updateEventSchema = eventSchema;
export type UpdateEventFormValues = z.input<typeof updateEventSchema>;

/**
 * Combine a local date/time with the client's tz offset into absolute Dates.
 * tzOffsetMinutes follows Date#getTimezoneOffset (UTC - local), so local
 * midnight == UTC midnight + offset.
 */
export function combineDateTime(
  date: string,
  startTime: string,
  endTime: string | null,
  tzOffsetMinutes: number,
): { startsAt: Date; endsAt: Date | null } {
  const base = Date.parse(`${date}T${startTime}:00Z`) + tzOffsetMinutes * 60_000;
  const startsAt = new Date(base);
  let endsAt: Date | null = null;
  if (endTime) {
    let end = Date.parse(`${date}T${endTime}:00Z`) + tzOffsetMinutes * 60_000;
    // An end time earlier than start is treated as "after midnight".
    if (end <= base) end += 24 * 60 * 60_000;
    endsAt = new Date(end);
  }
  return { startsAt, endsAt };
}

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3, "Username must be at least 3 characters")
  .max(24, "Username must be under 24 characters")
  .regex(/^[a-z0-9_]+$/, "Only letters, numbers and underscores");

export const profileSchema = z.object({
  username: usernameSchema,
  displayName: trimmed(2, 50, "Display name"),
  bio: optionalText(240),
  homeCity: optionalText(80),
  interests: z
    .array(z.string())
    .max(12, "Pick up to 12 interests")
    .default([])
    .transform((v) => Array.from(new Set(v.filter((i) => i in INTEREST_MAP)))),
});
export type ProfileFormValues = z.input<typeof profileSchema>;

export const ratingSchema = z.object({
  placeId: z.string().uuid(),
  score: z.coerce.number().int().min(1).max(5),
  // Unlike the form schemas, this input arrives from client code rather than
  // FormData, so an absent note is null rather than "". Accept both.
  note: z
    .string()
    .trim()
    .max(280, "Keep the note under 280 characters")
    .nullish()
    .transform((v) => (v ? v : null)),
});

/** Owner-settable listing status. Moderation statuses are not accepted here. */
export const placeStatusSchema = z.enum(["published", "hidden"], {
  message: "Invalid status",
});

export const placeVisibilitySchema = z.enum(["public", "locals", "private"], {
  message: "Invalid visibility",
});

export const reportSchema = z.object({
  targetType: z.enum(["place", "event", "profile"]),
  targetId: z.string().uuid(),
  reason: z.enum(["inaccurate", "closed", "inappropriate", "spam", "duplicate", "other"]),
  details: optionalText(500),
});

export const signUpSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(8, "Password must be at least 8 characters").max(72),
  username: usernameSchema,
  displayName: trimmed(2, 50, "Display name"),
});

export const signInSchema = z.object({
  email: z.string().trim().toLowerCase().email("Enter a valid email"),
  password: z.string().min(1, "Enter your password"),
});

export const uuidSchema = z.string().uuid();

/** Free-text search box input. Collapses whitespace; empty means "no search". */
export const searchQuerySchema = z
  .string()
  .trim()
  .max(60)
  .transform((v) => v.replace(/\s+/g, " "))
  .catch("");

/**
 * Query string for the discovery endpoints. `bbox` is west,south,east,north
 * (the GeoJSON / map-library order); `tags` is a comma list of interest slugs.
 * Unknown tags are dropped, like tagsSchema; an unknown category is an error,
 * since silently ignoring it would widen the result set.
 */
const timestampParam = (name: string) =>
  z
    .string()
    .optional()
    .refine((v) => !v || isValidTimestamp(v), `${name} must be an ISO timestamp`)
    .transform((v) => v || null);

export const discoveryQuerySchema = z.object({
  bbox: z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (!v) return null;
      const parts = v.split(",").map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        ctx.addIssue({ code: "custom", message: "bbox must be west,south,east,north" });
        return z.NEVER;
      }
      const [west, south, east, north] = parts;
      return { west, south, east, north };
    }),
  q: z.string().trim().max(80).optional().transform((v) => v || null),
  category: z
    .string()
    .optional()
    .refine((v) => !v || v in CATEGORY_MAP, "Unknown category")
    .transform((v) => v || null),
  tags: z
    .string()
    .optional()
    .transform((v) => Array.from(new Set((v ?? "").split(",").map((t) => t.trim().toLowerCase()).filter((t) => t in INTEREST_MAP))).slice(0, 8)),
  neighborhood: z.string().trim().max(80).optional().transform((v) => v || null),
  createdAfter: timestampParam("createdAfter"),
  startsBefore: timestampParam("startsBefore"),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
  cursor: z.string().max(512).optional().transform((v) => v || null),
  includePast: z.enum(["0", "1", "true", "false"]).optional().transform((v) => v === "1" || v === "true"),
  kind: z.enum(["all", "places", "events"]).default("all"),
});
export type DiscoveryQuery = z.output<typeof discoveryQuerySchema>;

export function categoryExists(slug: string) {
  return slug in CATEGORY_MAP;
}

/** Field → first error message, for rendering form errors. */
export type FieldErrors = Record<string, string>;

export function fieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = issue.path.length ? String(issue.path[0]) : "_form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

/** Image upload constraints (shared by client + server). */
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export function isAllowedImage(file: File): string | null {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return "Use a JPG, PNG or WebP";
  if (file.size > IMAGE_MAX_BYTES) return "Image must be under 5MB";
  return null;
}
