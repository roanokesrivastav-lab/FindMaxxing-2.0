"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { BROWSE_ITEMS, NAV_ITEMS } from "./nav-items";
import { Logo } from "./Logo";
import { Avatar } from "@/components/ui/Avatar";
import { CreateMenu } from "./CreateMenu";
import { useState } from "react";
import type { ShellViewer } from "./AppShell";
import type { DataMode } from "@/lib/config";

export function SideRail({ viewer, dataMode }: { viewer: ShellViewer | null; dataMode: DataMode }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  return (
    <aside className="hidden md:flex md:w-64 lg:w-72 shrink-0 sticky top-0 h-dvh flex-col border-r border-line bg-surface px-4 py-5">
      <Link href="/" className="px-2">
        <Logo size={30} />
      </Link>
      <nav className="mt-8 flex flex-col gap-1" aria-label="Primary">
        {NAV_ITEMS.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-2xl px-3 h-12 font-semibold transition-colors",
                active ? "bg-ink text-white" : "text-ink-2 hover:bg-surface-2",
              )}
            >
              <Icon size={20} strokeWidth={active ? 2.4 : 2} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <nav className="mt-5 flex flex-col gap-0.5" aria-label="Browse">
        <p className="px-3 mb-1 text-[11px] font-bold uppercase tracking-[0.12em] text-muted">Browse</p>
        {BROWSE_ITEMS.map((item) => {
          const active = item.match(pathname);
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 h-10 text-sm font-semibold transition-colors",
                active ? "bg-surface-2 text-ink" : "text-ink-2 hover:bg-surface-2",
              )}
            >
              <Icon size={17} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-6 h-12 rounded-2xl bg-flare text-white font-semibold inline-flex items-center justify-center gap-2 hover:bg-flare-600 transition-colors"
      >
        <Plus size={20} strokeWidth={2.5} />
        Add something
      </button>
      <div className="mt-auto flex flex-col gap-3">
        {dataMode === "demo" ? (
          <div className="rounded-2xl bg-pulse-50 border border-pulse-100 px-3 py-2.5 text-xs text-ink-2 flex gap-2">
            <Sparkles size={16} className="text-pulse shrink-0 mt-0.5" />
            <span>
              <b className="text-ink">Demo mode.</b> Local data, no Supabase keys. Add keys to <code>.env.local</code> to go live.
            </span>
          </div>
        ) : null}
        {viewer ? (
          <Link href="/profile" className="flex items-center gap-3 rounded-2xl px-2 py-2 hover:bg-surface-2">
            <Avatar name={viewer.displayName} src={viewer.avatarUrl} size={36} />
            <span className="min-w-0">
              <span className="block text-sm font-semibold truncate">{viewer.displayName}</span>
              <span className="block text-xs text-muted truncate">@{viewer.username}</span>
            </span>
          </Link>
        ) : (
          <Link href="/auth/sign-in" className="h-11 rounded-2xl border border-line font-semibold inline-flex items-center justify-center hover:bg-surface-2">
            Sign in
          </Link>
        )}
      </div>
      <CreateMenu open={open} onClose={() => setOpen(false)} signedIn={!!viewer} />
    </aside>
  );
}
