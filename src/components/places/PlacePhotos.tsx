"use client";

import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import type { Photo } from "@/lib/data/types";
import { removePlacePhotoAction } from "@/server/actions/places";
import { useToast } from "@/components/ui/Toast";
import { AddPhotosButton } from "./AddPhotosButton";
import { MAX_PLACE_PHOTOS } from "@/lib/data/types";

export function PlacePhotos({ placeId, photos, viewerId, creatorId, signedIn }: { placeId: string; photos: Photo[]; viewerId: string | null; creatorId: string | null; signedIn: boolean }) {
  const router = useRouter();
  const { toast } = useToast();
  const [pending, start] = useTransition();
  const room = MAX_PLACE_PHOTOS - photos.length;
  if (!photos.length && !signedIn) return null;
  return (
    <section className="mt-6">
      <div className="flex items-center justify-between mb-2">
        <h2 className="text-lg font-bold">Photos</h2>
        <span className="text-xs text-muted">
          {photos.length}/{MAX_PLACE_PHOTOS}
        </span>
      </div>
      {!photos.length ? (
        <p className="text-sm text-muted mb-2">No photos yet. Add the first one.</p>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {photos.map((photo) => (
          <div key={photo.id} className="relative aspect-[4/3] overflow-hidden rounded-2xl bg-surface-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={photo.url} alt="Place" className="h-full w-full object-cover" />
            {viewerId && (photo.uploaderId === viewerId || creatorId === viewerId) ? (
              <button type="button" aria-label="Remove photo" disabled={pending} onClick={() => start(async () => {
                const result = await removePlacePhotoAction(placeId, photo.id);
                if (!result.ok) toast(result.error, "error");
                else { toast("Photo removed", "success"); router.refresh(); }
              })} className="absolute right-2 top-2 h-9 w-9 rounded-full bg-ink/80 text-white inline-flex items-center justify-center disabled:opacity-50">
                <Trash2 size={15} />
              </button>
            ) : null}
          </div>
        ))}
      </div>
      {signedIn && room > 0 ? (
        <div className="mt-2">
          <AddPhotosButton placeId={placeId} room={room} />
        </div>
      ) : null}
    </section>
  );
}
