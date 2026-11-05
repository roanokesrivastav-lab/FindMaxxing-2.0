import type { ReactNode } from "react";
import type { Viewer } from "@/lib/auth/server";
import type { DataMode } from "@/lib/config";
import { BottomNav } from "./BottomNav";
import { SideRail } from "./SideRail";

export interface ShellViewer {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Entries behind feature flags: the trip planner, and messages and notifications with unread counts (null when off). */
export interface ShellExtras {
  plan: boolean;
  unread: number | null;
  notifications?: number | null;
}

export function AppShell({ viewer, dataMode, extras = { plan: false, unread: null }, children }: { viewer: Viewer | null; dataMode: DataMode; extras?: ShellExtras; children: ReactNode }) {
  const shellViewer: ShellViewer | null = viewer
    ? {
        id: viewer.id,
        username: viewer.profile.username,
        displayName: viewer.profile.displayName,
        avatarUrl: viewer.profile.avatarUrl,
      }
    : null;
  return (
    <div className="flex min-h-dvh">
      <SideRail viewer={shellViewer} dataMode={dataMode} extras={extras} />
      <div className="flex-1 min-w-0 flex flex-col">
        <main className="flex-1 min-w-0">{children}</main>
      </div>
      <BottomNav viewer={shellViewer} badge={(extras.unread ?? 0) + (extras.notifications ?? 0)} />
    </div>
  );
}
