import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BackButton } from "@/components/ui/BackButton";
import { ConfirmWithReason } from "@/components/admin/ConfirmWithReason";
import { ACTION_LABEL, DATE_TIME } from "@/components/moderation/labels";
import { uuidSchema } from "@/lib/validation/schemas";
import { ADMIN_DATE, requireAdmin } from "../../guard";
import { LocalDate } from "@/components/time/LocalDate";

export const metadata: Metadata = { title: "Person · Admin" };
export const dynamic = "force-dynamic";

export default async function AdminUserPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { viewer, repo } = await requireAdmin(`/admin/users/${id}`);
  if (!uuidSchema.safeParse(id).success) notFound();
  const profile = await repo.profiles.getById(id);
  if (!profile) notFound();
  const [match, history, content] = await Promise.all([
    repo.admin.users(viewer.id, { query: profile.username, limit: 100 }),
    repo.admin.history(viewer.id, { type: "profile", id }),
    repo.admin.content(viewer.id, { kind: "place", creatorId: id, limit: 10 }),
  ]);
  const u = match.items.find((x) => x.id === id);
  if (!u) notFound();
  const self = id === viewer.id;
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <div className="mb-4"><BackButton fallback="/admin/users" /></div>
      <section className="card p-5">
        <h1 className="text-2xl font-bold">{u.displayName}</h1>
        <p className="text-sm text-muted"><Link href={`/u/${u.username}`} className="hover:text-ink">@{u.username}</Link>{u.homeCity ? ` · ${u.homeCity}` : ""} · joined <LocalDate value={u.createdAt} format={ADMIN_DATE} /></p>
        <p className="text-sm mt-2">{u.places} places · {u.events} events · {u.reportsAgainst} reports against · level {u.reputationLevel}</p>
        <p className="text-sm mt-1">{u.suspended ? "Suspended: cannot add or change anything." : "Active."} {u.isAdmin ? "Admin." : u.isModerator ? "Moderator." : ""}</p>
        {!self ? (
          <div className="mt-4 flex flex-wrap gap-2">
            {u.suspended ? (
              <ConfirmWithReason label="Lift suspension" title="Lift the suspension?" body="They can add, save, rate, join and report again straight away." confirm="Lift suspension" done="Suspension lifted" input={{ kind: "suspend", userId: id, on: false }} />
            ) : (
              <ConfirmWithReason danger label="Suspend" title="Suspend this account?" body="They can still sign in and browse, but every write is refused by the database until you lift it: no new places, events, ratings, saves, lists, follows, reports or uploads. What they already added stays up; remove individual items from the report queue if needed." confirm="Suspend" done="Account suspended" input={{ kind: "suspend", userId: id, on: true }} />
            )}
            {u.isModerator ? (
              <ConfirmWithReason label="Remove as moderator" title="Remove moderator access?" body="They lose the report queue and every moderation action immediately. Their past decisions stay in the history." confirm="Remove" done="No longer a moderator" input={{ kind: "moderator", userId: id, on: false }} />
            ) : (
              <ConfirmWithReason label="Make moderator" title="Make them a moderator?" body="They will see who filed reports, resolve them, remove and restore content, and revoke local status. Everything they do is recorded." confirm="Make moderator" done="Now a moderator" input={{ kind: "moderator", userId: id, on: true }} />
            )}
          </div>
        ) : <p className="text-xs text-muted mt-3">This is you. Another admin has to change your account.</p>}
      </section>

      <section className="mt-6">
        <h2 className="font-bold mb-2">Recent places</h2>
        <ul className="flex flex-col gap-1.5 list-none p-0 m-0 text-sm">
          {content.items.map((c) => (
            <li key={c.id}><Link href={`/moderation/place/${c.id}`} className="font-semibold hover:underline">{c.label}</Link> <span className="text-muted">· {c.status} · {c.openReports} open reports</span></li>
          ))}
          {!content.items.length ? <li className="text-muted">None.</li> : null}
        </ul>
        {content.nextCursor ? <Link href={`/admin/content?creator=${id}`} className="text-sm font-semibold underline mt-2 inline-block">All their content</Link> : null}
      </section>

      <section className="mt-6">
        <h2 className="font-bold mb-2">History</h2>
        <ol className="flex flex-col gap-2 list-none p-0 m-0">
          {history.map((h) => (
            <li key={h.id} className="rounded-xl bg-surface-2 px-4 py-3 text-sm">
              <b>{ACTION_LABEL[h.action] ?? h.action}</b>{h.reason ? ` — “${h.reason}”` : ""}
              <p className="text-xs text-muted mt-1">{h.moderatorUsername ? `@${h.moderatorUsername}` : "A former moderator"} · <LocalDate value={h.createdAt} format={DATE_TIME} /></p>
            </li>
          ))}
          {!history.length ? <li className="text-sm text-muted">No actions yet.</li> : null}
        </ol>
      </section>
    </div>
  );
}
