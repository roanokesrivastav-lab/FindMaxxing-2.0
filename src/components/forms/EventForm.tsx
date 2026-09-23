"use client";
import { useActionState, useCallback, useMemo, useState } from "react";
import { createEventAction, updateEventAction } from "@/server/actions/events";
import type { Event } from "@/lib/data/types";
import { Button } from "@/components/ui/Button";
import { FormField, Input, Textarea, Select } from "@/components/ui/Field";
import { AddressFields, composeGeocodeQuery } from "@/components/shared/AddressFields";
import { CategoryPicker } from "@/components/shared/CategoryPicker";
import { TagPicker } from "@/components/shared/TagPicker";
import { LocationPicker } from "@/components/map/LocationPicker";
import { EVENT_CATEGORIES } from "@/lib/data/taxonomy";
import { toDateInputValue, toTimeInputValue } from "@/lib/utils/format";
import type { LngLat } from "@/lib/map/types";
import { useFormSubmit } from "@/lib/forms/useFormSubmit";

export interface PlaceOption {
  id: string;
  name: string;
  lat: number;
  lng: number;
  address: string | null;
  categorySlug: string;
  city?: string;
}

export function EventForm({ places, initialPlaceId, initial, defaultCity = "", edit = false }: { places: PlaceOption[]; initialPlaceId?: string | null; initial?: Event; defaultCity?: string; edit?: boolean }) {
  const [state, action, pending] = useActionState(edit ? updateEventAction : createEventAction, null);
  const errors = state && !state.ok ? (state.fieldErrors ?? {}) : {};

  // Stamped at submit time rather than parked in a hidden input, so there is no
  // path where a submit is silently interpreted as UTC.
  const stampTimezone = useCallback((formData: FormData) => {
    formData.set("tzOffsetMinutes", String(new Date().getTimezoneOffset()));
  }, []);
  const { formRef, onSubmit } = useFormSubmit(action, state, { onBeforeSubmit: stampTimezone });
  const startingPlaceId = initial?.placeId ?? initialPlaceId ?? "";
  const [placeId, setPlaceId] = useState(startingPlaceId);
  const linked = useMemo(() => places.find((p) => p.id === placeId) ?? null, [places, placeId]);
  const [locationName, setLocationName] = useState(initial?.locationName ?? linked?.name ?? "");
  const [point, setPoint] = useState<LngLat | null>(initial ? { lat: initial.lat, lng: initial.lng } : linked ? { lat: linked.lat, lng: linked.lng } : null);
  const [address, setAddress] = useState(initial?.address ?? linked?.address ?? "");
  const [streetName, setStreetName] = useState("");
  const [city, setCity] = useState(initial ? extractCity(initial.address) || linked?.city || defaultCity : linked?.city || defaultCity || "");
  const [addressTouched, setAddressTouched] = useState(false);

  const selectPlace = (id: string) => {
    setPlaceId(id);
    const next = places.find((p) => p.id === id);
    if (next) {
      setLocationName(next.name);
      setAddress(next.address ?? "");
      setCity(next.city ?? city);
      setStreetName("");
      setAddressTouched(false);
      setPoint({ lat: next.lat, lng: next.lng });
    } else {
      setLocationName("");
      setAddress("");
      setStreetName("");
      setAddressTouched(false);
      setPoint(null);
    }
  };

  const defaults = useMemo(() => {
    const d = initial ? new Date(initial.startsAt) : new Date();
    if (!initial) { d.setDate(d.getDate() + 1); d.setHours(18, 0, 0, 0); }
    return { date: toDateInputValue(d), time: toTimeInputValue(d), min: toDateInputValue(new Date()) };
  }, [initial]);
  const endDefaults = initial?.endsAt ? { date: toDateInputValue(new Date(initial.endsAt)), time: toTimeInputValue(new Date(initial.endsAt)) } : null;

  return (
    <form ref={formRef} onSubmit={onSubmit} className="flex flex-col gap-6">
      {edit ? <input type="hidden" name="eventId" value={initial?.id} /> : null}

      <FormField label="Title" htmlFor="title" error={errors.title}>
        <Input id="title" name="title" defaultValue={initial?.title} placeholder="e.g. Sunday pickup soccer" required maxLength={90} error={errors.title} autoComplete="off" />
      </FormField>
      <CategoryPicker name="categorySlug" categories={EVENT_CATEGORIES} initial={initial?.categorySlug} error={errors.categorySlug} />
      <FormField label="Details" htmlFor="description" error={errors.description} hint="10–1200 chars">
        <Textarea id="description" name="description" defaultValue={initial?.description} required minLength={10} maxLength={1200} placeholder="What to bring, skill level, where exactly to meet." error={errors.description} />
      </FormField>

      <div className="grid grid-cols-3 gap-3">
        <FormField label="Date" htmlFor="date" error={errors.date}><Input id="date" name="date" type="date" required defaultValue={defaults.date} min={defaults.min} error={errors.date} /></FormField>
        <FormField label="Starts" htmlFor="startTime" error={errors.startTime}><Input id="startTime" name="startTime" type="time" required defaultValue={defaults.time} error={errors.startTime} /></FormField>
        <FormField label="Ends" htmlFor="endTime" hint="optional" error={errors.endTime}><Input id="endTime" name="endTime" type="time" defaultValue={endDefaults?.time} error={errors.endTime} /></FormField>
      </div>

      <FormField label="At a place on the map?" htmlFor="placeId" hint="optional" error={errors.placeId}>
        <Select id="placeId" name="placeId" value={placeId} onChange={(e) => selectPlace(e.target.value)}>
          <option value="">Somewhere else (set below)</option>
          {places.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </Select>
      </FormField>
      <FormField label="Location name" htmlFor="locationName" error={errors.locationName}>
        <Input id="locationName" name="locationName" required maxLength={120} value={locationName} onChange={(e) => setLocationName(e.target.value)} placeholder="e.g. Tuttle Lot Fields, north pitch" error={errors.locationName} />
      </FormField>
      <AddressFields
        includeCityInAddress
        values={{ city, streetName, exactAddress: address }}
        errors={errors}
        onChange={(field, next) => {
          setAddressTouched(true);
          if (field === "city") setCity(next);
          else if (field === "streetName") setStreetName(next);
          else if (field === "exactAddress") setAddress(next);
        }}
      />
      <LocationPicker
        key={placeId || "custom"}
        initial={point}
        onChange={setPoint}
        addressQuery={addressTouched ? composeGeocodeQuery({ city, streetName, exactAddress: address }) : ""}
        preserveInitialPin={edit}
        label="Meeting point"
        error={errors.lat ?? errors.lng ? "Drop a pin on the map" : undefined}
      />
      <FormField label="Capacity" htmlFor="capacity" hint="optional" error={errors.capacity}>
        <Input id="capacity" name="capacity" type="number" min={2} max={5000} defaultValue={initial?.capacity ?? ""} placeholder="Leave blank for unlimited" error={errors.capacity} />
      </FormField>
      <TagPicker name="tags" label="Tags" initial={initial?.tags} error={errors.tags} />
      {state && !state.ok && !Object.keys(errors).length ? <p className="text-sm text-danger font-medium" role="alert">{state.error}</p> : null}
      <div className="sticky bottom-0 -mx-4 px-4 py-3 bg-paper/90 backdrop-blur border-t border-line safe-bottom">
        <Button type="submit" size="lg" variant="pulse" loading={pending} className="w-full">{edit ? "Save event" : "Create event"}</Button>
      </div>
    </form>
  );
}

/** Existing events only have one address snapshot; use its final segment as a city hint. */
function extractCity(address: string | null): string {
  const parts = (address ?? "").split(",").map((part) => part.trim()).filter(Boolean);
  return parts.length > 1 ? parts[parts.length - 1] : "";
}
