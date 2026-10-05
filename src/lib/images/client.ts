/**
 * Browser-side shrink before upload. Phone photos are often 3–12MB; sending
 * them whole is slow on mobile data and runs into the server-action body limit.
 * The server pipeline still decodes, validates and re-encodes everything, so
 * this is only about transfer size, and any failure falls back to the original.
 */
export const UPLOAD_MAX_EDGE = 2400;
const UPLOAD_QUALITY = 0.88;
/** Files already this small (and within the edge) are sent untouched. */
const KEEP_BELOW_BYTES = 1.5 * 1024 * 1024;

export async function shrinkForUpload(file: File): Promise<File> {
  if (typeof createImageBitmap !== "function" || typeof document === "undefined") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return file; // Let the server give the real verdict on what this is.
  }
  try {
    const scale = Math.min(1, UPLOAD_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= KEEP_BELOW_BYTES) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    // JPEG has no alpha: transparent PNG areas would otherwise turn black.
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", UPLOAD_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
    return new File([blob], name, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap.close();
  }
}
