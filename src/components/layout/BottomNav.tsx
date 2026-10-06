"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils/cn";
import { NAV_ITEMS } from "./nav-items";
import { CreateMenu } from "./CreateMenu";
import { useState } from "react";
import type { ShellViewer } from "./AppShell";

/** `badge`: unread messages and notifications, shown on the Profile tab (where both are reached on a phone). */
export function BottomNav({ viewer, badge = 0 }: { viewer: ShellViewer | null; badge?: number }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // Hide on full-screen forms/auth to give them room.
  const hidden = /^\/(places\/new|events\/new|profile\/edit|auth)/.test(pathname);
  if (hidden) return null;

  const items = NAV_ITEMS.filter((i) => i.href !== "/people");
  const left = items.slice(0, 2);
  const right = items.slice(2);

  return (
    <>
      <nav
        className="md:hidden fixed inset-x-0 bottom-0 z-[60] bg-surface/95 backdrop-blur border-t border-line safe-bottom"
        style={{ height: "calc(var(--nav-height) + var(--safe-bottom))" }}
        aria-label="Primary"
      >
        <div className="grid grid-cols-5 h-[var(--nav-height)] items-stretch">
          {left.map((item) => (
            <NavLink key={item.href} item={item} active={item.match(pathname)} />
          ))}
          <div className="flex items-center justify-center">
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="-mt-7 h-14 w-14 rounded-full bg-flare text-white shadow-[0_10px_24px_-8px_rgba(255,77,46,0.8)] inline-flex items-center justify-center active:scale-95 transition-transform"
              aria-label="Add place or event"
            >
              <Plus size={26} strokeWidth={2.5} />
            </button>
          </div>
          {right.map((item) => (
            <NavLink key={item.href} item={item} active={item.match(pathname)} badge={item.href === "/profile" ? badge : 0} />
          ))}
        </div>
      </nav>
      <CreateMenu open={open} onClose={() => setOpen(false)} signedIn={!!viewer} />
    </>
  );
}

function NavLink({ item, active, badge = 0 }: { item: (typeof NAV_ITEMS)[number]; active: boolean; badge?: number }) {
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      className={cn("flex flex-col items-center justify-center gap-1 text-[11px] font-semibold transition-colors", active ? "text-ink" : "text-muted")}
      aria-current={active ? "page" : undefined}
    >
      <span className={cn("relative h-7 w-12 rounded-full inline-flex items-center justify-center transition-colors", active && "bg-flare-100 text-flare-ink")}>
        <Icon size={21} strokeWidth={active ? 2.4 : 2} />
        {badge ? (
          <span className="absolute -top-1 right-1 min-w-4 h-4 px-1 rounded-full bg-flare-ink text-white text-[10px] font-bold leading-4 text-center">
            {badge > 99 ? "99+" : badge}<span className="sr-only"> unread</span>
          </span>
        ) : null}
      </span>
      {item.label}
    </Link>
  );
}
