/**
 * Messaging (Session 15): direct messages and event group chats. Members-only
 * reads and writes enforced by RLS, the anti-spam rule for starting a direct
 * conversation, blocking, group chats that follow attendance, reports and
 * moderation of messages, the rate limit and suspension, account deletion, and
 * the same behaviour in the demo store, the actions and the polling route.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import { createSeededDb, queryAs } from "./helpers/pglite";
import { createIsolatedStore, migrateDemoState, buildSeedState, type DemoState } from "../src/lib/data/demo/store";
import { createDemoRepository } from "../src/lib/data/demo/repository";
import { deleteDemoAccount } from "../src/lib/data/demo/account";
import type { DataRepository } from "../src/lib/data/repository";
import { SEED_USERS, stableId } from "../src/lib/seed/seed-data";
import { DIRECT_MESSAGE_RULE } from "../src/lib/data/messaging";
import { parseRateLimitMessage } from "../src/lib/rateLimits";

const user = (u: string) => SEED_USERS.find((x) => x.username === u)!.id;
const [maya, theo, jules, nina, sam, dev, lena] = ["maya_r", "theo", "jules", "nina", "sam_k", "dev", "lena"].map(user);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An upcoming, published event maya is going to and nina is not, with room. */
function eventForNina(state: DemoState): string {
  const ev = state.events.find((e) => {
    const going = state.eventAttendees.filter((a) => a.eventId === e.id);
    return e.status === "published" && Date.parse(e.endsAt ?? e.startsAt) > Date.now() + 3600_000
      && going.some((a) => a.userId === maya) && !going.some((a) => a.userId === nina)
      && (e.capacity === null || going.length < e.capacity);
  });
  if (!ev) throw new Error("no event for nina");
  return ev.id;
}

