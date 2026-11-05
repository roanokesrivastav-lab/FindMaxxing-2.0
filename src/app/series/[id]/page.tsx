import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { getRepository } from "@/lib/data";
import { getViewer } from "@/lib/auth/server";
import { featureEnabled } from "@/lib/config";
import { getViewerTime } from "@/lib/time/server";
import { uuidSchema } from "@/lib/validation/schemas";
import { describeActivity, hasNewcomerInfo } from "@findmaxxing/shared/events";
import { getCategory } from "@/lib/data/taxonomy";
import { eventHasEnded, formatEventDateLong, formatTimeRange, pluralize } from "@/lib/utils/format";
import { zonedTimeToUtc } from "@/lib/utils/timezone";
import { BackButton } from "@/components/ui/BackButton";
import { PlaceGlyph } from "@/components/ui/PlaceGlyph";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { Surface } from "@/components/ui/Surface";
import { EmptyState } from "@/components/ui/EmptyState";
import { ReadinessRow } from "@/components/events/ReadinessRow";
import { FollowSeriesButton } from "@/components/series/FollowSeriesButton";
import { SeriesHostPanel } from "@/components/series/SeriesHostPanel";
import { AttendanceList } from "@/components/series/AttendanceList";
import { StartClubForm } from "@/components/clubs/StartClubForm";
import { CalendarX } from "lucide-react";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Series" };

const DAY_NAMES = ["Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays", "Sundays"];

/** "Every Saturday", "Every other Monday and Thursday", in plain words. */
function scheduleText(weekdays: number[], intervalWeeks: number): string {
  const days = weekdays.map((d) => DAY_NAMES[d - 1]);
  const list = days.length > 1 ? `${days.slice(0, -1).join(", ")} and ${days.at(-1)}` : days[0];
  return intervalWeeks === 1 ? list : intervalWeeks === 2 ? `Every other week: ${list}` : `Every ${intervalWeeks} weeks: ${list}`;
}

/**
 * Roadmap 4.5b: the permanent series page (pilotEvents). Next confirmed session, upcoming and past
 * sessions, hosts, the newcomer note, and Follow (updates only, never an RSVP). Hosts get host tools:
 * backup hosts (owner) and attendance on past sessions.
 */
