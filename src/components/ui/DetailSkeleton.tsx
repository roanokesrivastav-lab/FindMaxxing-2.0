import { Skeleton } from "./EmptyState";

/** Placeholder for a place or event detail page: hero, title card, body. */
export function DetailPageSkeleton() {
  return (
    <div className="pb-nav md:pb-10" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-[260px] md:h-[360px] md:mx-6 md:mt-6 rounded-none md:rounded-3xl" />
      <div className="max-w-2xl mx-auto px-4 md:px-6 -mt-6 relative">
        <div className="card p-5 flex flex-col gap-3">
          <Skeleton className="h-5 w-28 rounded-full" />
          <Skeleton className="h-8 w-3/4" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-24 rounded-2xl mt-4" />
        <div className="mt-6 flex flex-col gap-2">
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
        <Skeleton className="h-44 rounded-2xl mt-6" />
      </div>
    </div>
  );
}

/** Placeholder for the create/edit form routes. */
export function FormPageSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <div className="max-w-xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-8" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-3 w-20 mb-2" />
      <Skeleton className="h-8 w-56 mb-2" />
      <Skeleton className="h-4 w-72 mb-8" />
      <div className="flex flex-col gap-6">
        {Array.from({ length: fields }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-12 rounded-xl" />
          </div>
        ))}
        <Skeleton className="h-64 rounded-2xl" />
      </div>
    </div>
  );
}

/** Placeholder for a profile page: identity card then activity. */
export function ProfilePageSkeleton() {
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav" aria-busy="true" aria-label="Loading">
      <div className="card p-5">
        <div className="flex items-start gap-4">
          <Skeleton className="h-[72px] w-[72px] rounded-full" />
          <div className="flex-1 flex flex-col gap-2">
            <Skeleton className="h-7 w-48" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
        <div className="mt-5 grid grid-cols-4 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-14 rounded-xl" />
          ))}
        </div>
      </div>
      <Skeleton className="h-11 rounded-full mt-5" />
      <div className="mt-4 flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-[104px] rounded-2xl" />
        ))}
      </div>
    </div>
  );
}
