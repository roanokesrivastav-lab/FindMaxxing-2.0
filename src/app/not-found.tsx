import { EmptyState } from "@/components/ui/EmptyState";
import { ButtonLink } from "@/components/ui/Button";
import { Compass } from "lucide-react";

export default function NotFound() {
  return (
    <div className="max-w-md mx-auto px-4 pt-16 pb-nav">
      <EmptyState
        icon={Compass}
        title="Off the map"
        body="That page doesn't exist, or the listing was removed."
        action={<ButtonLink href="/" variant="ink">Back to Explore</ButtonLink>}
      />
    </div>
  );
}
