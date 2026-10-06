/**
 * Demo-mode messaging. Mirrors 0020_messaging.sql: the group-chat trigger on
 * event_attendees, the anti-spam rule (can_message), the conversations and
 * messages policies, my_conversations() and the messages trigger.
 */
import type { DataRepository } from "../repository";
import { DataError, type ConversationMember, type ConversationSummary, type Message, type ProfileSummary } from "../types";
import { clampLimit, compareTimestamps, decodeCursor, toPage } from "../discovery";
import { MESSAGE_PAGE_SIZE, directKey, messagingError, normalizeMessageBody } from "../messaging";
import type { RateLimitAction } from "@/lib/rateLimits";
import { newId } from "@/lib/utils/ids";
import type { ConversationRow, DemoState, EventRow, MessageRow } from "./store";

const compareIds = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ----------------------------------------------------------------------------
// Group chats follow attendance (the event_attendees trigger)
// ----------------------------------------------------------------------------
export function joinEventChat(state: DemoState, eventId: string, userId: string, now = new Date().toISOString()) {
  let chat = state.conversations.find((c) => c.eventId === eventId);
  if (!chat) {
    chat = { id: newId(), kind: "group", eventId, directKey: null, createdAt: now, lastMessageAt: null };
    state.conversations.push(chat);
  }
  const id = chat.id;
  if (!state.conversationMembers.some((m) => m.conversationId === id && m.userId === userId)) {
    state.conversationMembers.push({ conversationId: id, userId, joinedAt: now, lastReadAt: null });
  }
}

export function leaveEventChat(state: DemoState, eventId: string, userId: string) {
  const chat = state.conversations.find((c) => c.eventId === eventId);
  if (chat) state.conversationMembers = state.conversationMembers.filter((m) => !(m.conversationId === chat.id && m.userId === userId));
}

/** An event's chat goes with the event (on delete cascade). */
export function dropEventChats(state: DemoState, eventIds: Set<string>) {
  const gone = new Set(state.conversations.filter((c) => c.eventId && eventIds.has(c.eventId)).map((c) => c.id));
  if (!gone.size) return;
  state.conversations = state.conversations.filter((c) => !gone.has(c.id));
  state.conversationMembers = state.conversationMembers.filter((m) => !gone.has(m.conversationId));
  state.messages = state.messages.filter((m) => !gone.has(m.conversationId));
}

/** Everyone going to an event is in its chat (the migration's backfill, and the seed). */
export function syncAllEventChats(state: DemoState, now = new Date().toISOString()) {
  for (const a of state.eventAttendees) joinEventChat(state, a.eventId, a.userId, now);
}

/** Deleting an account: their memberships, messages and blocks go; their directs stay for the other person. */
export function deleteMessagingFor(state: DemoState, userId: string) {
  state.conversationMembers = state.conversationMembers.filter((m) => m.userId !== userId);
  state.messages = state.messages.filter((m) => m.senderId !== userId);
  state.blocks = state.blocks.filter((b) => b.blockerId !== userId && b.blockedId !== userId);
}

// ----------------------------------------------------------------------------
// Rules
// ----------------------------------------------------------------------------
export const hasBlocked = (state: DemoState, a: string, b: string) => state.blocks.some((x) => x.blockerId === a && x.blockedId === b);
export const blockedBetween = (state: DemoState, a: string, b: string) => hasBlocked(state, a, b) || hasBlocked(state, b, a);

/** Mirrors can_message(). */
export function canMessageIn(state: DemoState, userId: string, otherId: string): boolean {
  if (!userId || userId === otherId || blockedBetween(state, userId, otherId)) return false;
  const follows = (a: string, b: string) => state.follows.some((f) => f.followerId === a && f.followingId === b);
  if (follows(userId, otherId) && follows(otherId, userId)) return true;
  const mine = new Set(state.eventAttendees.filter((a) => a.userId === userId).map((a) => a.eventId));
  return state.eventAttendees.some((a) =>
    a.userId === otherId && mine.has(a.eventId) && state.events.some((e) => e.id === a.eventId && e.status === "published"));
}

