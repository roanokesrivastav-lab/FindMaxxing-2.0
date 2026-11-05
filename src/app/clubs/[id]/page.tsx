import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { MessageCircle } from "lucide-react";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { getViewerTime } from "@/lib/time/server";
import { uuidSchema } from "@/lib/validation/schemas";
import { eventHasEnded, formatEventDateLong, formatTimeRange, pluralize } from "@/lib/utils/format";
import { BackButton } from "@/components/ui/BackButton";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { ReadinessRow } from "@/components/events/ReadinessRow";
import { ClubJoinButton, RemoveMemberButton } from "@/components/clubs/ClubJoinButton";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Club" };

/**
 * Roadmap R3: a lightweight club (pilotEvents). Its series with their next session, hosts, members
 * (names for members and hosts only; a count for everyone else), Join / Leave (never an RSVP), and
 * the next session's existing group chat for members going.
 */
export default async function ClubPage({ params }: PageProps<"/clubs/[id]">) {
  if (!featureEnabled("pilotEvents")) notFound();
  const [{ id }, viewer, repo, time] = await Promise.all([params, getViewer(), getRepository(), getViewerTime()]);
  if (!uuidSchema.safeParse(id).success) notFound();
  const club = await repo.clubs.get(id, viewer?.id ?? null);
  if (!club) notFound();
  const series = (await Promise.all(club.seriesIds.map(async (sid) => {
    const s = await repo.series.get(sid, viewer?.id ?? null);
    if (!s) return null;
    const next = (await repo.series.occurrences(sid, viewer?.id ?? null)).find((e) => e.status === "published" && !eventHasEnded(e.startsAt, e.endsAt, time.now)) ?? null;
    return { s, next };
  }))).filter((x): x is NonNullable<typeof x> => !!x);
  const hosts = new Map<string, { name: string; username: string }>();
  for (const { s } of series) for (const h of s.hosts) hosts.set(h.userId, { name: h.displayName, username: h.username });
  const owner = club.members?.find((m) => m.role === "owner");
  if (owner) hosts.set(owner.userId, { name: owner.displayName, username: owner.username });
  // The existing event group chat of the soonest next session, for a member who is going.
  const soonest = series.map((x) => x.next).filter((e): e is NonNullable<typeof e> => !!e).sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0] ?? null;
  const chatId = viewer && club.viewerIsMember && soonest && featureEnabled("messaging") ? await repo.messaging.eventConversation(viewer.id, soonest.id) : null;
  const isOwner = !!viewer && viewer.id === club.ownerId;

  return (
    <article className="treatment-editorial pb-nav md:pb-10">
      <div className="max-w-2xl mx-auto px-edge md:px-6">
        <div className="pt-row"><BackButton fallback="/events" /></div>
        <header className="mt-row flex flex-col gap-item">
          <span className="type-body font-semibold text-ink-2">Club · {pluralize(club.memberCount, "member")}</span>
          <h1 className="type-page-title text-ink break-words">{club.name}</h1>
          {club.status === "removed" ? <StatusLabel tone="negative">Removed by moderators</StatusLabel> : null}
          {club.description ? <p className="type-body text-ink-2 whitespace-pre-line break-words">{club.description}</p> : null}
          <div className="flex flex-wrap items-center gap-row">
            <ClubJoinButton clubId={club.id} member={club.viewerIsMember} owner={isOwner} signedIn={!!viewer} />
            <span className="type-body text-muted">Joining never signs you up for a session.</span>
          </div>
          {chatId ? (
            <Link href={`/messages/${chatId}`} className="type-body font-semibold inline-flex items-center gap-item underline underline-offset-4 self-start">
              <MessageCircle size={16} aria-hidden /> Group chat for the next session
            </Link>
          ) : null}
        </header>

        <section aria-labelledby="club-series">
          <SectionHeader id="club-series" title="Sessions" />
          <ul>
            {series.map(({ s, next }) => (
              <li key={s.id} className="surface-flat py-row flex flex-col gap-hair">
                <Link href={`/series/${s.id}`} className="type-item-title text-ink underline underline-offset-4 break-words">{s.title}</Link>
                {next ? (
                  <>
                    <Link href={`/events/${next.id}`} className="type-body text-ink-2 underline underline-offset-4">Next: {formatEventDateLong(next.startsAt, { timeZone: s.timeZone })}, {formatTimeRange(next.startsAt, next.endsAt, { timeZone: s.timeZone })}</Link>
                    {next.readiness ? <ReadinessRow readiness={next.readiness} timeZone={s.timeZone} now={time.now} /> : null}
                  </>
                ) : <span className="type-body text-muted">No session scheduled right now.</span>}
              </li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="club-hosts">
          <SectionHeader id="club-hosts" title="Hosts" />
          <ul className="flex flex-col gap-hair">
            {[...hosts.entries()].map(([uid, h]) => (
              <li key={uid} className="type-body text-ink">{h.username ? <Link href={`/u/${h.username}`} className="font-semibold underline underline-offset-4">{h.name}</Link> : h.name}</li>
            ))}
          </ul>
        </section>

        <section aria-labelledby="club-members">
          <SectionHeader id="club-members" title="Members" />
          {club.members ? (
            <ul>
              {club.members.map((m) => (
                <li key={m.userId} className="surface-flat py-item flex flex-wrap items-center justify-between gap-item">
                  <span className="type-body text-ink">{m.displayName}{m.role === "owner" ? <span className="text-muted"> · started the club</span> : null}</span>
                  {isOwner && m.role !== "owner" ? <RemoveMemberButton clubId={club.id} userId={m.userId} name={m.displayName} /> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="type-body text-ink-2">{pluralize(club.memberCount, "member")}. Only members see who&apos;s in the club.</p>
          )}
        </section>
      </div>
    </article>
  );
}
