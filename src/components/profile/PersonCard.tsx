import Link from "next/link";
import type { Profile } from "@/lib/data/types";
import { Avatar } from "@/components/ui/Avatar";
import { getInterest } from "@/lib/data/taxonomy";
import type { ReactNode } from "react";

export function PersonCard({ profile, action, sharedInterests }: { profile: Profile; action?: ReactNode; sharedInterests?: string[] }) {
  const shown = (sharedInterests?.length ? sharedInterests : profile.interests).slice(0, 3);
  return (
    <div className="card p-4 flex items-center gap-3">
      <Link href={`/u/${profile.username}`} className="shrink-0">
        <Avatar name={profile.displayName} src={profile.avatarUrl} size={48} />
      </Link>
      <div className="min-w-0 flex-1">
        <Link href={`/u/${profile.username}`} className="block font-bold truncate hover:text-flare-600">
          {profile.displayName}
        </Link>
        <p className="text-xs text-muted truncate">@{profile.username}{profile.homeCity ? ` · ${profile.homeCity}` : ""}</p>
        {shown.length ? (
          <div className="mt-1.5 flex gap-1 flex-wrap">
            {shown.map((i) => {
              const it = getInterest(i);
              return (
                <span key={i} className="rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-semibold text-ink-2">
                  {it.emoji} {it.label}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
      {action}
    </div>
  );
}
