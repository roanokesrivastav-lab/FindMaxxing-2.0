"use client";
import { cn } from "@/lib/utils/cn";
import type { ReactNode } from "react";

export function Chip({
  active,
  onClick,
  children,
  className,
  color,
  type = "button",
}: {
  active?: boolean;
  onClick?: () => void;
  children: ReactNode;
  className?: string;
  /** Optional accent color used when active. */
  color?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      data-active={active ? "true" : "false"}
      className={cn("chip", className)}
      style={active && color ? { background: color, borderColor: color, color: "white" } : undefined}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

export function ChipRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex gap-2 overflow-x-auto scrollbar-none px-4 -mx-4 snap-x", className)}>
      {children}
      <span className="shrink-0 w-2" aria-hidden />
    </div>
  );
}
