import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CalendarDays } from "lucide-react";
import { featureEnabled } from "@/lib/config";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { DIRECT_MESSAGE_RULE } from "@/lib/data/messaging";
import { PageHeader } from "@/components/ui/PageHeader";
import { EmptyState } from "@/components/ui/EmptyState";
import { Avatar } from "@/components/ui/Avatar";
import { BlockButton } from "@/components/messages/MessageButtons";
import { LocalDate } from "@/components/time/LocalDate";

export const metadata: Metadata = { title: "Messages" };
export const dynamic = "force-dynamic";

const WHEN: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

/** Hidden unless the messaging flag is on. */
export default async function MessagesPage() {
  if (!featureEnabled("messaging")) notFound();
  const viewer = await requireViewer("/messages");
  const repo = await getRepository();
  const [conversations, blocked] = await Promise.all([repo.messaging.conversations(viewer.id), repo.messaging.blocked(viewer.id)]);
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Messages" title="Messages" subtitle="Chats for the events you're going to, and messages with people you know." />
      {conversations.length === 0 ? (
        <EmptyState emoji="💬" title="No conversations yet" body={`Join an event to get its group chat. ${DIRECT_MESSAGE_RULE}`} />
      ) : (
        <ul className="card divide-y divide-line overflow-hidden" aria-label="Conversations">
          {conversations.map((c) => {
            const title = c.kind === "group" ? (c.eventTitle ?? "Event chat") : (c.other?.displayName ?? "Deleted account");
            const preview = c.lastBody ? `${c.lastSenderId === viewer.id ? "You: " : ""}${c.lastBody}` : "No messages yet";
            return (
              <li key={c.id}>
                <Link href={`/messages/${c.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-surface-2">
                  {c.kind === "group" ? (
                    <span className="h-10 w-10 rounded-full bg-pulse-50 text-pulse inline-flex items-center justify-center shrink-0" aria-hidden>
                      <CalendarDays size={18} />
                    </span>
                  ) : (
                    <Avatar name={title} src={c.other?.avatarUrl ?? null} size={40} />
                  )}
                  <span className="flex-1 min-w-0">
                    <span className="flex items-baseline gap-2">
                      <span className={c.unread ? "font-bold truncate" : "font-semibold truncate"}>{title}</span>
                      {c.lastMessageAt ? <time className="ml-auto text-xs text-muted shrink-0" dateTime={c.lastMessageAt}><LocalDate value={c.lastMessageAt} format={WHEN} /></time> : null}
                    </span>
                    <span className={c.unread ? "block text-sm text-ink truncate" : "block text-sm text-muted truncate"}>{preview}</span>
                  </span>
                  {c.unread ? (
                    <span className="min-w-6 h-6 px-1.5 rounded-full bg-flare-ink text-white text-xs font-bold inline-flex items-center justify-center">
                      {c.unread}<span className="sr-only"> unread</span>
                    </span>
                  ) : null}
                </Link>
              </li>
            );
          })}
        </ul>
      )}
      {blocked.length ? (
        <section className="mt-8" aria-labelledby="blocked-heading">
          <h2 id="blocked-heading" className="text-sm font-bold uppercase tracking-[0.12em] text-muted mb-2">Blocked</h2>
          <ul className="card divide-y divide-line">
            {blocked.map((p) => (
              <li key={p.id} className="flex items-center gap-3 px-4 py-3">
                <Avatar name={p.displayName} src={p.avatarUrl} size={32} />
                <Link href={`/u/${p.username}`} className="flex-1 min-w-0 font-semibold truncate">{p.displayName}</Link>
                <BlockButton userId={p.id} blocked name={p.displayName} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
