import Link from "next/link";
import { LevelBadge } from "./LevelBadge";
import { Flag, MapPin, Pencil, Settings, ShieldAlert, ShieldCheck } from "lucide-react";
import type { Profile, ProfileStats, RemovedContent, UserActivity } from "@/lib/data/types";
import { Avatar } from "@/components/ui/Avatar";
import { getInterest } from "@/lib/data/taxonomy";
import { FollowButton } from "./FollowButton";
import { ActivityTabs } from "./ActivityTabs";
import { SignOutButton } from "@/components/auth/SignOutButton";

const REMOVED_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

export function ProfileView({
  profile,
  stats,
  activity,
  isSelf,
  viewerSignedIn,
  viewerFollows,
  removed = [],
  isModerator = false,
  showLevel = false,
  suspended = false,
}: {
  profile: Profile;
  stats: ProfileStats;
  activity: UserActivity;
  isSelf: boolean;
  viewerSignedIn: boolean;
  viewerFollows: boolean;
  /** The viewer's own content that moderators removed (self view only). */
  removed?: RemovedContent[];
  isModerator?: boolean;
  /** Reputation level badge, behind the reputation flag. */
  showLevel?: boolean;
  /** The viewer's own account is suspended (self view only). */
  suspended?: boolean;
}) {
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-5 md:pt-8 pb-nav md:pb-10">
      <div className="card p-5">
        <div className="flex items-start gap-4">
          <Avatar name={profile.displayName} src={profile.avatarUrl} size={72} />
          <div className="flex-1 min-w-0">
            <h1 className="text-2xl font-bold leading-tight break-words">{profile.displayName}</h1>
            <p className="text-sm text-muted">@{profile.username}</p>
            {showLevel ? <div className="mt-1.5"><LevelBadge level={profile.reputationLevel} /></div> : null}
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
        <ul className="mt-5 grid grid-cols-4 gap-2 text-center list-none p-0 m-0" aria-label="Profile stats">
          {([
            { label: "Places", value: stats.places, href: null },
            { label: "Events", value: stats.events, href: null },
            { label: "Followers", value: stats.followers, href: `/u/${profile.username}/followers` },
            { label: "Following", value: stats.following, href: `/u/${profile.username}/following` },
          ] as const).map(({ label, value, href }) => {
            const body = (
              <>
                <span className="block text-[11px] font-semibold uppercase tracking-wide text-muted">{label}</span>
                <span className="block font-display text-xl font-bold">{value}</span>
              </>
            );
            return (
              <li key={label}>
                {href ? (
                  <Link href={href} className="block rounded-xl bg-surface-2 py-2 hover:bg-line transition-colors">
                    {body}
                  </Link>
                ) : (
                  <div className="rounded-xl bg-surface-2 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>

      {isSelf && suspended ? (
        <p className="mt-5 card p-4 text-sm border-danger/40" role="status">
          <b>Your account is suspended.</b> You can still browse, but you can&apos;t add or change anything until an admin lifts it.
        </p>
      ) : null}

      {isSelf && removed.length ? (
        <section className="mt-5 card p-5 border-danger/40" aria-labelledby="removed-heading">
          <h2 id="removed-heading" className="font-bold inline-flex items-center gap-2">
            <ShieldAlert size={16} className="text-danger" /> Removed by moderators
          </h2>
          <p className="text-sm text-muted mt-1">These no longer appear anywhere, for anyone. You can&apos;t edit or republish them.</p>
          <ul className="mt-3 flex flex-col gap-2 list-none p-0 m-0">
            {removed.map((r) => (
              <li key={`${r.targetType}:${r.targetId}`} className="rounded-xl bg-surface-2 px-4 py-3">
                <p className="text-sm font-semibold break-words">
                  {r.targetType === "place" ? "Place" : "Event"}: {r.label}
                </p>
                <p className="text-sm text-ink-2 mt-0.5 break-words">{r.reason ? `Reason: ${r.reason}` : "No reason was recorded."}</p>
                {r.removedAt ? <p className="text-xs text-muted mt-1">Removed {REMOVED_DATE.format(new Date(r.removedAt))}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="mt-5">
        {/* Keeps the heading outline whole: the activity cards use h3. */}
        <h2 className="sr-only">Activity</h2>
        <ActivityTabs activity={activity} isSelf={isSelf} />
      </div>

      {isSelf ? (
        <div className="mt-8 flex flex-col items-center gap-3">
          <div className="flex flex-wrap justify-center gap-2">
            <Link href="/profile/reports" className="chip">
              <Flag size={14} />
              Reports
            </Link>
            <Link href="/profile/settings" className="chip">
              <Settings size={14} />
              Settings
            </Link>
            {isModerator ? (
              <Link href="/moderation" className="chip">
                <ShieldCheck size={14} />
                Moderation queue
              </Link>
            ) : null}
          </div>
          <SignOutButton />
        </div>
      ) : null}
    </div>
  );
}
