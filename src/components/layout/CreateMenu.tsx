"use client";
import Link from "next/link";
import { CalendarPlus, MapPinPlus, ChevronRight } from "lucide-react";
import { Sheet } from "@/components/ui/Sheet";

export function CreateMenu({ open, onClose, signedIn }: { open: boolean; onClose: () => void; signedIn: boolean }) {
  const withAuth = (href: string) => (signedIn ? href : `/auth/sign-in?next=${encodeURIComponent(href)}`);
  return (
    <Sheet open={open} onClose={onClose} title="Add to the map">
      <p className="text-sm text-muted -mt-1 mb-4">Share what you know. Every contribution helps someone new find their people.</p>
      <div className="flex flex-col gap-3">
        <Link href={withAuth("/places/new")} onClick={onClose} className="card flex items-center gap-4 p-4 hover:bg-surface-2 transition-colors">
          <span className="h-12 w-12 rounded-2xl bg-flare-100 text-flare-600 inline-flex items-center justify-center">
            <MapPinPlus size={24} />
          </span>
          <span className="flex-1">
            <span className="block font-bold">Add a place</span>
            <span className="block text-sm text-muted">A court, a trail, a bar that shows the game…</span>
          </span>
          <ChevronRight size={18} className="text-muted" />
        </Link>
        <Link href={withAuth("/events/new")} onClick={onClose} className="card flex items-center gap-4 p-4 hover:bg-surface-2 transition-colors">
          <span className="h-12 w-12 rounded-2xl bg-pulse-100 text-pulse inline-flex items-center justify-center">
            <CalendarPlus size={24} />
          </span>
          <span className="flex-1">
            <span className="block font-bold">Create an event</span>
            <span className="block text-sm text-muted">Pickup game, watch party, study block, hike…</span>
          </span>
          <ChevronRight size={18} className="text-muted" />
        </Link>
      </div>
      {!signedIn ? <p className="mt-4 text-xs text-muted text-center">You&apos;ll be asked to sign in first.</p> : null}
    </Sheet>
  );
}
