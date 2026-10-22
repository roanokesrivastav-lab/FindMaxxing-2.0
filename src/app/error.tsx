"use client";
import { useEffect } from "react";
import { EmptyState } from "@/components/ui/EmptyState";
import { reportClientError } from "@/lib/observability/client";
import { Button, ButtonLink } from "@/components/ui/Button";
import { TriangleAlert } from "lucide-react";

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => reportClientError(error), [error]);
  return (
    <div className="max-w-md mx-auto px-4 pt-16 pb-nav">
      <EmptyState
        icon={TriangleAlert}
        title="Something broke"
        body={process.env.NODE_ENV === "development" ? error.message : "We hit an error loading this. Try again in a moment."}
        action={
          <div className="flex gap-2">
            <Button onClick={reset} variant="ink">
              Try again
            </Button>
            <ButtonLink href="/" variant="secondary">
              Explore
            </ButtonLink>
          </div>
        }
      />
    </div>
  );
}
