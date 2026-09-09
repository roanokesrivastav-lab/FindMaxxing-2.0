"use client";
import { useActionState } from "react";
import { useFormSubmit } from "@/lib/forms/useFormSubmit";
import { updateProfileAction } from "@/server/actions/profile";
import { Button } from "@/components/ui/Button";
import { FormField, Input, Textarea } from "@/components/ui/Field";
import { TagPicker } from "@/components/shared/TagPicker";
import { PhotoInput } from "@/components/shared/PhotoInput";
import type { Profile } from "@/lib/data/types";

export function ProfileForm({ profile }: { profile: Profile }) {
  const [state, action, pending] = useActionState(updateProfileAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const { formRef, onSubmit } = useFormSubmit(action, state);
  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="flex items-center gap-5">
        <PhotoInput name="avatar" label="Photo" hint="" shape="round" currentUrl={profile.avatarUrl} error={errors.avatar} />
        <div className="flex-1 flex flex-col gap-4">
          <FormField label="Display name" htmlFor="displayName" error={errors.displayName}>
            <Input id="displayName" name="displayName" defaultValue={profile.displayName} required maxLength={50} error={errors.displayName} />
          </FormField>
          <FormField label="Username" htmlFor="username" error={errors.username}>
            <div className="relative">
              <span className="absolute left-4 top-1/2 -translate-y-1/2 text-muted">@</span>
              <Input id="username" name="username" defaultValue={profile.username} required minLength={3} maxLength={24} className="pl-8" pattern="[a-zA-Z0-9_]+" error={errors.username} />
            </div>
          </FormField>
        </div>
      </div>

      <FormField label="Bio" htmlFor="bio" hint="optional · 240 chars" error={errors.bio}>
        <Textarea id="bio" name="bio" defaultValue={profile.bio ?? ""} maxLength={240} rows={3} placeholder="What you're into, what you're looking for." />
      </FormField>

      <FormField label="Home city" htmlFor="homeCity" hint="optional" error={errors.homeCity}>
        <Input id="homeCity" name="homeCity" defaultValue={profile.homeCity ?? ""} maxLength={80} placeholder="Columbus" />
      </FormField>

      <TagPicker name="interests" label="Interests" hint="pick up to 12" initial={profile.interests} max={12} error={errors.interests} />

      {state && !state.ok && !Object.keys(errors).length ? (
        <p className="text-sm text-danger font-medium" role="alert">
          {state.error}
        </p>
      ) : null}

      <div className="sticky bottom-0 -mx-4 px-4 py-3 bg-paper/90 backdrop-blur border-t border-line safe-bottom">
        <Button type="submit" size="lg" variant="ink" loading={pending} className="w-full">
          Save profile
        </Button>
      </div>
    </form>
  );
}
