/**
 * The photo route is the only way to a private place photo, so its caching
 * must never let a browser skip the visibility check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const access = { allowed: true };
/** Stored objects by path. The photo's own object is "owner/abc.png" (legacy, no sizes) unless a test adds sizes. */
const objects = new Map<string, Uint8Array<ArrayBuffer>>();
const deliverPlacePhoto = vi.fn(async (path: string) => {
  const body = objects.get(path);
  return body ? { kind: "bytes" as const, body, contentType: "image/png" } : null;
});

vi.mock("@/lib/auth/server", () => ({ getViewer: async () => ({ id: "viewer" }) }));
vi.mock("@/lib/data", () => ({
  getRepository: async () => ({
    places: { getPhotoObject: async () => (access.allowed ? { storagePath: "owner/abc.png" } : null) },
    storage: { deliverPlacePhoto },
  }),
}));

const { GET } = await import("../src/app/api/photos/[id]/route");
const ID = "9f0e0a52-4c7e-4a8e-9d8c-2f1b3c4d5e6f";
const request = (headers: Record<string, string> = {}, query = "") =>
  GET(new Request(`http://localhost/api/photos/${ID}${query}`, { headers }), { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  access.allowed = true;
  objects.clear();
  objects.set("owner/abc.png", new Uint8Array([1, 2, 3]));
  deliverPlacePhoto.mockClear();
});

describe("GET /api/photos/[id]", () => {
  it("serves an authorized photo that the browser must revalidate before reuse", async () => {
    const res = await request();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("etag")).toMatch(/^"[\w-]+"$/);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("answers a still-authorized revalidation with 304 and no Storage download", async () => {
    const etag = (await request()).headers.get("etag")!;
    deliverPlacePhoto.mockClear();
    const res = await request({ "if-none-match": etag });
    expect(res.status).toBe(304);
    expect(deliverPlacePhoto).not.toHaveBeenCalled();
  });

  it("refuses a revoked viewer on the next request, even with a cached copy", async () => {
    const etag = (await request()).headers.get("etag")!;
    access.allowed = false;
    const res = await request({ "if-none-match": etag });
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("does not match a different ETag", async () => {
    expect((await request({ "if-none-match": '"something-else"' })).status).toBe(200);
  });

  it("serves the requested size when it is stored", async () => {
    objects.set("owner/abc.sm.webp", new Uint8Array([4]));
    objects.set("owner/abc.md.webp", new Uint8Array([5]));
    expect(new Uint8Array(await (await request({}, "?size=sm")).arrayBuffer())).toEqual(new Uint8Array([4]));
    expect(new Uint8Array(await (await request({}, "?size=md")).arrayBuffer())).toEqual(new Uint8Array([5]));
    expect(new Uint8Array(await (await request({}, "?size=lg")).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    // Anything else is the full size, not an error.
    expect(new Uint8Array(await (await request({}, "?size=../../x")).arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("falls back to the stored original for a legacy photo without sizes", async () => {
    const res = await request({}, "?size=sm");
    expect(res.status).toBe(200);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(deliverPlacePhoto.mock.calls.map(([path]) => path)).toEqual(["owner/abc.sm.webp", "owner/abc.png"]);
  });

  it("gives each size its own ETag, so a cached small copy never answers for a large one", async () => {
    const sm = (await request({}, "?size=sm")).headers.get("etag")!;
    const lg = (await request({}, "?size=lg")).headers.get("etag")!;
    expect(sm).not.toBe(lg);
    expect((await request({ "if-none-match": sm }, "?size=lg")).status).toBe(200);
    expect((await request({ "if-none-match": sm }, "?size=sm")).status).toBe(304);
  });

  it("404s when neither the size nor the original exists", async () => {
    objects.clear();
    expect((await request({}, "?size=md")).status).toBe(404);
  });
});
