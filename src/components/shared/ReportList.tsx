import Link from "next/link";
import type { ReportEntry } from "@/lib/data/types";
import { REPORT_REASONS } from "@/lib/data/taxonomy";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

const STATUS_STYLE: Record<ReportEntry["status"], { label: string; className: string }> = {
  open: { label: "Open", className: "bg-sun-100 text-[#8a6000]" },
  reviewed: { label: "Reviewed", className: "bg-moss-100 text-moss" },
  dismissed: { label: "Dismissed", className: "bg-surface-2 text-muted" },
};

function reasonLabel(reason: string): string {
  return REPORT_REASONS.find((r) => r.value === reason)?.label ?? reason;
}

function hrefFor(entry: ReportEntry): string | null {
  if (entry.targetType === "place") return `/places/${entry.targetId}`;
  if (entry.targetType === "event") return `/events/${entry.targetId}`;
  return null;
}

/**
 * Renders reports for either side of the exchange. Neither perspective is ever
 * given the reporter's identity: the database views omit that column outright.
 */
export function ReportList({ entries, perspective }: { entries: ReportEntry[]; perspective: "owner" | "reporter" }) {
  return (
    <ul className="flex flex-col gap-2 list-none p-0 m-0">
      {entries.map((entry) => {
        const status = STATUS_STYLE[entry.status];
        const href = hrefFor(entry);
        const label = entry.targetLabel ?? "A listing that no longer exists";
        return (
          <li key={entry.id} className="card p-4">
            <div className="flex items-start gap-3">
              <div className="flex-1 min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                  {entry.targetType === "place" ? "Place" : entry.targetType === "event" ? "Event" : "Profile"}
                </p>
                {href && entry.targetLabel ? (
                  <Link href={href} className="font-bold hover:text-flare-600 break-words">
                    {label}
                  </Link>
                ) : (
                  <p className="font-bold text-muted break-words">{label}</p>
                )}
              </div>
              <span className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-bold ${status.className}`}>{status.label}</span>
            </div>

            <p className="mt-2 text-sm font-semibold">{reasonLabel(entry.reason)}</p>
            {entry.details ? <p className="mt-1 text-sm text-ink-2">{entry.details}</p> : null}

            <p className="mt-2 text-xs text-muted">
              {perspective === "owner" ? "Reported" : "You reported this"} on {DATE.format(new Date(entry.createdAt))}
            </p>
          </li>
        );
      })}
    </ul>
  );
}
