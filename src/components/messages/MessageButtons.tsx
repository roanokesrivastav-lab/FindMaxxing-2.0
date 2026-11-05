"use client";
import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, MessageCircle } from "lucide-react";
import { setBlockedAction, startDirectAction } from "@/server/actions/messages";
import { useToast } from "@/components/ui/Toast";
import { DIRECT_MESSAGE_RULE } from "@/lib/data/messaging";
import { cn } from "@/lib/utils/cn";

const chip = "h-9 px-3.5 rounded-full text-sm font-semibold inline-flex items-center gap-1.5 border transition-colors active:scale-[0.97]";

/** "Message" on someone's profile, when the anti-spam rule allows it; otherwise the rule, explained. */
export function MessageButton({ userId, canMessage }: { userId: string; canMessage: boolean }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  if (!canMessage) return <p className="text-xs text-muted">{DIRECT_MESSAGE_RULE}</p>;
  return (
    <button
      type="button"
      disabled={pending}
      className={cn(chip, "bg-surface border-line text-ink hover:bg-surface-2")}
      onClick={() =>
        start(async () => {
          const res = await startDirectAction(userId);
          if (res.ok) router.push(`/messages/${res.data.conversationId}`);
          else toast(res.error, "error");
        })
      }
    >
      <MessageCircle size={16} /> Message
    </button>
  );
}

/** Block or unblock someone: they can't message you, and you stop seeing their messages. */
export function BlockButton({ userId, blocked, name }: { userId: string; blocked: boolean; name: string }) {
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  return (
    <button
      type="button"
      disabled={pending}
      aria-pressed={blocked}
      className={cn(chip, blocked ? "bg-danger-100 border-danger-100 text-danger" : "bg-surface border-line text-muted hover:text-ink")}
      onClick={() => {
        if (!blocked && !window.confirm(`Block ${name}? They won't be able to message you, and you won't see their messages.`)) return;
        start(async () => {
          const res = await setBlockedAction(userId, !blocked);
          if (!res.ok) toast(res.error, "error");
          else {
            toast(blocked ? `Unblocked ${name}` : `Blocked ${name}`, "success");
            router.refresh();
          }
        });
      }}
    >
      <Ban size={15} /> {blocked ? "Unblock" : "Block"}
    </button>
  );
}
