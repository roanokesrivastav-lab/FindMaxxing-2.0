"use client";
import { FormField, Input } from "@/components/ui/Field";
import { composeAddress, composeGeocodeQuery } from "@/lib/map/geocode";

export { composeAddress, composeGeocodeQuery };

export interface AddressFieldValues {
  city: string;
  streetName: string;
  exactAddress: string;
  neighborhood?: string;
}

export function AddressFields({
  values,
  errors = {},
  onChange,
  includeNeighborhood = false,
  includeCityInAddress = false,
}: {
  values: AddressFieldValues;
  errors?: Record<string, string | undefined>;
  onChange: (field: keyof AddressFieldValues, value: string) => void;
  includeNeighborhood?: boolean;
  /** Events have no separate city column, so retain city in their address snapshot. */
  includeCityInAddress?: boolean;
}) {
  const storedAddress = composeAddress(values, includeCityInAddress);

  return (
    <fieldset className="rounded-2xl border border-line bg-surface-2/40 p-4">
      <legend className="px-1 text-sm font-bold">Address <span className="font-medium text-muted">· start broad, get as specific as you like</span></legend>
      <div className="mt-1 flex flex-col gap-4">
        <FormField label="City" htmlFor="city" hint="required" error={errors.city}>
          <Input
            id="city"
            name="city"
            value={values.city}
            onChange={(e) => onChange("city", e.target.value)}
            placeholder="e.g. Columbus"
            autoComplete="address-level2"
            required
            maxLength={80}
            error={errors.city}
          />
        </FormField>
        <FormField label="Street name" htmlFor="streetName" hint="optional" error={errors.streetName}>
          <Input
            id="streetName"
            name="streetName"
            value={values.streetName}
            onChange={(e) => onChange("streetName", e.target.value)}
            placeholder="e.g. High Street"
            autoComplete="address-line1"
            maxLength={120}
            error={errors.streetName}
          />
        </FormField>
        <FormField label="Exact address" htmlFor="address" hint="optional" error={errors.address}>
          <Input
            id="address"
            value={values.exactAddress}
            onChange={(e) => onChange("exactAddress", e.target.value)}
            placeholder="House number, building, or full address"
            autoComplete="street-address"
            maxLength={160}
            error={errors.address}
          />
          <input type="hidden" name="address" value={storedAddress} />
        </FormField>
        {includeNeighborhood ? (
          <FormField label="Neighborhood" htmlFor="neighborhood" hint="optional" error={errors.neighborhood}>
            <Input
              id="neighborhood"
              name="neighborhood"
              value={values.neighborhood ?? ""}
              onChange={(e) => onChange("neighborhood", e.target.value)}
              placeholder="e.g. Clintonville"
              maxLength={80}
              error={errors.neighborhood}
            />
          </FormField>
        ) : null}
        <p className="text-xs leading-relaxed text-muted -mt-1">
          City moves the map to the area, street name narrows it down, and the exact address is completely optional. You can always drag the pin for a final adjustment.
        </p>
      </div>
    </fieldset>
  );
}
