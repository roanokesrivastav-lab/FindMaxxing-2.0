/**
 * Display sizes for place photos, shared by the server pipeline, the photo
 * route and the components that build `srcSet`. Safe to import on the client.
 */
export const PHOTO_SIZES = ["sm", "md", "lg"] as const;
export type PhotoSize = (typeof PHOTO_SIZES)[number];

/**
 * Nominal width of each size, for `srcSet` `w` descriptors. It is the long
 * edge, so for portrait photos the real width is smaller and the browser picks
 * a slightly smaller file than ideal, never a larger one.
 */
export const PHOTO_WIDTH: Record<PhotoSize, number> = { sm: 480, md: 960, lg: 1600 };

export function parsePhotoSize(value: string | null | undefined): PhotoSize {
  return (PHOTO_SIZES as readonly string[]).includes(value ?? "") ? (value as PhotoSize) : "lg";
}

/**
 * Where a size is stored, derived from the photo's storage path so no schema
 * change is needed: lg is the path itself, the others sit next to it.
 * `owner/abc.webp` → `owner/abc.md.webp`. Legacy `.jpg` / `.png` originals have
 * no siblings; the photo route falls back to them until the migration script
 * replaces them with pipeline output at a new path.
 */
export function photoVariantPath(storagePath: string, size: PhotoSize): string {
  if (size === "lg") return storagePath;
  return `${storagePath.replace(/\.(jpe?g|png|webp)$/i, "")}.${size}.webp`;
}

/** Every stored object behind a photo, for removal. */
export function photoObjectPaths(storagePath: string): string[] {
  return PHOTO_SIZES.map((size) => photoVariantPath(storagePath, size));
}

/** True for URLs served by the authorized photo route, which accepts `?size=`. */
function isRoutePhoto(url: string): boolean {
  return url.startsWith("/api/photos/");
}

export function photoSrc(url: string, size: PhotoSize): string {
  return isRoutePhoto(url) ? `${url}?size=${size}` : url;
}

/** `srcSet` for a place photo, or undefined for externally hosted images. */
export function photoSrcSet(url: string): string | undefined {
  if (!isRoutePhoto(url)) return undefined;
  return PHOTO_SIZES.map((size) => `${photoSrc(url, size)} ${PHOTO_WIDTH[size]}w`).join(", ");
}

/**
 * `sizes` for each layout a place photo appears in. Keep these in step with the
 * markup: they decide which file a phone downloads, and the transfer budget in
 * tests/images.test.ts is computed from them.
 */
export const PHOTO_LAYOUT_SIZES = {
  /** Detail page hero: full width on phones; the main column beside the side rail on desktop. */
  hero: "(min-width: 768px) calc(100vw - 300px), 100vw",
  /** Detail page gallery: two columns inside the 672px content column (px-4 / px-6, gap-2). */
  gallery: "(min-width: 768px) 308px, calc(50vw - 20px)",
  /** Full-width list card cover. */
  card: "(min-width: 768px) 400px, calc(100vw - 32px)",
  /** Compact list card and map preview thumbnails (fixed 104px / 96px). */
  thumb: "104px",
} as const;

/**
 * Mobile transfer budget for a place page with the maximum six photos, on the
 * Lighthouse mobile profile (412px wide, device pixel ratio 1.75): the hero
 * plus all six gallery images, as the browser would pick them from `srcSet`.
 */
export const SIX_PHOTO_PAGE_BUDGET_BYTES = 600 * 1024;
export const BUDGET_VIEWPORT = { width: 412, dpr: 1.75 } as const;

/**
 * The size a browser picks from `photoSrcSet` for an image displayed at
 * `cssWidth`: the smallest candidate at least as wide as the device pixels
 * needed, else the largest.
 */
export function pickPhotoSize(cssWidth: number, dpr: number): PhotoSize {
  const needed = cssWidth * dpr;
  return PHOTO_SIZES.find((size) => PHOTO_WIDTH[size] >= needed) ?? "lg";
}
