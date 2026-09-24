/**
 * The photo route is the only way to a private place photo, so its caching
 * must never let a browser skip the visibility check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const access = { allowed: true };
const deliverPlacePhoto = vi.fn(async () => ({ kind: "bytes" as const, body: new Uint8Array([1, 2, 3]), contentType: "image/png" }));

vi.mock("@/lib/auth/server", () => ({ getViewer: async () => ({ id: "viewer" }) }));
vi.mock("@/lib/data", () => ({
  getRepository: async () => ({
    places: { getPhotoObject: async () => (access.allowed ? { storagePath: "owner/abc.png" } : null) },
    storage: { deliverPlacePhoto },
  }),
}));

const { GET } = await import("../src/app/api/photos/[id]/route");
const ID = "9f0e0a52-4c7e-4a8e-9d8c-2f1b3c4d5e6f";
const request = (headers: Record<string, string> = {}) =>
  GET(new Request(`http://localhost/api/photos/${ID}`, { headers }), { params: Promise.resolve({ id: ID }) });

beforeEach(() => {
  access.allowed = true;
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
});
