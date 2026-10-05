/**
 * Server-side image pipeline. Every uploaded image is decoded here before it is
 * stored: the bytes (not the declared MIME type) decide what it is, EXIF
 * orientation is applied, all metadata (GPS included) is dropped, and the
 * result is re-encoded at the sizes the pages actually display.
 *
 * Demo and Supabase modes store exactly what this returns, so both deliver the
 * same bytes.
 */
import sharp, { type Metadata } from "sharp";
import type { PhotoSize } from "./sizes";

/** Longest edge per place-photo size. lg is what `storagePath` points at. */
export const PLACE_PHOTO_EDGE: Record<PhotoSize, number> = { sm: 480, md: 960, lg: 1600 };
const PLACE_PHOTO_QUALITY: Record<PhotoSize, number> = { sm: 72, md: 74, lg: 76 };
export const AVATAR_EDGE = 256;
const AVATAR_QUALITY = 78;

export const MIN_PLACE_PHOTO_EDGE = 200;
export const MIN_AVATAR_EDGE = 96;
/** Larger inputs are refused before decoding: a small file can expand into gigabytes. */
export const MAX_INPUT_PIXELS = 40_000_000;
const ACCEPTED_FORMATS = new Set(["jpeg", "png", "webp"]);

export const STORED_CONTENT_TYPE = "image/webp";

/** A user-facing reason an upload was refused. */
export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageRejectedError";
  }
}

export interface ProcessedPlacePhoto {
  /** Stored at the photo's storage path. */
  main: Uint8Array<ArrayBuffer>;
  variants: Record<Exclude<PhotoSize, "lg">, Uint8Array<ArrayBuffer>>;
  width: number;
  height: number;
}

export interface ProcessedAvatar {
  main: Uint8Array<ArrayBuffer>;
}

function decoder(input: Uint8Array) {
  // failOn "error": truncated or corrupt data is refused rather than half-decoded.
  return sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error", animated: false });
}

/**
 * Checks what the bytes really are. Returns the displayed (orientation-applied)
 * dimensions, or throws ImageRejectedError with a message for the uploader.
 */
export async function inspectImage(input: Uint8Array, minEdge: number): Promise<{ width: number; height: number }> {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: false }).metadata();
  } catch {
    throw new ImageRejectedError("That file isn't an image we can read. Use a JPG, PNG or WebP");
  }
  if (!meta.format || !ACCEPTED_FORMATS.has(meta.format)) {
    throw new ImageRejectedError("Use a JPG, PNG or WebP");
  }
  if ((meta.pages ?? 1) > 1) throw new ImageRejectedError("Animated images aren't supported");
  const width = meta.autoOrient?.width ?? meta.width ?? 0;
  const height = meta.autoOrient?.height ?? meta.height ?? 0;
  if (!width || !height) throw new ImageRejectedError("That file isn't an image we can read. Use a JPG, PNG or WebP");
  if (width * height > MAX_INPUT_PIXELS) throw new ImageRejectedError("Image is too large. Keep it under 40 megapixels");
  if (Math.min(width, height) < minEdge) {
    throw new ImageRejectedError(`Image is too small. Use one at least ${minEdge}px on each side`);
  }
  return { width, height };
}

/**
 * Images being decoded or encoded at once, across every request in this
 * process. A 40-megapixel decode is hundreds of MB of pixels; six-photo forms
 * from several users must queue rather than all decode together.
 */
export const MAX_CONCURRENT_IMAGES = 2;
let activeImages = 0;
const waitingForImage: (() => void)[] = [];

export async function withImageSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeImages >= MAX_CONCURRENT_IMAGES) {
    // Woken by a finishing task, which hands its slot over without releasing it.
    await new Promise<void>((resolve) => waitingForImage.push(resolve));
  } else {
    activeImages += 1;
  }
  try {
    return await task();
  } finally {
    const next = waitingForImage.shift();
    if (next) next();
    else activeImages -= 1;
  }
}

/** A place photo at every display size, largest first in `main`. */
export async function processPlacePhoto(input: Uint8Array): Promise<ProcessedPlacePhoto> {
  const { width, height } = await inspectImage(input, MIN_PLACE_PHOTO_EDGE);
  return withImageSlot(async () => {
    try {
      // Decode the (possibly huge) original once, straight down to the largest
      // stored size; the smaller sizes are made from that, one at a time.
      const { data, info } = await decoder(input)
        .rotate()
        .resize({ width: PLACE_PHOTO_EDGE.lg, height: PLACE_PHOTO_EDGE.lg, fit: "inside", withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true });
      const raw = { raw: { width: info.width, height: info.height, channels: info.channels } };
      const out = {} as Record<PhotoSize, Uint8Array<ArrayBuffer>>;
      for (const size of ["lg", "md", "sm"] as const) {
        const edge = PLACE_PHOTO_EDGE[size];
        const encoded = await sharp(data, raw)
          .resize({ width: edge, height: edge, fit: "inside", withoutEnlargement: true })
          .webp({ quality: PLACE_PHOTO_QUALITY[size], effort: 4 })
          .toBuffer();
        out[size] = new Uint8Array(encoded);
      }
      const scale = Math.min(1, PLACE_PHOTO_EDGE.lg / Math.max(width, height));
      return { main: out.lg, variants: { md: out.md, sm: out.sm }, width: Math.round(width * scale), height: Math.round(height * scale) };
    } catch {
      throw new ImageRejectedError("That image couldn't be processed. Try another file");
    }
  });
}

/** A square avatar, center-cropped. */
export async function processAvatar(input: Uint8Array): Promise<ProcessedAvatar> {
  await inspectImage(input, MIN_AVATAR_EDGE);
  return withImageSlot(async () => {
    try {
      const out = await decoder(input)
        .rotate()
        .resize({ width: AVATAR_EDGE, height: AVATAR_EDGE, fit: "cover", position: "attention" })
        .webp({ quality: AVATAR_QUALITY, effort: 4 })
        .toBuffer();
      return { main: new Uint8Array(out) };
    } catch {
      throw new ImageRejectedError("That image couldn't be processed. Try another file");
    }
  });
}