describe("messaging in the database", () => {
  let db: PGlite;
  const as = <T = Record<string, unknown>>(id: string | null, sql: string, p: unknown[] = []) => queryAs<T>(db, id, sql, p);
  const start = async (me: string, other: string) => (await as<{ id: string }>(me, "select public.start_direct($1) as id", [other]))[0].id;
  const send = async (me: string, conv: string, body: string) =>
    (await sleep(2), as<{ id: string }>(me, "insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), $2) returning id", [conv, body]));
  // No RETURNING: that would also apply the select policy and hide a missing insert check.
  const sendQuietly = (me: string, conv: string, body: string) =>
    as(me, "insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), $2)", [conv, body]);
  const bodies = async (me: string, conv: string) => (await as<{ body: string }>(me, "select body from public.conversation_messages($1)", [conv])).map((r) => r.body);
  beforeAll(async () => {
    db = await createSeededDb();
  });

  it("gives everyone going to an event its group chat, and follows attendance", async () => {
    const missing = await db.query(`select a.event_id, a.user_id from public.event_attendees a
      where not exists (select 1 from public.conversations c join public.conversation_members m on m.conversation_id = c.id
                        where c.event_id = a.event_id and m.user_id = a.user_id)`);
    expect(missing.rows).toEqual([]);
    const eventId = eventForNina(createIsolatedStore().state);
    const chat = (await db.query<{ id: string }>("select id from public.conversations where event_id = $1", [eventId])).rows[0].id;
    expect(await as(nina, "select id from public.conversations where id = $1", [chat])).toEqual([]);
    await as(nina, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [eventId]);
    expect(await as(nina, "select id from public.conversations where id = $1", [chat])).toHaveLength(1);
    await send(nina, chat, "Hi all");
    await as(nina, "delete from public.event_attendees where event_id = $1 and user_id = auth.uid()", [eventId]);
    expect(await as(nina, "select id from public.conversations where id = $1", [chat])).toEqual([]);
    await expect(sendQuietly(nina, chat, "Still here?")).rejects.toThrow(/row-level security/);
  });

  it("lets anonymous visitors read nothing", async () => {
    for (const table of ["conversations", "conversation_members", "messages", "blocks"]) {
      const rows = await as(null, `select * from public.${table}`).catch(() => []);
      expect([table, rows]).toEqual([table, []]);
    }
    await expect(as(null, "select public.start_direct($1)", [maya])).rejects.toThrow(/permission denied/);
    await expect(as(null, "select * from public.my_conversations()")).rejects.toThrow(/permission denied/);
  });

  it("starts a direct conversation only with a mutual follow or a fellow attendee", async () => {
    // nina follows maya, maya does not follow back, and they share no event.
    expect((await as<{ ok: boolean }>(nina, "select public.can_message($1) as ok", [maya]))[0].ok).toBe(false);
    await expect(start(nina, maya)).rejects.toThrow(/messaging:not_allowed/);
    await expect(start(maya, maya)).rejects.toThrow(/messaging:not_allowed/);
    const conv = await start(maya, theo); // mutual follow
    expect(await start(theo, maya)).toBe(conv); // one conversation per pair
    // Sharing an event is enough.
    const eventId = eventForNina(createIsolatedStore().state);
    await as(nina, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [eventId]);
    const withNina = await start(nina, maya);
    await send(nina, withNina, "See you there");
    await as(nina, "delete from public.event_attendees where event_id = $1 and user_id = auth.uid()", [eventId]);
    // The existing conversation stays; a new one could not be started now.
    expect(await bodies(maya, withNina)).toEqual(["See you there"]);
  });

  it("keeps conversations to their members, who write only as themselves", async () => {
    const conv = await start(maya, jules);
    await send(maya, conv, "Trail at 7?");
    expect(await bodies(jules, conv)).toEqual(["Trail at 7?"]);
    expect(await bodies(dev, conv)).toEqual([]);
    expect(await as(dev, "select * from public.messages where conversation_id = $1", [conv])).toEqual([]);
    expect(await as(dev, "select * from public.conversation_members where conversation_id = $1", [conv])).toEqual([]);
    await expect(sendQuietly(dev, conv, "Hi")).rejects.toThrow(/row-level security/);
    await expect(as(jules, "insert into public.messages (conversation_id, sender_id, body) values ($1, $2, 'as maya')", [conv, maya])).rejects.toThrow(/row-level security/);
    // Nobody adds members, edits or deletes messages, or creates conversations directly.
    await expect(as(dev, "insert into public.conversation_members (conversation_id, user_id) values ($1, auth.uid())", [conv])).rejects.toThrow(/permission denied/);
    await expect(as(maya, "update public.messages set body = 'edited' where conversation_id = $1", [conv])).rejects.toThrow(/permission denied/);
    await expect(as(maya, "delete from public.messages where conversation_id = $1", [conv])).rejects.toThrow(/permission denied/);
    await expect(as(maya, "insert into public.conversations (kind, direct_key) values ('direct', 'x')")).rejects.toThrow(/permission denied/);
    await expect(as(maya, "update public.conversation_members set user_id = $2 where conversation_id = $1", [conv, dev])).rejects.toThrow(/permission denied/);
    // Read markers: your own only.
    await as(jules, "update public.conversation_members set last_read_at = now() where conversation_id = $1", [conv]);
    const marks = await db.query<{ user_id: string; last_read_at: string | null }>("select user_id, last_read_at from public.conversation_members where conversation_id = $1", [conv]);
    expect(marks.rows.find((r) => r.user_id === maya)!.last_read_at).toBeNull();
    expect(marks.rows.find((r) => r.user_id === jules)!.last_read_at).not.toBeNull();
    // Body limits.
    await expect(send(maya, conv, "   ")).rejects.toThrow(/check constraint/);
    await expect(send(maya, conv, "x".repeat(2001))).rejects.toThrow(/check constraint/);
  });

  it("counts unread messages from others until the conversation is read", async () => {
    const conv = await start(lena, dev);
    await send(lena, conv, "one");
    await send(lena, conv, "two");
    const devView = async () => (await as<{ id: string; unread: number; last_body: string; other_username: string }>(dev, "select * from public.my_conversations()")).find((c) => c.id === conv)!;
    expect(await devView()).toMatchObject({ unread: 2, last_body: "two", other_username: "lena" });
    expect((await as<{ id: string; unread: number }>(lena, "select * from public.my_conversations()")).find((c) => c.id === conv)!.unread).toBe(0);
    await as(dev, "select public.mark_read($1)", [conv]);
    expect((await devView()).unread).toBe(0);
  });

  it("blocks: no new or continued directs either way, hidden messages and membership, private block list", async () => {
    const conv = await start(maya, priyaId());
    await send(priyaId(), conv, "before");
    await as(maya, "insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), $1)", [priyaId()]);
    expect(await bodies(maya, conv)).toEqual([]); // the blocker no longer sees their messages
    await expect(send(priyaId(), conv, "after")).rejects.toThrow(/messaging:blocked/);
    await expect(send(maya, conv, "after")).rejects.toThrow(/messaging:blocked/);
    await expect(start(priyaId(), maya)).rejects.toThrow(/messaging:not_allowed/);
    // The blocked person can't see the block, or the blocker in member lists.
    expect(await as(priyaId(), "select * from public.blocks")).toEqual([]);
    const members = await as<{ user_id: string }>(priyaId(), "select user_id from public.conversation_members where conversation_id = $1", [conv]);
    expect(members.map((m) => m.user_id)).toEqual([priyaId()]);
    // The conversation keeps its label for them.
    expect((await as<{ id: string; other_username: string }>(priyaId(), "select * from public.my_conversations()")).find((c) => c.id === conv)!.other_username).toBe("maya_r");
    // Only the blocker can lift it, and you cannot block yourself.
    await as(priyaId(), "delete from public.blocks where blocker_id = $1", [maya]);
    expect((await db.query("select 1 from public.blocks where blocker_id = $1", [maya])).rows).toHaveLength(1);
    await expect(as(maya, "insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), auth.uid())")).rejects.toThrow(/check constraint/);
    await expect(as(maya, "insert into public.blocks (blocker_id, blocked_id) values ($1, $2)", [priyaId(), dev])).rejects.toThrow(/row-level security/);
    await as(maya, "delete from public.blocks where blocked_id = $1", [priyaId()]);
    expect(await bodies(maya, conv)).toEqual(["before"]);
  });

  it("hides a blocked person's group messages from the blocker only", async () => {
    const chat = (await db.query<{ id: string }>(`select c.id from public.conversations c
      join public.conversation_members a on a.conversation_id = c.id and a.user_id = $1
      join public.conversation_members b on b.conversation_id = c.id and b.user_id = $2
      join public.events e on e.id = c.event_id where e.status = 'published' limit 1`, [maya, theo])).rows[0].id;
    await send(theo, chat, "group hello");
    await as(maya, "insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), $1)", [theo]);
    expect(await bodies(maya, chat)).not.toContain("group hello");
    const others = (await db.query<{ user_id: string }>("select user_id from public.conversation_members where conversation_id = $1 and user_id not in ($2, $3)", [chat, maya, theo])).rows;
    if (others.length) expect(await bodies(others[0].user_id, chat)).toContain("group hello");
    await send(theo, chat, "still posting in the group"); // groups stay open to both
    await as(maya, "delete from public.blocks where blocked_id = $1", [theo]);
  });

  it("closes an event's chat when the event is no longer on", async () => {
    const ev = (await db.query<{ id: string; creator_id: string; chat: string }>(`select e.id, e.creator_id, c.id as chat from public.events e
      join public.conversations c on c.event_id = e.id where e.status = 'published' and e.starts_at > now() + interval '1 day' limit 1`)).rows[0];
    await as(ev.creator_id, "update public.events set status = 'cancelled' where id = $1", [ev.id]);
    await expect(send(ev.creator_id, ev.chat, "Is it still on?")).rejects.toThrow(/messaging:closed/);
  });

  it("limits messages to 60 an hour and refuses suspended accounts", async () => {
    const conv = await start(dev, lena);
    for (let i = 0; i < 60; i++) await send(dev, conv, `m${i}`);
    const err = await send(dev, conv, "one too many").catch((e: Error) => e);
    expect(parseRateLimitMessage(String((err as Error).message))).toMatchObject({ code: "rate_limited", message: expect.stringMatching(/^Too many messages/) });
    // Action names with an underscore parse too (they did not before this session).
    expect(parseRateLimitMessage("rate_limited:trip_plans:3600")).toMatchObject({ message: expect.stringMatching(/^Too many trip plans/) });
    await db.query("insert into public.suspensions (user_id, reason) values ($1, 'test')", [lena]);
    await expect(send(lena, conv, "suspended")).rejects.toThrow(/account_suspended/);
    await expect(start(lena, dev)).rejects.toThrow(/account_suspended/);
    await db.query("delete from public.suspensions where user_id = $1", [lena]);
  });

  it("lets members report a message, and moderators remove and restore it", async () => {
    const conv = await start(jules, maya);
    const [{ id: msg }] = await send(jules, conv, "buy followers at spam.example");
    await expect(as(dev, "insert into public.reports (reporter_id, target_type, target_id, reason) values (auth.uid(), 'message', $1, 'spam')", [msg])).rejects.toThrow(/does not exist/);
    await as(maya, "insert into public.reports (reporter_id, target_type, target_id, reason) values (auth.uid(), 'message', $1, 'spam')", [msg]);
    const queue = await as<{ target_type: string; target_id: string; target_label: string; target_status: string }>(sam, "select * from public.moderation_queue()");
    expect(queue.find((q) => q.target_id === msg)).toMatchObject({ target_type: "message", target_label: "buy followers at spam.example", target_status: "published" });
    expect(await as(maya, "select * from public.moderation_queue()")).toEqual([]);
    await expect(as(maya, "select * from public.moderate_target('message', $1, 'remove', 'spam')", [msg])).rejects.toThrow(/Moderators only/);
    await as(sam, "select * from public.moderate_target('message', $1, 'remove', 'spam')", [msg]);
    expect(await bodies(maya, conv)).not.toContain("buy followers at spam.example");
    expect(await bodies(jules, conv)).not.toContain("buy followers at spam.example");
    const snap = (await as<{ t: { status: string; ownerUsername: string } }>(sam, "select public.moderation_target('message', $1) as t", [msg]))[0].t;
    expect(snap).toMatchObject({ status: "removed", ownerUsername: "jules" });
    await as(sam, "select * from public.moderate_target('message', $1, 'restore')", [msg]);
    expect(await bodies(maya, conv)).toContain("buy followers at spam.example");
  });

  it("never indexes message text", async () => {
    const idx = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where tablename = 'messages'");
    expect(idx.rows.map((r) => r.indexdef).join("\n")).not.toMatch(/body/);
  });

  function priyaId() {
    return user("priya");
  }
});

