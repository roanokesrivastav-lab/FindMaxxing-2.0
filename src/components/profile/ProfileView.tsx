import Link from "next/link";
import { Flag, MapPin, Pencil } from "lucide-react";
import type { Profile, ProfileStats, UserActivity } from "@/lib/data/types";
import { Avatar } from "@/components/ui/Avatar";
import { getInterest } from "@/lib/data/taxonomy";
import { FollowButton } from "./FollowButton";
import { ActivityTabs } from "./ActivityTabs";
import { SignOutButton } from "@/components/auth/SignOutButton";

export function ProfileView({
  profile,
  stats,
  activity,
  isSelf,
  viewerSignedIn,
  viewerFollows,
}: {
  profile: Profile;
  stats: ProfileStats;
  activity: UserActivity;
  isSelf: boolean;
  viewerSignedIn: boolean;
  viewerFollows: boolean;
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <div className="card p-5">
        <div className="flex items-start gap-4">
          <Avatar name={profile.displayName} src={profile.avatarUrl} size={72} />
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold leading-tight break-words">{profile.displayName}</h1>
            <p className="text-sm text-muted">@{profile.username}</p>
            {profile.homeCity ? (
              <p className="text-sm text-ink-2 mt-1 inline-flex items-center gap-1">
                <MapPin size={13} /> {profile.homeCity}
              </p>
            ) : null}
          </div>
          {isSelf ? (
            <Link href="/profile/edit" className="chip shrink-0">
              <Pencil size={14} /> Edit
            </Link>
          ) : (
            <FollowButton userId={profile.id} following={viewerFollows} signedIn={viewerSignedIn} size="sm" />
          )}
        </div>
        {profile.bio ? <p className="mt-4 text-[15px] leading-relaxed">{profile.bio}</p> : isSelf ? (
          <p className="mt-4 text-sm text-muted">
            Add a bio and interests so people know what you&apos;re into.{" "}
            <Link href="/profile/edit" className="font-semibold text-ink underline underline-offset-4">
              Edit profile
            </Link>
          </p>
        ) : null}
        {profile.interests.length ? (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {profile.interests.map((slug) => {
              const i = getInterest(slug);
              return (
                <Link
                  key={slug}
                  href={`/tags/${slug}`}
                  className="rounded-full bg-surface-2 px-2.5 py-1 text-xs font-semibold text-ink-2 hover:bg-line transition-colors"
                  title={`Browse ${i.label}`}
                >
                  {i.emoji} {i.label}
                </Link>
              );
            })}
          </div>
        ) : null}
        <dl className="mt-5 grid grid-cols-4 gap-2 text-center">
          {([
            { label: "Places", value: stats.places, href: null },
            { label: "Events", value: stats.events, href: null },
            { label: "Followers", value: stats.followers, href: `/u/${profile.username}/followers` },
            { label: "Following", value: stats.following, href: `/u/${profile.username}/following` },
          ] as const).map(({ label, value, href }) => {
            const body = (
              <>
                <dt className="text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</dt>
                <dd className="font-display text-xl font-bold">{value}</dd>
              </>
            );
            return href ? (
              <Link key={label} href={href} className="rounded-xl bg-surface-2 py-2 hover:bg-line transition-colors">
                {body}
              </Link>
            ) : (
              <div key={label} className="rounded-xl bg-surface-2 py-2">
                {body}
              </div>
            );
          })}
        </dl>
      </div>

      <div className="mt-5">
        <ActivityTabs activity={activity} isSelf={isSelf} />
      </div>

      {isSelf ? (
        <div className="mt-8 flex flex-col items-center gap-3">
          <Link href="/profile/reports" className="chip">
            <Flag size={14} />
            Reports
          </Link>
          <SignOutButton />
        </div>
      ) : null}
    </div>
  );
}
