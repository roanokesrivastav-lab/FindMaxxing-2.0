/**
 * Strips metadata from a phone photo before it leaves the device: EXIF (GPS
 * position, camera serial, timestamps), XMP, maker notes, comments, Apple and
 * Samsung multi-picture data, and anything after the end-of-image marker
 * (where phones append depth maps and secondary images with their own EXIF).
 *
 * Kept: the image itself (tables, frames, scans), JFIF, the ICC colour profile
 * and Adobe colour-transform blocks the decoder needs, and the EXIF
 * Orientation alone, rewritten as a one-entry EXIF, so a portrait photo is
 * not shown sideways. Anything that is not a well-formed JPEG is refused
 * rather than uploaded as is.
 *
 * The web app does the same on the server with sharp (src/lib/images); the
 * phone uploads straight to Storage, so it has to happen here. Pure
 * TypeScript, tested in tests/mobile-jpeg-metadata.test.ts.
 */

export class UnsupportedPhotoError extends Error {}

/** place-photos bucket limit (0001_init.sql). */
export const PHOTO_MAX_BYTES = 5 * 1024 * 1024;

const SOI = 0xd8, EOI = 0xd9, SOS = 0xda, APP0 = 0xe0, APP1 = 0xe1, APP2 = 0xe2, APP14 = 0xee, COM = 0xfe;
const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const EXIF_ID = ascii("Exif\0\0");
const ICC_ID = ascii("ICC_PROFILE\0");

function startsWith(bytes: Uint8Array, at: number, id: number[]) {
  return id.every((b, i) => bytes[at + i] === b);
}

/** The EXIF Orientation (1–8) from an APP1 Exif payload, or null. */
export function readOrientation(payload: Uint8Array): number | null {
  if (!startsWith(payload, 0, EXIF_ID)) return null;
  const tiff = 6;
  const le = payload[tiff] === 0x49 && payload[tiff + 1] === 0x49;
  if (!le && !(payload[tiff] === 0x4d && payload[tiff + 1] === 0x4d)) return null;
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const u16 = (at: number) => view.getUint16(at, le);
  try {
    const ifd0 = tiff + view.getUint32(tiff + 4, le);
    const count = u16(ifd0);
    for (let i = 0; i < count; i++) {
      const entry = ifd0 + 2 + i * 12;
      if (u16(entry) === 0x0112 && u16(entry + 2) === 3) {
        const value = u16(entry + 8);
        return value >= 1 && value <= 8 ? value : null;
      }
    }
  } catch {
    return null; // offsets past the end: no usable orientation
  }
  return null;
}

/** A minimal APP1 segment holding only IFD0 → Orientation. */
function orientationSegment(orientation: number): number[] {
  const payload = [
    ...EXIF_ID,
    0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08, // big-endian TIFF, IFD0 at 8
    0x00, 0x01, // one entry
    0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, // Orientation, SHORT, 1
    0x00, 0x00, 0x00, 0x00, // no next IFD
  ];
  const length = payload.length + 2;
  return [0xff, APP1, length >> 8, length & 0xff, ...payload];
}

function keep(marker: number, payload: Uint8Array): boolean {
  if (marker === APP0 || marker === APP14) return true;
  if (marker === APP2) return startsWith(payload, 0, ICC_ID);
  return !(marker >= 0xe0 && marker <= 0xef) && marker !== COM;
}

export function stripJpegMetadata(input: Uint8Array): Uint8Array {
  const bytes = input;
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== SOI) throw new UnsupportedPhotoError("Use a JPEG photo.");
  const out: Uint8Array[] = [Uint8Array.of(0xff, SOI)];
  let orientation: number | null = null;
  let orientationAt = -1; // where in `out` the rewritten EXIF goes: after JFIF if present
  let pos = 2;
  const fail = (): never => {
    throw new UnsupportedPhotoError("This photo could not be read. Take another one.");
  };

  for (;;) {
    if (pos >= bytes.length || bytes[pos] !== 0xff) fail();
    while (bytes[pos] === 0xff) pos++; // fill bytes
    if (pos >= bytes.length) fail();
    const marker = bytes[pos++];
    if (marker === EOI) {
      out.push(Uint8Array.of(0xff, EOI));
      break; // whatever follows is dropped
    }
    if (marker === SOI || marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) fail();
    if (pos + 2 > bytes.length) fail();
    const length = (bytes[pos] << 8) | bytes[pos + 1];
    if (length < 2 || pos + length > bytes.length) fail();
    const segment = bytes.subarray(pos - 2, pos + length);
    const payload = bytes.subarray(pos + 2, pos + length);
    pos += length;

    if (marker === APP1 && orientation === null) orientation = readOrientation(payload);
    if (keep(marker, payload)) out.push(segment);
    if (marker === APP0 && orientationAt < 0) orientationAt = out.length;

    if (marker === SOS) {
      // Entropy-coded data runs to the next marker that is not stuffing (FF00) or a restart (FFD0–D7).
      const start = pos;
      while (pos < bytes.length) {
        if (bytes[pos] === 0xff && pos + 1 < bytes.length) {
          const next = bytes[pos + 1];
          if (next !== 0x00 && !(next >= 0xd0 && next <= 0xd7) && next !== 0xff) break;
        }
        pos++;
      }
      if (pos >= bytes.length) fail(); // no end-of-image marker
      out.push(bytes.subarray(start, pos));
    }
  }

  if (orientation !== null && orientation !== 1) out.splice(orientationAt < 0 ? 1 : orientationAt, 0, Uint8Array.from(orientationSegment(orientation)));
  const result = new Uint8Array(out.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of out) {
    result.set(part, at);
    at += part.length;
  }
  if (result.length > PHOTO_MAX_BYTES) throw new UnsupportedPhotoError("This photo is too large. Take it again at a lower resolution.");
  return result;
}