/** The other member of a direct, from its pair key (as my_conversations does). */
function otherOf(chat: ConversationRow, userId: string): string | null {
  if (chat.kind !== "direct" || !chat.directKey) return null;
  const [a, b] = chat.directKey.split(":");
  return a === userId ? b : a;
}

/** The messages policy: members only, never removed ones or those from people the viewer blocked. */
const visibleTo = (state: DemoState, m: MessageRow, viewerId: string) => !m.removedAt && !hasBlocked(state, viewerId, m.senderId);
const newestFirst = (a: MessageRow, b: MessageRow) => compareTimestamps(b.createdAt, a.createdAt) || compareIds(b.id, a.id);

export interface MessagingHelpers {
  persist(): void;
  assertActive(userId: string): void;
  rateLimit(userId: string, action: RateLimitAction): () => void;
  canViewEvent(event: EventRow, viewerId: string): boolean;
  summary(userId: string): ProfileSummary | null;
}

export function createDemoMessaging(state: DemoState, h: MessagingHelpers): DataRepository["messaging"] {
  const membership = (conversationId: string, userId: string) =>
    state.conversationMembers.find((m) => m.conversationId === conversationId && m.userId === userId);

  const toSummary = (chat: ConversationRow, userId: string): ConversationSummary => {
    const me = membership(chat.id, userId);
    const visible = state.messages.filter((m) => m.conversationId === chat.id && visibleTo(state, m, userId));
    const last = [...visible].sort(newestFirst)[0];
    const event = chat.eventId ? state.events.find((e) => e.id === chat.eventId) : undefined;
    const otherId = otherOf(chat, userId);
    return {
      id: chat.id,
      kind: chat.kind,
      eventId: chat.eventId,
      eventTitle: event && h.canViewEvent(event, userId) ? event.title : null,
      other: otherId ? h.summary(otherId) : null,
      lastMessageAt: chat.lastMessageAt,
      lastBody: last?.body ?? null,
      lastSenderId: last?.senderId ?? null,
      unread: visible.filter((m) => m.senderId !== userId && (!me?.lastReadAt || compareTimestamps(m.createdAt, me.lastReadAt) > 0)).length,
    };
  };

  const canSendIn = (chat: ConversationRow, userId: string) => {
    if (chat.kind === "direct") {
      return !state.conversationMembers.some((m) => m.conversationId === chat.id && m.userId !== userId && blockedBetween(state, m.userId, userId));
    }
    return state.events.some((e) => e.id === chat.eventId && e.status === "published");
  };

  const toMessage = (m: MessageRow): Message => ({
    id: m.id, conversationId: m.conversationId, senderId: m.senderId, sender: h.summary(m.senderId), body: m.body, createdAt: m.createdAt,
  });

  const conversations = async (userId: string) => {
    const mine = new Set(state.conversationMembers.filter((m) => m.userId === userId).map((m) => m.conversationId));
    return state.conversations
      .filter((c) => mine.has(c.id))
      .sort((a, b) => compareTimestamps(b.lastMessageAt ?? b.createdAt, a.lastMessageAt ?? a.createdAt) || compareIds(a.id, b.id))
      .map((c) => toSummary(c, userId));
  };

  return {
    conversations,
    async unreadTotal(userId) {
      return (await conversations(userId)).reduce((n, c) => n + c.unread, 0);
    },
    async canMessage(userId, otherId) {
      return canMessageIn(state, userId, otherId);
    },
    async startDirect(userId, otherId) {
      h.assertActive(userId);
      if (!state.profiles.some((p) => p.id === otherId)) throw messagingError("not_found");
      if (!canMessageIn(state, userId, otherId)) throw messagingError("not_allowed");
      const key = directKey(userId, otherId);
      const existing = state.conversations.find((c) => c.directKey === key);
      if (existing) return existing.id;
      const now = new Date().toISOString();
      const chat: ConversationRow = { id: newId(), kind: "direct", eventId: null, directKey: key, createdAt: now, lastMessageAt: null };
      state.conversations.push(chat);
      state.conversationMembers.push(
        { conversationId: chat.id, userId, joinedAt: now, lastReadAt: null },
        { conversationId: chat.id, userId: otherId, joinedAt: now, lastReadAt: null },
      );
      h.persist();
      return chat.id;
    },
    async eventConversation(userId, eventId) {
      const chat = state.conversations.find((c) => c.eventId === eventId);
      return chat && membership(chat.id, userId) ? chat.id : null;
    },
    async get(userId, conversationId) {
      const chat = state.conversations.find((c) => c.id === conversationId);
      if (!chat || !membership(chat.id, userId)) return null;
      const members: ConversationMember[] = state.conversationMembers
        .filter((m) => m.conversationId === chat.id && !hasBlocked(state, m.userId, userId))
        .map((m) => ({ profile: h.summary(m.userId), lastReadAt: m.lastReadAt }))
        .filter((m): m is ConversationMember => !!m.profile)
        .sort((a, b) => compareIds(a.profile.username, b.profile.username));
      return { ...toSummary(chat, userId), members, canSend: canSendIn(chat, userId) };
    },
    async messages(userId, conversationId, opts = {}) {
      if (!membership(conversationId, userId)) return { items: [], nextCursor: null };
      const limit = clampLimit(opts.limit, MESSAGE_PAGE_SIZE, 100);
      const before = decodeCursor(opts.cursor);
      const rows = state.messages
        .filter((m) => m.conversationId === conversationId && visibleTo(state, m, userId))
        .filter((m) => !before || compareTimestamps(m.createdAt, before.key) < 0 || (compareTimestamps(m.createdAt, before.key) === 0 && m.id < before.id))
        .sort(newestFirst)
        .slice(0, limit + 1);
      return toPage(rows, limit, toMessage, (m) => ({ key: m.createdAt, id: m.id }));
    },
    async send(userId, conversationId, body) {
      h.assertActive(userId);
      const text = normalizeMessageBody(body);
      const chat = state.conversations.find((c) => c.id === conversationId);
      if (!chat || !membership(chat.id, userId)) throw messagingError("not_found");
      if (!canSendIn(chat, userId)) throw messagingError(chat.kind === "direct" ? "blocked" : "closed");
      const counted = h.rateLimit(userId, "messages");
      const row: MessageRow = { id: newId(), conversationId, senderId: userId, body: text, createdAt: new Date().toISOString(), removedAt: null };
      state.messages.push(row);
      chat.lastMessageAt = row.createdAt;
      counted();
      h.persist();
      return toMessage(row);
    },
    async markRead(userId, conversationId) {
      const me = membership(conversationId, userId);
      if (!me) return;
      me.lastReadAt = new Date().toISOString();
      h.persist();
    },
    async block(userId, otherId) {
      h.assertActive(userId);
      if (userId === otherId) throw messagingError("self");
      if (!state.profiles.some((p) => p.id === otherId)) throw new DataError("Profile not found", "not_found");
      if (hasBlocked(state, userId, otherId)) return;
      state.blocks.push({ blockerId: userId, blockedId: otherId, createdAt: new Date().toISOString() });
      h.persist();
    },
    async unblock(userId, otherId) {
      h.assertActive(userId);
      const before = state.blocks.length;
      state.blocks = state.blocks.filter((b) => !(b.blockerId === userId && b.blockedId === otherId));
      if (state.blocks.length !== before) h.persist();
    },
    async blocked(userId) {
      return state.blocks
        .filter((b) => b.blockerId === userId)
        .sort((a, b) => compareTimestamps(b.createdAt, a.createdAt) || compareIds(a.blockedId, b.blockedId))
        .map((b) => h.summary(b.blockedId))
        .filter((p): p is ProfileSummary => !!p);
    },
  };
}
