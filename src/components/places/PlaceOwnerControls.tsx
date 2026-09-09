"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Globe, Lock, ShieldCheck } from "lucide-react";
import { setPlaceStatusAction, setPlaceVisibilityAction } from "@/server/actions/places";
import { useToast } from "@/components/ui/Toast";
import type { PlaceStatus, Visibility } from "@/lib/data/types";
import { cn } from "@/lib/utils/cn";

const TIERS: { value: Visibility; label: string; hint: string; icon: typeof Globe }[] = [
  { value: "public", label: "Everyone", hint: "Anyone browsing the map", icon: Globe },
  { value: "locals", label: "Locals only", hint: "People who live or contribute here", icon: ShieldCheck },
  { value: "private", label: "Just me", hint: "Hidden from everyone else", icon: Lock },
];

/**
 * Owner-only panel on a place page: who can see it, and whether it's listed.
 * Both settings are re-checked server-side; this is only the control surface.
 */
export function PlaceOwnerControls({
  placeId,
  status,
  visibility,
}: {
  placeId: string;
  status: PlaceStatus;
  visibility: Visibility;
}) {
  const [currentStatus, setCurrentStatus] = useState<PlaceStatus>(status);
  const [currentTier, setCurrentTier] = useState<Visibility>(visibility);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const hidden = currentStatus === "hidden";

  const toggleListed = () => {
    const next: PlaceStatus = hidden ? "published" : "hidden";
    const prev = currentStatus;
    setCurrentStatus(next);
    start(async () => {
      const res = await setPlaceStatusAction(placeId, next);
      if (!res.ok) {
        setCurrentStatus(prev);
        toast(res.error, "error");
        return;
      }
      toast(next === "hidden" ? "Hidden from the map" : "Back on the map", "success");
      router.refresh();
    });
  };

  const setTier = (tier: Visibility) => {
    if (tier === currentTier) return;
    const prev = currentTier;
    setCurrentTier(tier);
    start(async () => {
      const res = await setPlaceVisibilityAction(placeId, tier);
      if (!res.ok) {
        setCurrentTier(prev);
        toast(res.error, "error");
        return;
      }
      toast(tier === "locals" ? "Now visible to locals only" : tier === "private" ? "Now visible only to you" : "Now visible to everyone", "success");
      router.refresh();
    });
  };

  return (
    <section className="mt-6">
      <h2 className="text-lg font-bold mb-2">You added this</h2>
      <div className="card p-4 flex flex-col gap-4">
        <div>
          <p className="text-sm font-semibold mb-2">Who can see it</p>
          <div className="grid grid-cols-3 gap-2">
            {TIERS.map((t) => {
              const Icon = t.icon;
              const active = currentTier === t.value;
              return (
                <button
                  key={t.value}
                  type="button"
                  onClick={() => setTier(t.value)}
                  disabled={pending}
                  aria-pressed={active}
                  className={cn(
                    "rounded-xl border px-2 py-3 flex flex-col items-center gap-1 text-center transition-colors disabled:opacity-60",
                    active ? "bg-ink text-white border-ink" : "bg-surface border-line hover:bg-surface-2",
                  )}
                >
                  <Icon size={17} />
                  <span className="text-xs font-semibold leading-tight">{t.label}</span>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted mt-2">{TIERS.find((t) => t.value === currentTier)?.hint}</p>
        </div>

        <div className="flex items-center gap-3 pt-3 border-t border-line">
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold">{hidden ? "Hidden from discovery" : "Listed on the map"}</p>
            <p className="text-xs text-muted">
              {hidden ? "Only you can reach it, by link." : "Hide it if it's closed or you need a moment to fix the details."}
            </p>
          </div>
          <button
            type="button"
            onClick={toggleListed}
            disabled={pending}
            className={cn(
              "h-10 px-4 rounded-full font-semibold text-sm inline-flex items-center gap-2 border shrink-0 transition-colors disabled:opacity-60",
              hidden ? "bg-ink text-white border-ink" : "bg-surface border-line hover:bg-surface-2",
            )}
          >
            {hidden ? <Eye size={16} /> : <EyeOff size={16} />}
            {hidden ? "Publish" : "Hide"}
          </button>
        </div>
      </div>
    </section>
  );
}