// ----------------------------------------------------------------------------
// The same script against both stores
// ----------------------------------------------------------------------------
type Ops = {
  start(me: string, other: string): Promise<string>;
  send(me: string, conv: string, body: string): Promise<void>;
  read(me: string, conv: string): Promise<void>;
  block(me: string, other: string): Promise<void>;
  join(me: string, eventId: string): Promise<void>;
  view(me: string): Promise<unknown[]>;
  canMessage(me: string, other: string): Promise<boolean>;
};

async function script(ops: Ops, eventId: string) {
  const a = await ops.start(maya, theo);
  await ops.send(maya, a, "coffee?");
  await ops.send(theo, a, "yes, Meeple at 10");
  await ops.read(maya, a);
  await ops.send(theo, a, "bring the dice");
  const b = await ops.start(jules, maya);
  await ops.send(jules, b, "trail tomorrow");
  await ops.join(nina, eventId);
  const c = await ops.start(nina, maya);
  await ops.send(nina, c, "see you at the event");
  await ops.block(maya, nina);
  await ops.send(lena, await ops.start(lena, dev), "hello dev");
  await ops.block(dev, lena);
}

describe("messaging parity", () => {
  it("gives the same conversations, unread counts, previews and permissions in SQL and the demo store", async () => {
    const db = await createSeededDb();
    const repo = createDemoRepository(createIsolatedStore());
    const eventId = eventForNina(createIsolatedStore().state);
    const usernames = new Map(SEED_USERS.map((u) => [u.id, u.username]));
    type Row = { id: string; kind: string; event_id: string | null; event_title: string | null; other_username: string | null; last_body: string | null; last_sender_id: string | null; unread: number };
    // Conversation ids are random on each side, so compare by what they are.
    const norm = (r: { kind: string; eventId: string | null; eventTitle: string | null; other: string | null; lastBody: string | null; lastSender: string | null; unread: number }) =>
      [r.kind, r.eventId ?? r.other, r.eventTitle, r.lastBody, r.lastSender ? usernames.get(r.lastSender) : null, r.unread];

    const sql: Ops = {
      start: async (me, other) => (await queryAs<{ id: string }>(db, me, "select public.start_direct($1) as id", [other]))[0].id,
      send: async (me, conv, body) => { await sleep(3); await queryAs(db, me, "insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), $2)", [conv, body]); },
      read: async (me, conv) => { await sleep(3); await queryAs(db, me, "select public.mark_read($1)", [conv]); },
      block: async (me, other) => void (await queryAs(db, me, "insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), $1)", [other])),
      join: async (me, ev) => void (await queryAs(db, me, "insert into public.event_attendees (event_id, user_id) values ($1, auth.uid())", [ev])),
      view: async (me) => (await queryAs<Row>(db, me, "select * from public.my_conversations()")).map((r) =>
        norm({ kind: r.kind, eventId: r.event_id, eventTitle: r.event_title, other: r.other_username, lastBody: r.last_body, lastSender: r.last_sender_id, unread: r.unread })),
      canMessage: async (me, other) => (await queryAs<{ ok: boolean }>(db, me, "select public.can_message($1) as ok", [other]))[0].ok,
    };
    const demo: Ops = {
      start: (me, other) => repo.messaging.startDirect(me, other),
      // Distinct timestamps, as consecutive SQL statements have.
      send: async (me, conv, body) => { await sleep(3); await repo.messaging.send(me, conv, body); },
      read: async (me, conv) => { await sleep(3); await repo.messaging.markRead(me, conv); },
      block: (me, other) => repo.messaging.block(me, other),
      join: (me, ev) => repo.events.join(me, ev),
      view: async (me) => (await repo.messaging.conversations(me)).map((c) =>
        norm({ kind: c.kind, eventId: c.eventId, eventTitle: c.eventTitle, other: c.other?.username ?? null, lastBody: c.lastBody, lastSender: c.lastSenderId, unread: c.unread })),
      canMessage: (me, other) => repo.messaging.canMessage(me, other),
    };
    await script(sql, eventId);
    await script(demo, eventId);
    const sortRows = (rows: unknown[]) => [...rows].map((r) => JSON.stringify(r)).sort();
    for (const u of SEED_USERS) {
      // Same set of conversations; the order of the ones with messages is the same too.
      expect([u.username, sortRows(await demo.view(u.id))]).toEqual([u.username, sortRows(await sql.view(u.id))]);
      const active = async (o: Ops) => ((await o.view(u.id)) as unknown[][]).filter((r) => r[3] !== null).map((r) => r[1]);
      expect([u.username, await active(demo)]).toEqual([u.username, await active(sql)]);
      for (const v of SEED_USERS) {
        if (u.id === v.id) continue;
        expect([u.username, v.username, await demo.canMessage(u.id, v.id)]).toEqual([u.username, v.username, await sql.canMessage(u.id, v.id)]);
      }
    }
  }, 120_000);

  it("deletes a person's messages, memberships and blocks with their account, the same way", async () => {
    const db = await createSeededDb();
    const handle = createIsolatedStore();
    const repo = createDemoRepository(handle);
    const sqlConv = (await queryAs<{ id: string }>(db, maya, "select public.start_direct($1) as id", [jules]))[0].id;
    await queryAs(db, jules, "insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), 'from jules')", [sqlConv]);
    await queryAs(db, maya, "insert into public.messages (conversation_id, sender_id, body) values ($1, auth.uid(), 'from maya')", [sqlConv]);
    await queryAs(db, jules, "insert into public.blocks (blocker_id, blocked_id) values (auth.uid(), $1)", [dev]);
    const demoConv = await repo.messaging.startDirect(maya, jules);
    await repo.messaging.send(jules, demoConv, "from jules");
    await repo.messaging.send(maya, demoConv, "from maya");
    await repo.messaging.block(jules, dev);

    await db.query("delete from auth.users where id = $1", [jules]);
    deleteDemoAccount(handle, jules);
    const n = async (sql: string) => (await db.query<{ n: number }>(sql)).rows[0].n;
    const s = handle.state;
    expect({
      conversations: s.conversations.length,
      members: s.conversationMembers.length,
      messages: s.messages.length,
      blocks: s.blocks.length,
      julesMessages: s.messages.filter((m) => m.senderId === jules).length,
    }).toEqual({
      conversations: await n("select count(*)::int as n from public.conversations"),
      members: await n("select count(*)::int as n from public.conversation_members"),
      messages: await n("select count(*)::int as n from public.messages"),
      blocks: await n("select count(*)::int as n from public.blocks"),
      julesMessages: await n(`select count(*)::int as n from public.messages where sender_id = '${jules}'`),
    });
    expect(s.messages.filter((m) => m.conversationId === demoConv).map((m) => m.body)).toEqual(["from maya"]);
    // maya keeps the conversation, now with nobody on the other side.
    const left = (await repo.messaging.conversations(maya)).find((c) => c.id === demoConv)!;
    expect(left).toMatchObject({ other: null, lastBody: "from maya" });
  }, 120_000);
});

