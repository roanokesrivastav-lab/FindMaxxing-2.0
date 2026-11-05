"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { getRepository } from "@/lib/data";
import { MAX_MESSAGE_LENGTH } from "@/lib/data/messaging";
import type { Message } from "@/lib/data/types";
import { fail, succeed, toFailure, type ActionResult } from "./result";

const id = z.string().uuid();
const sendSchema = z.object({
  conversationId: id,
  body: z.string().trim().min(1, "Write a message first").max(MAX_MESSAGE_LENGTH, `Keep messages under ${MAX_MESSAGE_LENGTH} characters`),
});

/** Every messaging action: the flag must be on and someone signed in. */
async function messagingViewer() {
  if (!featureEnabled("messaging")) return { error: fail("Messaging is not available", undefined, "unavailable") };
  const viewer = await getViewer();
  if (!viewer) return { error: fail("Sign in first", undefined, "unauthenticated") };
  return { viewer };
}

/** Opens (or finds) the direct conversation with someone the rules allow. */
export async function startDirectAction(otherId: string): Promise<ActionResult<{ conversationId: string }>> {
  const { viewer, error } = await messagingViewer();
  if (error) return error;
  if (!id.safeParse(otherId).success) return fail("Profile not found", undefined, "not_found");
  try {
    const conversationId = await (await getRepository()).messaging.startDirect(viewer.id, otherId);
    revalidatePath("/messages");
    return succeed({ conversationId });
  } catch (err) {
    return toFailure(err);
  }
}

export async function sendMessageAction(input: { conversationId: string; body: string }): Promise<ActionResult<Message>> {
  const { viewer, error } = await messagingViewer();
  if (error) return error;
  const parsed = sendSchema.safeParse(input);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? "Check your message", { body: parsed.error.issues[0]?.message ?? "" });
  try {
    const message = await (await getRepository()).messaging.send(viewer.id, parsed.data.conversationId, parsed.data.body);
    revalidatePath("/messages");
    return succeed(message);
  } catch (err) {
    return toFailure(err);
  }
}

export async function markReadAction(conversationId: string): Promise<ActionResult> {
  const { viewer, error } = await messagingViewer();
  if (error) return error;
  if (!id.safeParse(conversationId).success) return fail("That conversation doesn't exist.", undefined, "not_found");
  try {
    await (await getRepository()).messaging.markRead(viewer.id, conversationId);
    revalidatePath("/", "layout");
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}

/** Blocks or unblocks someone. Blocking hides their messages and closes any direct conversation. */
export async function setBlockedAction(otherId: string, blocked: boolean): Promise<ActionResult> {
  const { viewer, error } = await messagingViewer();
  if (error) return error;
  if (!id.safeParse(otherId).success) return fail("Profile not found", undefined, "not_found");
  try {
    const repo = await getRepository();
    if (blocked) await repo.messaging.block(viewer.id, otherId);
    else await repo.messaging.unblock(viewer.id, otherId);
    revalidatePath("/messages", "layout");
    revalidatePath("/u/[username]", "page");
    return succeed(undefined);
  } catch (err) {
    return toFailure(err);
  }
}
