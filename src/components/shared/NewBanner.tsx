import { PartyPopper } from "lucide-react";
import Link from "next/link";

export function NewBanner({ kind }: { kind: "place" | "event" }) {
  return (
    <div className="rounded-2xl bg-moss-100 border border-moss/30 px-4 py-3 text-sm flex items-center gap-3 animate-rise">
      <PartyPopper size={18} className="text-moss shrink-0" />
      <span className="flex-1">
        <b>{kind === "place" ? "Place added." : "Event created."}</b>{" "}
        {kind === "place" ? "It's live on the map. Thanks for the local knowledge." : "It's on the map. Share the link so people show up."}
      </span>
      <Link href="/" className="font-semibold text-moss shrink-0">
        View map
      </Link>
    </div>
  );
}
