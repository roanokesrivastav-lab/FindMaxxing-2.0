import type { Metadata } from "next";
import Link from "next/link";
import { BarChart3, FileText, Megaphone, ShieldCheck, Tags, Users } from "lucide-react";
import { featureEnabled } from "@/lib/config";
import { PageHeader } from "@/components/ui/PageHeader";
import { requireAdmin } from "./guard";

export const metadata: Metadata = { title: "Admin" };
export const dynamic = "force-dynamic";

const SECTIONS = [
  { href: "/admin/users", label: "People", body: "Search accounts, suspend or lift a suspension, grant or revoke moderators.", icon: Users },
  { href: "/admin/content", label: "Content", body: "Browse places and events in any status, with their reports and moderation history.", icon: FileText },
  { href: "/moderation", label: "Report queue", body: "Open reports, grouped by what they are about.", icon: ShieldCheck },
  { href: "/admin/metrics", label: "Metrics", body: "The core loop, weekly contributors, the save split, and rate-limit hits.", icon: BarChart3 },
  { href: "/admin/taxonomy", label: "Categories and interests", body: "Rename, reorder, add, or retire them.", icon: Tags },
  { href: "/admin/ads", label: "Sponsored cards", body: "Review campaigns before they can be paid for and run.", icon: Megaphone, flag: "ads" as const },
];

export default async function AdminHome() {
  await requireAdmin("/admin");
  return (
    <div className="max-w-2xl mx-auto px-4 md:px-6 pt-4 md:pt-8 pb-nav md:pb-10">
      <PageHeader eyebrow="Admin" title="Dashboard" subtitle="Every change here is recorded with your name and the reason." />
      <ul className="grid gap-3 list-none p-0 m-0">
        {SECTIONS.filter((s) => !("flag" in s) || !s.flag || featureEnabled(s.flag)).map(({ href, label, body, icon: Icon }) => (
          <li key={href}>
            <Link href={href} className="card p-4 flex gap-3 hover:border-ink transition-colors">
              <Icon size={20} className="shrink-0 mt-0.5" aria-hidden />
              <span><span className="font-bold block">{label}</span><span className="text-sm text-muted">{body}</span></span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
