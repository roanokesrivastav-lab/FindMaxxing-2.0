import { EmptyState } from "@/components/ui/EmptyState";
import { ButtonLink } from "@/components/ui/Button";

export default function NotFound() {
  return (
    <div className="max-w-md mx-auto px-4 pt-16 pb-nav">
      <EmptyState
        emoji="🧭"
        title="Off the map"
        body="That page doesn't exist, or the listing was removed."
        action={<ButtonLink href="/" variant="ink">Back to Explore</ButtonLink>}
      />
    </div>
  );
}