export default async function SeriesPage({ params }: PageProps<"/series/[id]">) {
  if (!featureEnabled("pilotEvents")) notFound();
  const [{ id }, viewer, repo, time] = await Promise.all([params, getViewer(), getRepository(), getViewerTime()]);
  if (!uuidSchema.safeParse(id).success) notFound();
  const series = await repo.series.get(id, viewer?.id ?? null);
  if (!series) notFound();
  const [occurrences, clubs] = await Promise.all([repo.series.occurrences(id, viewer?.id ?? null), repo.clubs.forSeries(id, viewer?.id ?? null)]);
  const zone = { timeZone: series.timeZone };
  const upcoming = occurrences.filter((e) => e.status === "published" && !eventHasEnded(e.startsAt, e.endsAt, time.now));
  const past = occurrences.filter((e) => eventHasEnded(e.startsAt, e.endsAt, time.now) && e.status !== "cancelled").reverse().slice(0, 8);
  // "Confirmed" = the host confirmed it, or it has no minimum to wait for.
  const nextConfirmed = upcoming.find((e) => e.decision === "happening" || !e.minAttendance) ?? null;
  const next = nextConfirmed ?? upcoming[0] ?? null;
  const isOwner = !!viewer && viewer.id === series.ownerId;
  const attendance = series.viewerIsHost
    ? await Promise.all(past.slice(0, 3).map(async (e) => {
        const detail = await repo.events.get(e.id, viewer!.id);
        const marks = new Map((await repo.series.attendance(viewer!.id, e.id)).map((a) => [a.userId, a.attended]));
        return { id: e.id, people: (detail?.attendees ?? []).map((a) => ({ userId: a.id, displayName: a.displayName, attended: marks.get(a.id) ?? null })) };
      }))
    : [];
  const startLabel = formatTimeRange(zonedTimeToUtc(series.rule.startsOn, series.rule.startLocal, series.timeZone).toISOString(), null, zone);
  const c = getCategory(series.categorySlug);
  const activity = describeActivity(series.activityDetails);

  return (
    <article className="treatment-editorial pb-nav md:pb-10">
      <div className="max-w-2xl mx-auto px-edge md:px-6">
        <div className="pt-row"><BackButton fallback="/events" /></div>
        <header className="mt-row flex flex-col gap-item">
          <span className="type-body inline-flex items-center gap-item font-semibold text-ink-2">
            <PlaceGlyph categorySlug={series.categorySlug} size={32} /> {c.label} · weekly series
          </span>
          <h1 className="type-page-title text-ink break-words">{series.title}</h1>
          <p className="type-body text-ink">{scheduleText(series.rule.weekdays, series.rule.intervalWeeks)} at {startLabel}</p>
          <p className="type-body text-ink-2 break-words">{series.locationName}{series.address ? `, ${series.address}` : ""}</p>
          {series.status !== "active" ? <StatusLabel tone="neutral">{series.status === "ended" ? "This series has ended" : "Paused"}</StatusLabel> : null}
          <p className="type-body text-ink-2 whitespace-pre-line break-words">{series.description}</p>
          <div className="flex flex-wrap items-center gap-row">
            <FollowSeriesButton seriesId={series.id} following={series.viewerFollows} signedIn={!!viewer} />
            <span className="type-body text-muted">Following sends you schedule changes and cancellations. It never signs you up.</span>
          </div>
        </header>

        <section aria-labelledby="se-next">
          <SectionHeader id="se-next" title={nextConfirmed ? "Next confirmed session" : "Next session"} />
          {next ? (
            <Surface variant="raised" className="rounded-2xl p-row flex flex-col gap-item">
              <Link href={`/events/${next.id}`} className="type-item-title text-ink underline underline-offset-4 break-words">
                {formatEventDateLong(next.startsAt, zone)}, {formatTimeRange(next.startsAt, next.endsAt, zone)}
              </Link>
              {next.readiness ? <ReadinessRow readiness={next.readiness} timeZone={series.timeZone} now={time.now} /> : null}
              {!nextConfirmed ? <p className="type-body text-ink-2">Not confirmed yet: it happens if enough people sign up by the host&apos;s deadline.</p> : null}
            </Surface>
          ) : (
            <EmptyState icon={CalendarX} heading="h3" title="No sessions scheduled" body={series.status === "active" ? "The next date appears here as soon as it is scheduled." : "This series is not running right now."} />
          )}
        </section>

        {upcoming.length > 1 ? (
          <section aria-labelledby="se-upcoming">
            <SectionHeader id="se-upcoming" title="Coming up" />
            <ul>
              {upcoming.filter((e) => e.id !== next?.id).map((e) => (
                <li key={e.id} className="surface-flat py-item flex flex-wrap items-center justify-between gap-item">
                  <Link href={`/events/${e.id}`} className="type-body text-ink font-semibold underline underline-offset-4">{formatEventDateLong(e.startsAt, zone)}</Link>
                  <span className="type-body text-ink-2">{pluralize(e.attendeeCount, "person", "people")} going</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {hasNewcomerInfo(series.newcomer) ? (
          <section aria-labelledby="se-new">
            <Surface variant="inset" className="mt-section rounded-xl p-row flex flex-col gap-item">
              <h2 id="se-new" className="type-item-title text-ink">New here?</h2>
              {series.newcomer.meetingSpot ? <p className="type-body text-ink-2"><span className="font-semibold text-ink">Where to find us: </span>{series.newcomer.meetingSpot}</p> : null}
              {series.newcomer.welcomer ? <p className="type-body text-ink-2"><span className="font-semibold text-ink">Who welcomes you: </span>{series.newcomer.welcomer}</p> : null}
              {series.newcomer.bring ? <p className="type-body text-ink-2"><span className="font-semibold text-ink">What to bring: </span>{series.newcomer.bring}</p> : null}
              {series.newcomer.soloWelcome ? <p className="type-body text-ink-2">Coming alone is normal here.</p> : null}
            </Surface>
          </section>
        ) : null}

        {activity.length ? (
          <section aria-labelledby="se-activity">
            <SectionHeader id="se-activity" title="What it's like" />
            <ul className="flex flex-col gap-hair">{activity.map((l) => <li key={l} className="type-body text-ink-2">{l}</li>)}</ul>
          </section>
        ) : null}

        <section aria-labelledby="se-hosts">
          <SectionHeader id="se-hosts" title="Hosts" />
          <ul className="flex flex-col gap-hair">
            {series.hosts.map((h) => (
              <li key={h.userId} className="type-body text-ink">
                {h.username ? <Link href={`/u/${h.username}`} className="font-semibold underline underline-offset-4">{h.displayName}</Link> : h.displayName}
                <span className="text-muted"> · {h.role === "owner" ? "organizer" : "backup host"}</span>
              </li>
            ))}
          </ul>
          {isOwner ? <SeriesHostPanel seriesId={series.id} hosts={series.hosts} /> : null}
        </section>

        {clubs.length || series.viewerIsHost ? (
          <section aria-labelledby="se-clubs">
            <SectionHeader id="se-clubs" title="Clubs" />
            {clubs.length ? (
              <ul className="flex flex-col gap-hair mb-item">
                {clubs.map((c) => <li key={c.id}><Link href={`/clubs/${c.id}`} className="type-body font-semibold text-ink underline underline-offset-4">{c.name}</Link></li>)}
              </ul>
            ) : null}
            {series.viewerIsHost ? <StartClubForm seriesId={series.id} /> : null}
          </section>
        ) : null}

        <section aria-labelledby="se-past">
          <SectionHeader id="se-past" title="Past sessions" />
          {past.length ? (
            <ul>
              {past.map((e) => {
                const marks = attendance.find((a) => a.id === e.id);
                return (
                  <li key={e.id} className="surface-flat py-item">
                    <Link href={`/events/${e.id}`} className="type-body text-ink font-semibold underline underline-offset-4">{formatEventDateLong(e.startsAt, zone)}</Link>
                    <span className="type-body text-ink-2"> · {pluralize(e.attendeeCount, "person", "people")} signed up</span>
                    {marks && marks.people.length ? <AttendanceList eventId={e.id} people={marks.people} /> : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="type-body text-muted">No past sessions yet.</p>
          )}
        </section>
      </div>
    </article>
  );
}
