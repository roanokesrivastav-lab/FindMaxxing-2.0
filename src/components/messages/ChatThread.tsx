"use client";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import { Avatar } from "@/components/ui/Avatar";
import { Button } from "@/components/ui/Button";
import { ReportButton } from "@/components/shared/ReportButton";
import { useToast } from "@/components/ui/Toast";
import { getSupabaseBrowserClient } from "@/lib/supabase/client";
import { MAX_MESSAGE_LENGTH } from "@/lib/data/messaging";
import type { ConversationMember, Message, Page } from "@/lib/data/types";
import { markReadAction, sendMessageAction } from "@/server/actions/messages";
import { cn } from "@/lib/utils/cn";

/** Demo mode has no Realtime: poll while the tab is visible. With Realtime, poll rarely as a fallback. */
const POLL_MS = 4000;
const REALTIME_FALLBACK_MS = 30000;
const TIME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

interface Snapshot {
  members: ConversationMember[];
  canSend: boolean;
  page: Page<Message>;
}

const byTime = (a: Message, b: Message) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.id < b.id ? -1 : 1);

/** Merges messages by id, oldest first. */
function merge(current: Message[], incoming: Message[]): Message[] {
  const map = new Map(current.map((m) => [m.id, m]));
  for (const m of incoming) map.set(m.id, m);
  return [...map.values()].sort(byTime);
}

export function ChatThread({
  conversationId,
  kind,
  viewerId,
  initial,
  realtime,
}: {
  conversationId: string;
  kind: "direct" | "group";
  viewerId: string;
  initial: Snapshot;
  /** Supabase mode: subscribe to message inserts (RLS decides who receives them). */
  realtime: boolean;
}) {
  const [messages, setMessages] = useState(() => [...initial.page.items].sort(byTime));
  const [olderCursor, setOlderCursor] = useState(initial.page.nextCursor);
  const [members, setMembers] = useState(initial.members);
  const [canSend, setCanSend] = useState(initial.canSend);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const lastSeen = useRef<string | null>(null);
  const { toast } = useToast();

  /** Fetches the newest page (or an older one) through the members-only route. */
  const fetchPage = useCallback(async (cursor?: string | null): Promise<Snapshot | null> => {
    const res = await fetch(`/api/messages/${conversationId}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { cache: "no-store" });
    return res.ok ? ((await res.json()) as Snapshot) : null;
  }, [conversationId]);

  const refresh = useCallback(async () => {
    const snap = await fetchPage();
    if (!snap) return;
    setMembers(snap.members);
    setCanSend(snap.canSend);
    setMessages((cur) => merge(cur, snap.page.items));
  }, [fetchPage]);

  // Delivery: Realtime when there is a Supabase client, polling otherwise.
  useEffect(() => {
    const supabase = realtime ? getSupabaseBrowserClient() : null;
    const channel = supabase
      ?.channel(`messages:${conversationId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${conversationId}` }, () => void refresh())
      .subscribe();
    const every = channel ? REALTIME_FALLBACK_MS : POLL_MS;
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, every);
    return () => {
      window.clearInterval(timer);
      if (channel && supabase) void supabase.removeChannel(channel);
    };
  }, [conversationId, realtime, refresh]);

  // Read receipts: mark read whenever someone else's newer message is on screen.
  const newest = messages.at(-1);
  useEffect(() => {
    if (!newest || newest.id === lastSeen.current) return;
    lastSeen.current = newest.id;
    bottom.current?.scrollIntoView({ block: "end" });
    void markReadAction(conversationId);
  }, [newest, conversationId]);

  const send = async () => {
    const body = draft.trim();
    if (!body || sending) return;
    setSending(true);
    const res = await sendMessageAction({ conversationId, body });
    setSending(false);
    if (!res.ok) {
      toast(res.error, "error");
      return;
    }
    setDraft("");
    setMessages((cur) => merge(cur, [res.data]));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const loadOlder = async () => {
    if (!olderCursor) return;
    setLoadingOlder(true);
    const snap = await fetchPage(olderCursor);
    setLoadingOlder(false);
    if (!snap) return;
    setMessages((cur) => merge(cur, snap.page.items));
    setOlderCursor(snap.page.nextCursor);
  };

  // "Seen" under my latest message: by the other person, or a count in groups.
  const mine = [...messages].reverse().find((m) => m.senderId === viewerId);
  const seenBy = mine
    ? members.filter((m) => m.profile.id !== viewerId && m.lastReadAt && Date.parse(m.lastReadAt) >= Date.parse(mine.createdAt))
    : [];
  const seenLabel = !seenBy.length ? null : kind === "direct" ? "Seen" : `Seen by ${seenBy.length}`;

  return (
    <div className="flex flex-col gap-3">
      {olderCursor ? (
        <button type="button" onClick={loadOlder} disabled={loadingOlder} className="self-center text-sm font-semibold text-muted hover:text-ink">
          {loadingOlder ? "Loading…" : "Load earlier messages"}
        </button>
      ) : null}
      <ol className="flex flex-col gap-2" aria-label="Messages" aria-live="polite">
        {messages.length === 0 ? <li className="text-sm text-muted text-center py-8">No messages yet. Say hello.</li> : null}
        {messages.map((m) => {
          const own = m.senderId === viewerId;
          return (
            <li key={m.id} className={cn("flex gap-2 items-end", own ? "justify-end" : "justify-start")}>
              {!own ? <Avatar name={m.sender?.displayName ?? "Deleted account"} src={m.sender?.avatarUrl ?? null} size={28} /> : null}
              <div className={cn("max-w-[78%] flex flex-col", own ? "items-end" : "items-start")}>
                {!own && kind === "group" ? <span className="text-xs font-semibold text-muted px-1">{m.sender?.displayName ?? "Deleted account"}</span> : null}
                <p className={cn("rounded-2xl px-3.5 py-2 text-[15px] whitespace-pre-wrap break-words", own ? "bg-ink text-white rounded-br-md" : "bg-surface border border-line rounded-bl-md")}>
                  {m.body}
                </p>
                <span className="text-[11px] text-muted px-1 mt-0.5 inline-flex items-center gap-2">
                  <time dateTime={m.createdAt}>{TIME.format(new Date(m.createdAt))}</time>
                  {!own ? <ReportButton targetType="message" targetId={m.id} signedIn returnTo={`/messages/${conversationId}`} iconOnly /> : null}
                </span>
              </div>
            </li>
          );
        })}
      </ol>
      {seenLabel ? <p className="text-xs text-muted text-right -mt-1" data-testid="seen">{seenLabel}</p> : null}
      <div ref={bottom} />
      {canSend ? (
        <form
          className="sticky bottom-[calc(var(--nav-height)+var(--safe-bottom)+0.5rem)] md:bottom-4 flex items-end gap-2 card p-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="message-body" className="sr-only">Message</label>
          <textarea
            id="message-body"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={MAX_MESSAGE_LENGTH}
            placeholder="Write a message"
            className="flex-1 resize-none bg-transparent px-2 py-2 text-[15px] outline-none max-h-40"
          />
          <Button type="submit" size="icon" variant="ink" loading={sending} disabled={!draft.trim()} aria-label="Send">
            <Send size={18} />
          </Button>
        </form>
      ) : (
        <p className="card p-3 text-sm text-muted text-center">
          {kind === "direct" ? "You can't message each other." : "This event's chat is closed."}
        </p>
      )}
    </div>
  );
}
