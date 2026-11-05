import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataError } from "@/lib/data/types";
import { ADMIN_DATE, requireAdmin } from "../guard";
import { LocalDate } from "@/components/time/LocalDate";

export const metadata: Metadata = { title: "People · Admin" };
export const dynamic = "force-dynamic";

export default async function AdminUsersPage({ searchParams }: { searchParams: Promise<{ q?: string; cursor?: string }> }) {
  const { viewer, repo } = await requireAdmin("/admin/users");
  const { q, cursor } = await searchParams;
  const page = await repo.admin.users(viewer.id, { query: q ?? null, cursor: cursor ?? null }).catch((err) => {
    if (err instanceof DataError && err.code === "invalid") return repo.admin.users(viewer.id, { query: q ?? null });
    throw err;
  });
  const next = page.nextCursor ? `/admin/users?${new URLSearchParams({ ...(q ? { q } : {}), cursor: page.nextCursor })}` : null;
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Admin" title="People" subtitle="Newest first." />
      <form className="flex gap-2 mb-4" role="search">
        <label htmlFor="admin-q" className="sr-only">Search by username or name</label>
        <input id="admin-q" name="q" defaultValue={q ?? ""} placeholder="Username or name" className="field flex-1" />
        <button type="submit" className="chip">Search</button>
      </form>
      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {page.items.map((u) => (
          <li key={u.id}>
            <Link href={`/admin/users/${u.id}`} className="card p-4 block hover:border-ink transition-colors">
              <div className="flex items-start justify-between gap-3">
                <span className="min-w-0">
                  <span className="font-bold block truncate">{u.displayName}</span>
                  <span className="text-sm text-muted">@{u.username}{u.homeCity ? ` · ${u.homeCity}` : ""} · joined <LocalDate value={u.createdAt} format={ADMIN_DATE} /></span>
                </span>
                <span className="flex flex-wrap gap-1 justify-end shrink-0">
                  {u.suspended ? <span className="rounded-full bg-danger-100 text-danger text-xs font-bold px-2 py-0.5">Suspended</span> : null}
                  {u.isAdmin ? <span className="rounded-full bg-ink text-white text-xs font-bold px-2 py-0.5">Admin</span> : u.isModerator ? <span className="rounded-full bg-surface-2 text-xs font-bold px-2 py-0.5">Moderator</span> : null}
                </span>
              </div>
              <p className="text-xs text-muted mt-1.5">{u.places} places · {u.events} events · {u.reportsAgainst} reports against · {u.reputationLevel}</p>
            </Link>
          </li>
        ))}
      </ul>
      {!page.items.length ? <p className="text-sm text-muted">Nobody matches.</p> : null}
      <nav className="mt-6 flex justify-between" aria-label="Pages">
        {cursor ? <Link href={`/admin/users${q ? `?q=${encodeURIComponent(q)}` : ""}`} className="chip">First page</Link> : <span />}
        {next ? <Link href={next} className="chip">Next page</Link> : null}
      </nav>
    </div>
  );
}
