import { Skeleton } from "./EmptyState";

/** Generic loading state for list-style pages. */
export function ListPageSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-3 w-24 mb-3" />
      <Skeleton className="h-8 w-40 mb-2" />
      <Skeleton className="h-4 w-64 mb-6" />
      <div className="flex gap-2 mb-5">
        <Skeleton className="h-9 w-24 rounded-full" />
        <Skeleton className="h-9 w-20 rounded-full" />
        <Skeleton className="h-9 w-28 rounded-full" />
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
