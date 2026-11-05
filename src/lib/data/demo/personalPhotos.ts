/**
 * Demo twin of 0063_personal_photos.sql (roadmap 2.8). Personal photos are stored
 * as files named `personal-<owner>-<uuid>.webp` in the demo upload folder, are never
 * served by /api/uploads or /api/photos (both refuse that prefix), and are handed
 * only to their owner by /api/personal-photos/[placeId].
 */
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DataRepository } from "../repository";
import { DataError } from "../types";
import type { RateLimitAction } from "@/lib/rateLimits";
import { newId } from "@/lib/utils/ids";
import { personalPhotoUrl, type PersonalPhoto } from "@/lib/places/personalPhotos";
import { sniffImageType } from "../photos";
import { isModeratorIn, type DemoState, type PlaceRow } from "./store";
import { UPLOAD_DIR } from "./uploads";

export interface PersonalPhotoRow { userId: string; placeId: string; file: string; createdAt: string; updatedAt: string }
export interface PublicPhotoRow { placeId: string; photoId: string; setBy: string | null; permissionNote: string; createdAt: string }

const FILE = /^personal-[0-9a-f]{8}-[0-9a-f-]{36}\.webp$/;

export function ensurePersonalPhotos(state: DemoState): PersonalPhotoRow[] {
  const s = state as DemoState & { personalPlacePhotos?: PersonalPhotoRow[] };
  s.personalPlacePhotos ??= [];
  return s.personalPlacePhotos;
}
export function ensurePublicPhotos(state: DemoState): PublicPhotoRow[] {
  const s = state as DemoState & { placePublicPhotos?: PublicPhotoRow[] };
  s.placePublicPhotos ??= [];
  return s.placePublicPhotos;
}
export function removePersonalFile(file: string) {
  if (!FILE.test(file)) return;
  try { unlinkSync(path.join(UPLOAD_DIR, file)); } catch { /* already gone */ }
}

export function createDemoPersonalPhotos(
  state: DemoState,
  h: { persist(): void; assertActive(userId: string): void; rateLimit(userId: string, action: RateLimitAction): () => void; canViewPlace(p: PlaceRow, viewerId: string | null): boolean },
): DataRepository["personalPhotos"] {
  const toPhoto = (r: PersonalPhotoRow): PersonalPhoto => ({ placeId: r.placeId, url: personalPhotoUrl(r.placeId, r.updatedAt), createdAt: r.createdAt, updatedAt: r.updatedAt });
  const rowOf = (ownerId: string, placeId: string) => ensurePersonalPhotos(state).find((r) => r.userId === ownerId && r.placeId === placeId);
  return {
    async get(ownerId, placeId) {
      const row = rowOf(ownerId, placeId);
      return row ? toPhoto(row) : null;
    },
    async upload(ownerId, placeId, image) {
      h.assertActive(ownerId);
      const place = state.places.find((p) => p.id === placeId);
      if (!place || !h.canViewPlace(place, ownerId)) throw new DataError("Place not found", "not_found");
      const counted = h.rateLimit(ownerId, "photos");
      const file = `personal-${ownerId.slice(0, 8)}-${newId()}.webp`;
      mkdirSync(UPLOAD_DIR, { recursive: true });
      writeFileSync(path.join(UPLOAD_DIR, file), image.main);
      const now = new Date().toISOString();
      const existing = rowOf(ownerId, placeId);
      if (existing) {
        removePersonalFile(existing.file);
        existing.file = file;
        existing.updatedAt = now;
      } else {
        ensurePersonalPhotos(state).push({ userId: ownerId, placeId, file, createdAt: now, updatedAt: now });
      }
      counted();
      h.persist();
      return toPhoto(rowOf(ownerId, placeId)!);
    },
    async remove(ownerId, placeId) {
      h.assertActive(ownerId);
      const rows = ensurePersonalPhotos(state);
      const row = rowOf(ownerId, placeId);
      if (!row) return;
      rows.splice(rows.indexOf(row), 1);
      removePersonalFile(row.file);
      h.persist();
    },
    async deliver(ownerId, placeId) {
      const row = rowOf(ownerId, placeId);
      if (!row || !FILE.test(row.file)) return null;
      try {
        const body = new Uint8Array(readFileSync(path.join(UPLOAD_DIR, row.file)));
        return { kind: "bytes", body, contentType: sniffImageType(body) };
      } catch {
        return null;
      }
    },
  };
}

export function createDemoPublicPhotos(
  state: DemoState,
  h: { persist(): void; assertActive(userId: string): void; canViewPlace(p: PlaceRow, viewerId: string | null): boolean; summary(id: string | null): { id: string; displayName: string; username: string } | null },
): DataRepository["publicPhotos"] {
  return {
    async get(placeId, viewerId = null) {
      const place = state.places.find((p) => p.id === placeId);
      if (!place || !h.canViewPlace(place, viewerId)) return null;
      const row = ensurePublicPhotos(state).find((r) => r.placeId === placeId);
      if (!row || !state.placePhotos.some((p) => p.id === row.photoId)) return null;
      return { placeId, photoId: row.photoId, setBy: h.summary(row.setBy), permissionNote: row.permissionNote, createdAt: row.createdAt };
    },
    async set(moderatorId, placeId, photoId, note) {
      h.assertActive(moderatorId);
      if (!isModeratorIn(state, moderatorId)) throw new DataError("Only the team can set a public photo", "forbidden");
      const permissionNote = (note ?? "").trim();
      if (!permissionNote || permissionNote.length > 300) throw new DataError("Say who took it or what permission covers it", "invalid");
      const photos = state.placePhotos.filter((p) => p.placeId === placeId);
      if (!photos.some((p) => p.id === photoId)) throw new DataError("That photo is not one of this place's photos", "invalid");
      const rows = ensurePublicPhotos(state);
      const now = new Date().toISOString();
      const existing = rows.find((r) => r.placeId === placeId);
      if (existing) Object.assign(existing, { photoId, setBy: moderatorId, permissionNote, createdAt: now });
      else rows.push({ placeId, photoId, setBy: moderatorId, permissionNote, createdAt: now });
      photos
        .sort((a, b) => Number(b.id === photoId) - Number(a.id === photoId) || a.sortOrder - b.sortOrder || (a.id < b.id ? -1 : 1))
        .forEach((p, i) => (p.sortOrder = i));
      h.persist();
    },
  };
}
