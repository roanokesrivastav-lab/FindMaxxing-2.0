import { SectionHeader } from "@/components/ui/SectionHeader";
import type { SaveDetails } from "@/lib/places/saves";
import { OnlyYou, SaveDetailsForm } from "./SaveDetailsForm";

/**
 * "Why you saved it" on the place page (3.1): kept apart from what the place is.
 * Rendered only for the owner of the save, on the server, so nothing here reaches
 * anyone else's page, share preview or recommendation.
 */
export function MySaveSection({ details, suggestions }: { details: SaveDetails; suggestions: string[] }) {
  return (
    <section aria-labelledby="my-save" data-block="my-save">
      <SectionHeader title="Why you saved it" id="my-save" action={<OnlyYou />} />
      <SaveDetailsForm details={details} suggestions={suggestions} />
    </section>
  );
}
