import { EyeOff, Lock, ShieldCheck, Sparkles, Users } from "lucide-react";
import type { PlaceStatus, Visibility } from "@/lib/data/types";

/**
 * Explains why a place isn't publicly listed, shown to anyone who can see it.
 * A locals-only place reaching a local should still say so, because that is the
 * point of the tier: you are seeing something not everyone gets.
 */
export function VisibilityNotice({
  status,
  visibility,
  city,
  isOwner,
}: {
  status: PlaceStatus;
  visibility: Visibility;
  city: string;
  isOwner: boolean;
}) {
  if (status === "hidden") {
    return (
      <Notice tone="warn" icon={<EyeOff size={17} />} title="Hidden from the map">
        {isOwner ? "Only you can see this. Publish it again when you're ready." : "The person who added this has hidden it."}
      </Notice>
    );
  }
  if (status === "pending") {
    return (
      <Notice tone="warn" icon={<EyeOff size={17} />} title="Under review">
        This listing is being checked before it goes back on the map.
      </Notice>
    );
  }
  if (visibility === "private") {
    return (
      <Notice tone="plain" icon={<Lock size={17} />} title="Only you">
        This place is private. Nobody else can see it.
      </Notice>
    );
  }
  if (visibility === "locals") {
    return (
      <Notice tone="local" icon={<ShieldCheck size={17} />} title={`Locals only · ${city}`}>
        {isOwner
          ? `Visible to people whose home city is ${city}, and to anyone who has added a place there.`
          : `You're seeing this because you're a local. Keep it good.`}
      </Notice>
    );
  }
  if (visibility === "trusted") {
    return (
      <Notice tone="local" icon={<Sparkles size={17} />} title={`Trusted locals · ${city}`}>
        {isOwner
          ? `Visible to locals of ${city} who have reached the Trusted local level.`
          : "You're seeing this because you're a trusted local. Thanks for what you've added."}
      </Notice>
    );
  }
  if (visibility === "followers") {
    return (
      <Notice tone="plain" icon={<Users size={17} />} title="People they follow back">
        {isOwner ? "Visible to people who follow you and whom you follow back." : "Shared with people they follow back, which includes you."}
      </Notice>
    );
  }
  return null;
}

function Notice({
  tone,
  icon,
  title,
  children,
}: {
  tone: "warn" | "local" | "plain";
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  const styles =
    tone === "warn"
      ? "bg-sun-100 border-sun/40 text-ink"
      : tone === "local"
        ? "bg-moss-100 border-moss/30 text-ink"
        : "bg-surface-2 border-line text-ink";
  const iconColor = tone === "warn" ? "text-sun" : tone === "local" ? "text-moss" : "text-muted";
  return (
    <div className={`rounded-2xl border p-4 flex gap-3 ${styles}`}>
      <span className={`shrink-0 mt-0.5 ${iconColor}`}>{icon}</span>
      <div>
        <p className="text-sm font-bold">{title}</p>
        <p className="text-sm text-ink-2 mt-0.5">{children}</p>
      </div>
    </div>
  );
}