// ----------------------------------------------------------------------------
// Demo repository
// ----------------------------------------------------------------------------
describe("messaging in demo mode", () => {
  let repo: DataRepository;
  let handle: ReturnType<typeof createIsolatedStore>;
  beforeEach(() => {
    handle = createIsolatedStore();
    repo = createDemoRepository(handle);
  });

  it("refuses directs outside the rule, and keeps conversations to members", async () => {
    await expect(repo.messaging.startDirect(nina, maya)).rejects.toMatchObject({ code: "forbidden", message: DIRECT_MESSAGE_RULE });
    await expect(repo.messaging.startDirect(maya, stableId("profile:nobody"))).rejects.toMatchObject({ code: "not_found" });
    const conv = await repo.messaging.startDirect(maya, theo);
    await repo.messaging.send(maya, conv, "  hi  ");
    expect((await repo.messaging.messages(theo, conv)).items.map((m) => m.body)).toEqual(["hi"]);
    expect(await repo.messaging.get(dev, conv)).toBeNull();
    expect((await repo.messaging.messages(dev, conv)).items).toEqual([]);
    await expect(repo.messaging.send(dev, conv, "hi")).rejects.toMatchObject({ code: "not_found" });
    await expect(repo.messaging.send(maya, conv, "   ")).rejects.toMatchObject({ code: "invalid" });
    await expect(repo.messaging.send(maya, conv, "x".repeat(2001))).rejects.toMatchObject({ code: "invalid" });
  });

  it("pages messages newest first without gaps or repeats", async () => {
    const conv = await repo.messaging.startDirect(maya, theo);
    for (let i = 0; i < 7; i++) {
      await repo.messaging.send(i % 2 ? theo : maya, conv, `m${i}`);
      await sleep(2);
    }
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Awaited<ReturnType<DataRepository["messaging"]["messages"]>> = await repo.messaging.messages(maya, conv, { limit: 3, cursor });
      seen.push(...page.items.map((m) => m.body));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toEqual(["m6", "m5", "m4", "m3", "m2", "m1", "m0"]);
  });

  it("shows read receipts and unread counts", async () => {
    const conv = await repo.messaging.startDirect(maya, theo);
    await repo.messaging.send(maya, conv, "one");
    expect(await repo.messaging.unreadTotal(theo)).toBe(1);
    await sleep(2);
    await repo.messaging.markRead(theo, conv);
    expect(await repo.messaging.unreadTotal(theo)).toBe(0);
    const detail = await repo.messaging.get(maya, conv);
    expect(detail!.members.find((m) => m.profile.id === theo)!.lastReadAt).not.toBeNull();
    expect(detail!.canSend).toBe(true);
  });

  it("keeps group chats in step with joining, leaving and deleting events", async () => {
    const eventId = eventForNina(handle.state);
    expect(await repo.messaging.eventConversation(nina, eventId)).toBeNull();
    await repo.events.join(nina, eventId);
    const chat = await repo.messaging.eventConversation(nina, eventId);
    expect(chat).not.toBeNull();
    await repo.messaging.send(nina, chat!, "hello group");
    expect((await repo.messaging.messages(maya, chat!)).items[0].body).toBe("hello group");
    await repo.events.leave(nina, eventId);
    expect(await repo.messaging.get(nina, chat!)).toBeNull();
    // A new event's creator is in its chat; deleting the event deletes the chat.
    const ev = await repo.events.create({
      title: "Chat test", description: "A long enough description", placeId: null, locationName: "Park", address: null,
      lat: 39.96, lng: -83, startsAt: new Date(Date.now() + 86_400_000).toISOString(), endsAt: null, categorySlug: handle.state.events[0].categorySlug, capacity: null, tags: [],
    }, dev);
    const own = await repo.messaging.eventConversation(dev, ev.id);
    expect(own).not.toBeNull();
    await repo.messaging.send(dev, own!, "setting up");
    await repo.events.delete(ev.id, dev);
    expect(handle.state.conversations.some((c) => c.id === own)).toBe(false);
    expect(handle.state.messages.some((m) => m.conversationId === own)).toBe(false);
  });

  it("closes a direct across a block, both ways, and lists blocks privately", async () => {
    const conv = await repo.messaging.startDirect(maya, theo);
    await repo.messaging.send(theo, conv, "before");
    await repo.messaging.block(maya, theo);
    await repo.messaging.block(maya, theo); // idempotent
    expect((await repo.messaging.messages(maya, conv)).items).toEqual([]);
    await expect(repo.messaging.send(theo, conv, "after")).rejects.toMatchObject({ code: "forbidden" });
    expect((await repo.messaging.get(theo, conv))!).toMatchObject({ canSend: false, members: [expect.objectContaining({ profile: expect.objectContaining({ id: theo }) })] });
    expect(await repo.messaging.canMessage(theo, maya)).toBe(false);
    expect((await repo.messaging.blocked(maya)).map((p) => p.id)).toEqual([theo]);
    expect(await repo.messaging.blocked(theo)).toEqual([]);
    await expect(repo.messaging.block(maya, maya)).rejects.toMatchObject({ code: "invalid" });
    await repo.messaging.unblock(maya, theo);
    expect((await repo.messaging.messages(maya, conv)).items.map((m) => m.body)).toEqual(["before"]);
  });

  it("limits messages to 60 an hour, and refuses suspended accounts", async () => {
    const conv = await repo.messaging.startDirect(maya, theo);
    for (let i = 0; i < 60; i++) await repo.messaging.send(maya, conv, `m${i}`);
    await expect(repo.messaging.send(maya, conv, "61")).rejects.toMatchObject({ code: "rate_limited", message: expect.stringMatching(/^Too many messages/) });
    handle.state.suspensions.push({ userId: theo, reason: "test", suspendedBy: null, suspendedAt: new Date().toISOString() });
    await expect(repo.messaging.send(theo, conv, "hi")).rejects.toMatchObject({ code: "forbidden" });
    await expect(repo.messaging.block(theo, maya)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lets members report messages into the moderation queue", async () => {
    const conv = await repo.messaging.startDirect(jules, maya);
    const msg = await repo.messaging.send(jules, conv, "buy followers at spam.example");
    await expect(repo.reports.create({ targetType: "message", targetId: msg.id, reason: "spam" }, dev)).rejects.toMatchObject({ code: "not_found" });
    await repo.reports.create({ targetType: "message", targetId: msg.id, reason: "spam" }, maya);
    const queue = await repo.moderation.queue(sam);
    expect(queue.items.find((i) => i.targetId === msg.id)).toMatchObject({ targetType: "message", targetLabel: "buy followers at spam.example", targetStatus: "published" });
    // The filer's own list shows no message text.
    expect((await repo.reports.listFiledBy(maya)).find((r) => r.targetId === msg.id)!.targetLabel).toBeNull();
    await repo.moderation.resolve(sam, { targetType: "message", targetId: msg.id, action: "remove", reason: "spam" });
    expect((await repo.messaging.messages(maya, conv)).items).toEqual([]);
    expect((await repo.moderation.target(sam, "message", msg.id))!.snapshot).toMatchObject({ status: "removed", ownerUsername: "jules", body: "buy followers at spam.example" });
    await repo.moderation.resolve(sam, { targetType: "message", targetId: msg.id, action: "restore" });
    expect((await repo.messaging.messages(maya, conv)).items).toHaveLength(1);
  });

  it("migrates a v8 store by putting everyone going to an event in its chat", () => {
    const v8 = buildSeedState() as unknown as Record<string, unknown>;
    for (const k of ["conversations", "conversationMembers", "messages", "blocks"]) delete v8[k];
    v8.version = 8;
    const result = migrateDemoState(v8);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const s = result.state;
    for (const a of s.eventAttendees) {
      const chat = s.conversations.find((c) => c.eventId === a.eventId)!;
      expect(s.conversationMembers.some((m) => m.conversationId === chat.id && m.userId === a.userId)).toBe(true);
    }
    expect(s.messages).toEqual([]);
    expect(s.blocks).toEqual([]);
  });
});

// ----------------------------------------------------------------------------
// Actions and the polling route
// ----------------------------------------------------------------------------
const auth = vi.hoisted(() => ({ id: null as string | null }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/auth/server", () => ({ getViewer: async () => (auth.id ? { id: auth.id } : null) }));

describe("messaging actions and route", async () => {
  const actions = await import("../src/server/actions/messages");
  const { GET } = await import("../src/app/api/messages/[id]/route");
  const call = (id: string) => GET(new Request(`http://x/api/messages/${id}`), { params: Promise.resolve({ id }) } as never);
  beforeEach(() => {
    globalThis.__findmaxxingDemoStore = createIsolatedStore();
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "messaging");
    auth.id = maya;
  });

  it("do nothing while the flag is off", async () => {
    vi.stubEnv("NEXT_PUBLIC_FEATURES", "");
    expect(await actions.startDirectAction(theo)).toMatchObject({ ok: false, code: "unavailable" });
    expect((await call(stableId("x"))).status).toBe(404);
    vi.unstubAllEnvs();
  });

  it("start, send and read through the route, members only", async () => {
    auth.id = null;
    expect(await actions.startDirectAction(theo)).toMatchObject({ ok: false, code: "unauthenticated" });
    auth.id = maya;
    expect(await actions.startDirectAction("not-a-uuid")).toMatchObject({ ok: false });
    const started = await actions.startDirectAction(theo);
    expect(started.ok).toBe(true);
    const conversationId = started.ok ? started.data.conversationId : "";
    expect(await actions.sendMessageAction({ conversationId, body: "   " })).toMatchObject({ ok: false, fieldErrors: { body: "Write a message first" } });
    expect(await actions.sendMessageAction({ conversationId, body: "hi theo" })).toMatchObject({ ok: true, data: { body: "hi theo", senderId: maya } });
    auth.id = theo;
    const res = await call(conversationId);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const json = await res.json();
    expect(json.page.items.map((m: { body: string }) => m.body)).toEqual(["hi theo"]);
    expect(json.canSend).toBe(true);
    expect(await actions.markReadAction(conversationId)).toEqual({ ok: true, data: undefined });
    auth.id = dev;
    expect((await call(conversationId)).status).toBe(404);
    expect(await actions.sendMessageAction({ conversationId, body: "let me in" })).toMatchObject({ ok: false, code: "not_found" });
    auth.id = null;
    expect((await call(conversationId)).status).toBe(401);
  });

  it("refuse what the rules refuse, and block", async () => {
    auth.id = nina;
    expect(await actions.startDirectAction(maya)).toMatchObject({ ok: false, code: "forbidden", error: DIRECT_MESSAGE_RULE });
    auth.id = maya;
    expect(await actions.setBlockedAction(nina, true)).toEqual({ ok: true, data: undefined });
    const repo = createDemoRepository(globalThis.__findmaxxingDemoStore!);
    expect((await repo.messaging.blocked(maya)).map((p) => p.id)).toEqual([nina]);
    expect(await actions.setBlockedAction(nina, false)).toEqual({ ok: true, data: undefined });
    expect(await repo.messaging.blocked(maya)).toEqual([]);
  });
});
