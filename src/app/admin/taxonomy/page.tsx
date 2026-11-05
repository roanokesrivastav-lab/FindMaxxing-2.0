import type { Metadata } from "next";
import { PageHeader } from "@/components/ui/PageHeader";
import { ConfirmWithReason } from "@/components/admin/ConfirmWithReason";
import { TaxonomyForm } from "@/components/admin/TaxonomyForm";
import { requireAdmin } from "../guard";

export const metadata: Metadata = { title: "Categories and interests · Admin" };
export const dynamic = "force-dynamic";

export default async function AdminTaxonomyPage() {
  const { viewer, repo } = await requireAdmin("/admin/taxonomy");
  const entries = await repo.admin.taxonomy(viewer.id);
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Admin" title="Categories and interests" subtitle="Edits are recorded. Retiring hides one from new choices; what already uses it keeps it." />
      <p className="card p-4 text-sm text-ink-2 mb-5">
        The database holds the live vocabulary and checks every place, event and profile against it. The app&apos;s pickers and labels come from <code>src/lib/data/taxonomy.ts</code> at build time: run <code>npx tsx scripts/pull-taxonomy.ts</code> and deploy to bring a new or renamed entry into the app.
      </p>
      {(["category", "interest"] as const).map((kind) => (
        <section key={kind} className="mb-8" aria-labelledby={`${kind}-heading`}>
          <h2 id={`${kind}-heading`} className="text-lg font-bold mb-3">{kind === "category" ? "Categories" : "Interests"}</h2>
          <ul className="flex flex-col gap-2 list-none p-0 m-0">
            {entries.filter((e) => e.kind === kind).map((e) => (
              <li key={e.slug} className="card p-4">
                <details>
                  <summary className="cursor-pointer flex items-center justify-between gap-3">
                    <span className={e.retired ? "text-muted line-through" : ""}><span aria-hidden>{e.emoji}</span> <b>{e.label}</b> <span className="text-xs text-muted">{e.slug}{e.scope ? ` · ${e.scope}` : ""}</span></span>
                    {e.retired ? <span className="text-xs font-bold text-muted">Retired</span> : null}
                  </summary>
                  <div className="mt-3 flex flex-col gap-3">
                    <TaxonomyForm entry={e} kind={kind} />
                    {e.retired ? (
                      <ConfirmWithReason label="Bring back" title={`Bring back “${e.label}”?`} body="It shows up as a choice again." confirm="Bring back" done="Brought back" input={{ kind: "retire", taxonomy: kind, slug: e.slug, on: false }} />
                    ) : (
                      <ConfirmWithReason danger label="Retire" title={`Retire “${e.label}”?`} body="It stops being offered for new places, events and profiles. Everything already using it keeps it, and you can bring it back." confirm="Retire" done="Retired" input={{ kind: "retire", taxonomy: kind, slug: e.slug, on: true }} />
                    )}
                  </div>
                </details>
              </li>
            ))}
          </ul>
          <details className="card p-4 mt-3">
            <summary className="cursor-pointer font-semibold">Add {kind === "category" ? "a category" : "an interest"}</summary>
            <div className="mt-3"><TaxonomyForm kind={kind} /></div>
          </details>
        </section>
      ))}
    </div>
  );
}
