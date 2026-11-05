import type { ReactNode } from "react";

/**
 * A claim that opens its evidence (Yelp decision, roadmap 2.5): the line asserting
 * something is a native disclosure, so it works by keyboard and screen reader with no
 * script, and what it is based on is one tap away.
 */
export function Evidence({ claim, children }: { claim: ReactNode; children: ReactNode }) {
  return (
    <details className="group" data-evidence="">
      <summary className="cursor-pointer list-none inline-flex flex-wrap items-center gap-item rounded-lg">
        {claim}
        <span className="type-body text-ink-2 underline underline-offset-4 group-open:no-underline">What it&rsquo;s based on</span>
      </summary>
      <div className="type-body text-ink-2 mt-hair">{children}</div>
    </details>
  );
}
