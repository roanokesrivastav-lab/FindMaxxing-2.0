"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Camera, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { removePersonalPhotoAction, uploadPersonalPhotoAction } from "@/server/actions/personalPhotos";

/**
 * Your personal photo of a place (2.8), in the You block. Only you ever see it. Needed
 * only before your first rating or review; a photo from your library is fine and
 * nobody checks that you went. It never gates saving, planning or joining.
 */
export function PersonalPhotoBlock({ placeId, photoUrl, required }: { placeId: string; photoUrl: string | null; required: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();

  const upload = (file: File | undefined) => {
    if (!file) return;
    const data = new FormData();
    data.set("placeId", placeId);
    data.set("photo", file);
    start(async () => {
      const res = await uploadPersonalPhotoAction(data);
      if (!res.ok) {
        setError(res.error);
        return toast(res.error, "error");
      }
      setError(null);
      toast(photoUrl ? "Photo changed" : "Photo added. Only you can see it.", "success");
      router.refresh();
    });
  };
  const remove = () =>
    start(async () => {
      const res = await removePersonalPhotoAction(placeId);
      if (!res.ok) return toast(res.error, "error");
      toast("Photo removed", "success");
      router.refresh();
    });

  return (
    <div className="flex flex-col gap-item" data-personal-photo={photoUrl ? "set" : required ? "required" : "optional"}>
      <p className="type-body font-semibold text-ink inline-flex flex-wrap items-center gap-item">
        Your photo
        <span className="font-normal text-ink-2 inline-flex items-center gap-hair">
          <Lock size="0.9em" aria-hidden /> Only you
        </span>
      </p>
      {photoUrl ? (
        <div className="flex flex-wrap items-center gap-row">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={photoUrl} alt="Your photo of this place" className="h-20 w-20 rounded-xl object-cover bg-paper-2" />
          <div className="flex flex-wrap gap-item">
            <Button type="button" size="sm" variant="secondary" onClick={() => input.current?.click()} aria-busy={pending}>
              Change
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={remove} aria-busy={pending}>
              Remove
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="type-body text-ink-2" id={`${id}-why`}>
            {required
              ? "Add a photo of this place before your first rating. Only you will see it, and it shows here instead of the public photo. A photo from your library is fine."
              : "Add your own photo of this place. Only you will see it."}
          </p>
          <div>
            <Button type="button" size="sm" variant={required ? "ink" : "secondary"} onClick={() => input.current?.click()} aria-busy={pending} aria-describedby={`${id}-why`}>
              <Camera size={14} aria-hidden /> {pending ? "Uploading…" : "Add your photo"}
            </Button>
          </div>
        </>
      )}
      <label htmlFor={`${id}-file`} className="sr-only">Choose your photo</label>
      <input
        ref={input}
        id={`${id}-file`}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => upload(e.target.files?.[0])}
      />
      {error ? <p className="type-body text-danger" role="alert">{error}</p> : null}
    </div>
  );
}
