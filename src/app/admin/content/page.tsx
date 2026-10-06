import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/ui/PageHeader";
import { DataError } from "@/lib/data/types";
import { ADMIN_DATE, requireAdmin } from "../guard";

export const metadata: Metadata = { title: "Content · Admin" };
export const dynamic = "force-dynamic";

const STATUSES = { place: ["published", "hidden", "pending", "removed"], event: ["published", "cancelled", "hidden", "removed"] } as const;

export default async function AdminContentPage({ searchParams }: { searchParams: Promise<{ kind?: string; status?: string; q?: string; creator?: string; cursor?: string }> }) {
  const { viewer, repo } = await requireAdmin("/admin/content");
  const sp = await searchParams;
  const kind = sp.kind === "event" ? "event" : "place";
  const status = (STATUSES[kind] as readonly string[]).includes(sp.status ?? "") ? sp.status! : null;
  const opts = { kind, status, query: sp.q ?? null, creatorId: sp.creator ?? null } as const;
  const page = await repo.admin.content(viewer.id, { ...opts, cursor: sp.cursor ?? null }).catch((err) => {
    if (err instanceof DataError && err.code === "invalid") return repo.admin.content(viewer.id, opts);
    throw err;
  });
  const query = (extra: Record<string, string>) => new URLSearchParams({ kind, ...(status ? { status } : {}), ...(sp.q ? { q: sp.q } : {}), ...(sp.creator ? { creator: sp.creator } : {}), ...extra }).toString();
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Admin" title="Content" subtitle="Every place and event, any status, newest first." />
      <form className="flex flex-wrap gap-2 mb-4" role="search">
        <label className="sr-only" htmlFor="kind">Kind</label>
        <select id="kind" name="kind" defaultValue={kind} className="field w-auto"><option value="place">Places</option><option value="event">Events</option></select>
        <label className="sr-only" htmlFor="status">Status</label>
        <select id="status" name="status" defaultValue={status ?? ""} className="field w-auto">
          <option value="">Any status</option>
          {STATUSES[kind].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <label className="sr-only" htmlFor="content-q">Name</label>
        <input id="content-q" name="q" defaultValue={sp.q ?? ""} placeholder="Name" className="field flex-1 min-w-[8rem]" />
        {sp.creator ? <input type="hidden" name="creator" value={sp.creator} /> : null}
        <button type="submit" className="chip">Filter</button>
      </form>
      <ul className="flex flex-col gap-2 list-none p-0 m-0">
        {page.items.map((c) => (
          <li key={c.id} className="card p-4">
            <div className="flex items-start justify-between gap-3">
              <Link href={`/moderation/${c.kind}/${c.id}`} className="font-bold hover:underline break-words">{c.label}</Link>
              <span className="text-xs font-bold uppercase tracking-wide text-muted shrink-0">{c.status}</span>
            </div>
            <p className="text-xs text-muted mt-1">
              {c.creatorUsername ? <Link href={`/admin/users/${c.creatorId}`} className="hover:text-ink">@{c.creatorUsername}</Link> : "deleted account"}
              {c.city ? ` · ${c.city}` : ""}{c.visibility && c.visibility !== "public" ? ` · ${c.visibility}` : ""} · {ADMIN_DATE.format(new Date(c.createdAt))} · {c.openReports} open reports · {c.actions} moderation actions
            </p>
          </li>
        ))}
      </ul>
      {!page.items.length ? <p className="text-sm text-muted">Nothing matches.</p> : null}
      <nav className="mt-6 flex justify-between" aria-label="Pages">
        {sp.cursor ? <Link href={`/admin/content?${query({})}`} className="chip">First page</Link> : <span />}
        {page.nextCursor ? <Link href={`/admin/content?${query({ cursor: page.nextCursor })}`} className="chip">Next page</Link> : null}
      </nav>
    </div>
  );
}
