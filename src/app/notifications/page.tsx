import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Bell, Settings } from "lucide-react";
import { featureEnabled } from "@/lib/config";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { notificationHref, notificationText } from "@/lib/notifications";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Avatar } from "@/components/ui/Avatar";
import { MarkReadOnView } from "@/components/notifications/MarkReadOnView";
import { cn } from "@/lib/utils/cn";

export const metadata: Metadata = { title: "Notifications" };
export const dynamic = "force-dynamic";

const WHEN = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/** Hidden unless the notifications flag is on. */
export default async function NotificationsPage() {
  if (!featureEnabled("notifications")) notFound();
  const viewer = await requireViewer("/notifications");
  const page = await (await getRepository()).notifications.list(viewer.id, { limit: 50 });
  const unread = page.items.filter((n) => !n.readAt).map((n) => n.id);
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader
        eyebrow="You"
        title="Notifications"
        action={<Link href="/profile/settings#notifications" className="chip"><Settings size={14} /> Settings</Link>}
      />
      {page.items.length === 0 ? (
        <EmptyState emoji="🔔" title="Nothing yet" body="You'll hear here when people follow you, join your events, or message you." />
      ) : (
        <ul className="card divide-y divide-line overflow-hidden" aria-label="Notifications">
          {page.items.map((n) => {
            const text = notificationText({ ...n, actorName: n.actor?.displayName ?? null });
            const isUnread = !n.readAt;
            return (
              <li key={n.id}>
                <Link href={notificationHref({ ...n, actorUsername: n.actor?.username ?? null })} className={cn("flex items-center gap-3 px-4 py-3 hover:bg-surface-2", isUnread && "bg-flare-50")}>
                  {n.actor ? (
                    <Avatar name={n.actor.displayName} src={n.actor.avatarUrl} size={36} />
                  ) : (
                    <span className="h-9 w-9 rounded-full bg-paper-2 text-ink-2 inline-flex items-center justify-center shrink-0" aria-hidden>
                      <Bell size={16} />
                    </span>
                  )}
                  <span className="flex-1 min-w-0">
                    <span className={cn("block text-[15px]", isUnread ? "font-semibold" : "text-ink-2")}>{text}</span>
                    <time className="block text-xs text-muted mt-0.5" dateTime={n.updatedAt}>{WHEN.format(new Date(n.updatedAt))}</time>
                  </span>
                  {isUnread ? <span className="h-2.5 w-2.5 rounded-full bg-flare-ink shrink-0" aria-label="Unread" role="img" /> : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      <MarkReadOnView ids={unread} />
    </div>
  );
}
