import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { featureEnabled, getDataMode } from "@/lib/config";
import { requireViewer } from "@/lib/auth/server";
import { getRepository } from "@/lib/data";
import { uuidSchema } from "@/lib/validation/schemas";
import { BackButton } from "@/components/ui/BackButton";
import { Avatar } from "@/components/ui/Avatar";
import { ChatThread } from "@/components/messages/ChatThread";
import { BlockButton } from "@/components/messages/MessageButtons";

export const metadata: Metadata = { title: "Conversation" };
export const dynamic = "force-dynamic";

/** One conversation. Members only: anyone else gets a 404. */
export default async function ConversationPage({ params }: PageProps<"/messages/[id]">) {
  if (!featureEnabled("messaging")) notFound();
  const { id } = await params;
  const viewer = await requireViewer(`/messages/${id}`);
  if (!uuidSchema.safeParse(id).success) notFound();
  const repo = await getRepository();
  const conversation = await repo.messaging.get(viewer.id, id);
  if (!conversation) notFound();
  const [page, blocked] = await Promise.all([
    repo.messaging.messages(viewer.id, id),
    conversation.other ? repo.messaging.blocked(viewer.id) : Promise.resolve([]),
  ]);
  const other = conversation.other;
  const title = conversation.kind === "group" ? (conversation.eventTitle ?? "Event chat") : (other?.displayName ?? "Deleted account");
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="flex items-center gap-3 mb-4">
        <BackButton fallback="/messages" />
        {other ? <Avatar name={other.displayName} src={other.avatarUrl} size={40} /> : null}
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold truncate">{title}</h1>
          {conversation.kind === "group" && conversation.eventId ? (
            <p className="text-sm text-muted">
              <Link href={`/events/${conversation.eventId}`} className="underline underline-offset-4">Event</Link> · {conversation.members.length} {conversation.members.length === 1 ? "person" : "people"} going
            </p>
          ) : other ? (
            <p className="text-sm text-muted"><Link href={`/u/${other.username}`} className="underline underline-offset-4">@{other.username}</Link></p>
          ) : null}
        </div>
        {other ? <BlockButton userId={other.id} blocked={blocked.some((b) => b.id === other.id)} name={other.displayName} /> : null}
      </div>
      <ChatThread
        conversationId={id}
        kind={conversation.kind}
        viewerId={viewer.id}
        initial={{ members: conversation.members, canSend: conversation.canSend, page }}
        realtime={getDataMode() === "supabase"}
      />
    </div>
  );
}
