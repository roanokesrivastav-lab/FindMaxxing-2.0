import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { PHOTO_MAX_BYTES, UnsupportedPhotoError, readOrientation, stripJpegMetadata } from "../apps/mobile/lib/jpegMetadata";

const XMP = '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:exif="http://ns.adobe.com/exif/1.0/" exif:GPSLatitude="39,57N"/></rdf:RDF></x:xmpmeta>';
const has = (bytes: Uint8Array, text: string) => Buffer.from(bytes).includes(text);

/** A phone-like photo: GPS and camera EXIF, XMP with a location, optional rotation. */
async function phonePhoto(opts: { orientation?: number; progressive?: boolean } = {}) {
  let img = sharp({ create: { width: 64, height: 32, channels: 3, background: "#c33" } }).jpeg({ progressive: opts.progressive ?? false });
  img = img
    .withExif({ IFD0: { Make: "PhoneCo", Model: "X1" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "39/1 57/1 0/1", GPSLongitudeRef: "W", GPSLongitude: "83/1 0/1 0/1" } })
    .withXmp(XMP);
  let buf = await img.toBuffer();
  if (opts.orientation) buf = await sharp(buf).keepMetadata().withMetadata({ orientation: opts.orientation }).toBuffer();
  return new Uint8Array(buf);
}

function segment(marker: number, payload: number[] | string): number[] {
  const body = typeof payload === "string" ? Array.from(payload, (c) => c.charCodeAt(0)) : payload;
  return [0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
}

describe("phone photo metadata is stripped before upload", () => {
  it("removes GPS, camera EXIF and XMP from a real JPEG, which still decodes at the same size", async () => {
    const original = await phonePhoto();
    expect(has(original, "PhoneCo")).toBe(true);
    expect(has(original, "GPSLatitude")).toBe(true);
    const cleaned = stripJpegMetadata(original);
    const meta = await sharp(Buffer.from(cleaned)).metadata();
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect([meta.width, meta.height]).toEqual([64, 32]);
    expect(has(cleaned, "PhoneCo")).toBe(false);
    expect(has(cleaned, "GPS")).toBe(false);
    expect(has(cleaned, "adobe:ns:meta")).toBe(false);
    // The pixels are untouched: the scan decodes to the same image.
    const [a, b] = await Promise.all([sharp(Buffer.from(original)).raw().toBuffer(), sharp(Buffer.from(cleaned)).raw().toBuffer()]);
    expect(Buffer.compare(a, b)).toBe(0);
  });

  it("handles progressive JPEGs (several scans)", async () => {
    const cleaned = stripJpegMetadata(await phonePhoto({ progressive: true }));
    const meta = await sharp(Buffer.from(cleaned)).metadata();
    expect(meta.isProgressive).toBe(true);
    expect(meta.exif).toBeUndefined();
  });

  it("keeps only the orientation, so a portrait photo is not shown sideways", async () => {
    const original = await phonePhoto({ orientation: 6 });
    expect((await sharp(Buffer.from(original)).metadata()).orientation).toBe(6);
    expect(has(original, "GPS")).toBe(true);
    const cleaned = stripJpegMetadata(original);
    const meta = await sharp(Buffer.from(cleaned)).metadata();
    expect(meta.orientation).toBe(6);
    expect(meta.exif!.length).toBeLessThan(40); // one IFD entry, nothing else
    expect(has(cleaned, "GPS")).toBe(false);
    expect(has(cleaned, "PhoneCo")).toBe(false);
  });

  it("drops comments, maker blocks, multi-picture data and images appended after the end marker; keeps JFIF, ICC and Adobe", () => {
    const jfif = segment(0xe0, "JFIF\0\x01\x01\0\0\x01\0\x01\0\0");
    const icc = segment(0xe2, "ICC_PROFILE\0\x01\x01profile");
    const mpf = segment(0xe2, "MPF\0secret-depth-map");
    const adobe = segment(0xee, "Adobe\0\x64\0\0\0\0\x01");
    const exif = segment(0xe1, "Exif\0\0MM\0*\0\0\0\x08\0\0\0\0\0\0GPS-here");
    const maker = segment(0xeb, "Samsung-location");
    const comment = segment(0xfe, "taken at 12 Home St");
    const dqt = segment(0xdb, [0x00, ...new Array(64).fill(1)]);
    const sos = segment(0xda, [0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
    const scan = [0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56]; // stuffed FF00 and a restart marker inside the scan
    const trailer = [0xff, 0xd8, ...segment(0xe1, "Exif\0\0GPS-in-secondary"), 0xff, 0xd9];
    const input = Uint8Array.from([0xff, 0xd8, ...jfif, ...exif, ...icc, ...mpf, ...maker, ...comment, ...adobe, ...dqt, ...sos, ...scan, 0xff, 0xd9, ...trailer]);
    const out = stripJpegMetadata(input);
    expect(Array.from(out)).toEqual([0xff, 0xd8, ...jfif, ...icc, ...adobe, ...dqt, ...sos, ...scan, 0xff, 0xd9]);
  });

  it("reads orientation in both byte orders and ignores broken EXIF", () => {
    const be = Uint8Array.from([..."Exif\0\0"].map((c) => c.charCodeAt(0)).concat([0x4d, 0x4d, 0, 0x2a, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 8, 0, 0, 0, 0, 0, 0]));
    const le = Uint8Array.from([..."Exif\0\0"].map((c) => c.charCodeAt(0)).concat([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, 3, 0, 0, 0, 0, 0, 0, 0]));
    expect(readOrientation(be)).toBe(8);
    expect(readOrientation(le)).toBe(3);
    expect(readOrientation(Uint8Array.from([..."Exif\0\0MM\0*\xff\xff\xff\xff"].map((c) => c.charCodeAt(0))))).toBeNull();
    expect(readOrientation(Uint8Array.from([1, 2, 3]))).toBeNull();
  });

  it("refuses anything that is not a whole JPEG instead of uploading it as is", async () => {
    const png = new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 3, background: "#000" } }).png().toBuffer());
    expect(() => stripJpegMetadata(png)).toThrow(UnsupportedPhotoError);
    const jpeg = await phonePhoto();
    expect(() => stripJpegMetadata(jpeg.subarray(0, jpeg.length - 40))).toThrow(UnsupportedPhotoError);
    expect(() => stripJpegMetadata(Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]))).toThrow(UnsupportedPhotoError);
  });

  it("refuses a photo over the bucket's size limit", () => {
    const big = new Uint8Array(PHOTO_MAX_BYTES + 10);
    big.set([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]);
    big.set([0xff, 0xd9], big.length - 2);
    expect(() => stripJpegMetadata(big)).toThrow(/too large/);
  });
});
