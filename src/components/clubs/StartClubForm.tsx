"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClubAction } from "@/server/actions/events";
import { Button } from "@/components/ui/Button";
import { FormField, Input, Textarea } from "@/components/ui/Field";

/** R3: a series host starts a club around this series. */
export function StartClubForm({ seriesId }: { seriesId: string }) {
  const [open, setOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [pending, start] = useTransition();
  const router = useRouter();
  if (!open) return <Button type="button" variant="secondary" onClick={() => setOpen(true)}>Start a club around this series</Button>;
  return (
    <form
      className="flex flex-col gap-item"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        start(async () => {
          const res = await createClubAction(seriesId, String(f.get("clubName") ?? ""), String(f.get("clubDescription") ?? ""));
          if (!res.ok) setErrors({ clubName: res.fieldErrors?.name ?? (res.fieldErrors ? undefined : res.error), clubDescription: res.fieldErrors?.description });
          else router.push(`/clubs/${res.data.id}`);
        });
      }}
    >
      <FormField label="Club name" htmlFor="clubName" error={errors.clubName}>
        <Input id="clubName" name="clubName" required minLength={3} maxLength={80} error={errors.clubName} />
      </FormField>
      <FormField label="What it's about" htmlFor="clubDescription" hint="optional" error={errors.clubDescription}>
        <Textarea id="clubDescription" name="clubDescription" maxLength={600} error={errors.clubDescription} />
      </FormField>
      <div className="flex gap-item"><Button type="submit" variant="ink" loading={pending}>Create club</Button><Button type="button" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button></div>
    </form>
  );
}
