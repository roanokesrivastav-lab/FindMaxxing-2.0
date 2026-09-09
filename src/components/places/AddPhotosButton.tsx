"use client";
import { ImagePlus } from "lucide-react";
import { useActionState, useState } from "react";
import { useRouter } from "next/navigation";
import { Sheet } from "@/components/ui/Sheet";
import { Button } from "@/components/ui/Button";
import { MultiPhotoInput } from "@/components/shared/MultiPhotoInput";
import { addPlacePhotosAction } from "@/server/actions/places";
import { useToast } from "@/components/ui/Toast";
import type { ActionResult } from "@/server/actions/result";

/** Adds photos to a place that already exists. Open to any signed-in contributor. */
export function AddPhotosButton({ placeId, room }: { placeId: string; room: number }) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  const [state, action, pending] = useActionState(
    async (prev: ActionResult | null, formData: FormData) => {
      const res = await addPlacePhotosAction(prev, formData);
      if (res.ok) {
        setOpen(false);
        toast("Photos added. Thanks.", "success");
        router.refresh();
      }
      return res;
    },
    null,
  );

  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="chip w-full justify-center"
      >
        <ImagePlus size={15} />
        Add photos
      </button>

      <Sheet open={open} onClose={() => setOpen(false)} title="Add photos">
        <p className="text-sm text-muted -mt-1 mb-4">
          Show people what it actually looks like. {room} slot{room === 1 ? "" : "s"} left.
        </p>
        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="placeId" value={placeId} />
          <MultiPhotoInput name="photos" label="Photos" hint={`up to ${room}`} max={room} error={errors.photos} />
          {state && !state.ok && !Object.keys(errors).length ? (
            <p className="text-sm text-danger font-medium" role="alert">
              {state.error}
            </p>
          ) : null}
          <Button type="submit" loading={pending} variant="ink">
            Upload
          </Button>
        </form>
      </Sheet>
    </>
  );
}
