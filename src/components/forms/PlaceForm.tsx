"use client";
import { useActionState, useState } from "react";
import { createPlaceAction, updatePlaceAction } from "@/server/actions/places";
import type { Place } from "@/lib/data/types";
import { Button } from "@/components/ui/Button";
import { FormField, Input, Textarea } from "@/components/ui/Field";
import { AddressFields, composeGeocodeQuery } from "@/components/shared/AddressFields";
import { CategoryPicker } from "@/components/shared/CategoryPicker";
import { TagPicker } from "@/components/shared/TagPicker";
import { MultiPhotoInput } from "@/components/shared/MultiPhotoInput";
import { VisibilityPicker } from "@/components/shared/VisibilityPicker";
import { LocationPicker } from "@/components/map/LocationPicker";
import { useFormSubmit } from "@/lib/forms/useFormSubmit";
import { PLACE_CATEGORIES } from "@/lib/data/taxonomy";
import { Lightbulb } from "lucide-react";

export function PlaceForm({ defaultCity, initial, edit = false }: { defaultCity: string; initial?: Place; edit?: boolean }) {
  const [state, action, pending] = useActionState(edit ? updatePlaceAction : createPlaceAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};
  const value = (v: string | null | undefined) => v ?? "";
  const { formRef, onSubmit } = useFormSubmit(action, state);

  // Tracked only to feed the address lookup; the inputs stay uncontrolled so a
  // failed submit leaves whatever the user typed untouched.
  const [address, setAddress] = useState(initial?.address ?? "");
  const [streetName, setStreetName] = useState("");
  const [neighborhood, setNeighborhood] = useState(initial?.neighborhood ?? "");
  const [city, setCity] = useState(initial?.city ?? defaultCity);
  const [addressTouched, setAddressTouched] = useState(false);

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-6">
      {edit ? <input type="hidden" name="placeId" value={initial?.id} /> : null}
      <FormField label="Name" htmlFor="name" error={errors.name}>
        <Input id="name" name="name" defaultValue={initial?.name} placeholder="e.g. Thurman Hollow Courts" required maxLength={80} error={errors.name} autoComplete="off" />
      </FormField>

      <CategoryPicker name="categorySlug" categories={PLACE_CATEGORIES} initial={initial?.categorySlug} error={errors.categorySlug} />

      <FormField label="What is it?" htmlFor="description" error={errors.description} hint="10–1000 chars">
        <Textarea id="description" name="description" defaultValue={initial?.description} required minLength={10} maxLength={1000} placeholder="What happens here, who it's for, what to expect." error={errors.description} />
      </FormField>

      <div className="rounded-2xl bg-sun-100/60 border border-sun/30 p-4">
        <label htmlFor="localTip" className="flex items-center gap-2 text-sm font-bold mb-1.5">
          <Lightbulb size={16} className="text-sun" /> Local tip <span className="text-xs font-medium text-muted">optional but the whole point</span>
        </label>
        <Textarea id="localTip" name="localTip" defaultValue={value(initial?.localTip)} maxLength={280} rows={2} placeholder="The thing only regulars know." className="bg-surface" error={errors.localTip} />
        {errors.localTip ? <p className="mt-1.5 text-sm text-danger">{errors.localTip}</p> : null}
      </div>

      <AddressFields
        includeNeighborhood
        values={{ city, streetName, exactAddress: address, neighborhood }}
        errors={errors}
        onChange={(field, next) => {
          setAddressTouched(true);
          if (field === "city") setCity(next);
          else if (field === "streetName") setStreetName(next);
          else if (field === "exactAddress") setAddress(next);
          else if (field === "neighborhood") setNeighborhood(next);
        }}
      />
      <LocationPicker
        initial={initial ? { lat: initial.lat, lng: initial.lng } : null}
        addressQuery={addressTouched ? composeGeocodeQuery({ city, streetName, exactAddress: address, neighborhood }) : ""}
        error={errors.lat ?? errors.lng ? "Drop a pin on the map" : undefined}
      />

      <TagPicker name="tags" label="Who is this for?" initial={initial?.tags} error={errors.tags} />
      {/* Photos and trust tier are set at creation and then managed on the place
          page itself, so editing details never disturbs either. */}
      {!edit ? (
        <>
          <MultiPhotoInput name="photos" error={errors.photos} hint="up to 6" />
          <VisibilityPicker error={errors.visibility} />
        </>
      ) : (
        <p className="text-xs text-muted">
          Photos and visibility are managed from the place page. Editing details will not change either.
        </p>
      )}

      {state && !state.ok && !Object.keys(errors).length ? <p className="text-sm text-danger font-medium" role="alert">{state.error}</p> : null}
      <div className="sticky bottom-0 -mx-4 px-4 py-3 bg-paper/90 backdrop-blur border-t border-line safe-bottom">
        <Button type="submit" size="lg" loading={pending} className="w-full">{edit ? "Save place" : "Add to the map"}</Button>
      </div>
    </form>
  );
}
