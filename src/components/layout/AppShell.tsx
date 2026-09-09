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

export function AppShell({ viewer, dataMode, children }: { viewer: Viewer | null; dataMode: DataMode; children: ReactNode }) {
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
      <SideRail viewer={shellViewer} dataMode={dataMode} />
      <div className="flex-1 min-w-0 flex flex-col">
        <main className="flex-1 min-w-0">{children}</main>
      </div>
      <BottomNav viewer={shellViewer} />
    </div>
  );
}
