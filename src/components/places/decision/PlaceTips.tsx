import { Lightbulb } from "lucide-react";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { Surface } from "@/components/ui/Surface";
import { LocalDate } from "@/components/time/LocalDate";
import { TIP_KIND_LABEL, timeAgo, type PlaceTip, type TipEvidence } from "@/lib/places/tips";
import { Evidence } from "./Evidence";
import { AddTipForm, TipActions } from "./TipActions";

const DATE: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" };
const who = (p: { displayName: string } | null) => p?.displayName ?? "a former member";

/** "Confirmed by Maya, 2 weeks ago", or "Not confirmed yet". */
export function confirmedLine(tip: PlaceTip, now: number): string {
  return tip.lastConfirmedAt ? `Confirmed by ${who(tip.lastConfirmedBy)}, ${timeAgo(tip.lastConfirmedAt, now)}` : "Not confirmed yet";
}

/** What a tip's claim is based on: who wrote it and when, every confirmation, every correction. */
function TipEvidenceBody({ evidence }: { evidence: TipEvidence }) {
  const { tip, confirmations, corrections } = evidence;
  return (
    <div className="flex flex-col gap-item" data-tip-evidence={tip.id}>
      <p>
        Written by {who(tip.author)} on <LocalDate value={tip.createdAt} format={DATE} />
        {tip.updatedAt !== tip.createdAt ? (
          <>
            , edited <LocalDate value={tip.updatedAt} format={DATE} /> (an edit is not a confirmation)
          </>
        ) : null}
        .{tip.expiresAt ? (
          <>
            {" "}Ends <LocalDate value={tip.expiresAt} format={DATE} />.
          </>
        ) : null}
      </p>
      {confirmations.length ? (
        <ul className="list-none m-0 p-0">
          {confirmations.map((c, i) => (
            <li key={`${c.createdAt}-${i}`}>
              Still true, said {who(c.user)} on <LocalDate value={c.createdAt} format={DATE} />
            </li>
          ))}
        </ul>
      ) : (
        <p>Nobody else has confirmed it yet.</p>
      )}
      {corrections.length ? (
        <div>
          <p className="font-semibold text-ink">Suggested corrections</p>
          <ul className="list-none m-0 p-0">
            {corrections.map((c) => (
              <li key={c.id} className="break-words">
                &ldquo;{c.body}&rdquo; ({who(c.author)}, <LocalDate value={c.createdAt} format={DATE} />)
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

/** Slot 4 of the place page: the most relevant recent observation, with its date. */
export function RecentObservation({ evidence, now }: { evidence: TipEvidence; now: number }) {
  const { tip } = evidence;
  return (
    <section aria-labelledby="observation" data-block="observation">
      <SectionHeader title="Recent observation" id="observation" />
      <p className="type-body text-ink break-words">{tip.body}</p>
      <Evidence claim={<span className="type-body text-ink-2">{confirmedLine(tip, now)} (<LocalDate value={tip.lastConfirmedAt!} format={DATE} />)</span>}>
        <TipEvidenceBody evidence={evidence} />
      </Evidence>
    </section>
  );
}

/**
 * Slot 8: local tips with provenance (2.6). Each tip names its kind and author, says
 * who last confirmed it and when (opening the evidence), and offers "Still true?" and
 * "Suggest a correction". With no tips, a legacy creator tip is shown as such.
 */
export function PlaceTips({
  placeId,
  tips,
  viewerId,
  now,
  legacyTip,
}: {
  placeId: string;
  tips: TipEvidence[];
  viewerId: string | null;
  now: number;
  legacyTip: string | null;
}) {
  return (
    <section aria-labelledby="tips" data-block="tip">
      <SectionHeader title="Local tips" id="tips" />
      {tips.length ? (
        <ul className="list-none m-0 p-0 flex flex-col gap-item">
          {tips.map((e) => (
            <li key={e.tip.id}>
              <Surface variant="inset" className="p-row flex flex-col gap-item" data-tip={e.tip.id}>
                <div className="flex gap-item">
                  <Lightbulb className="text-sun shrink-0 mt-hair" size={20} aria-hidden />
                  <div className="min-w-0 flex-1">
                    <p className="type-body text-ink-2">
                      {TIP_KIND_LABEL[e.tip.kind]} · by {who(e.tip.author)}
                    </p>
                    <p className="type-body text-ink break-words">{e.tip.body}</p>
                  </div>
                </div>
                <Evidence claim={<span className="type-body text-ink">{confirmedLine(e.tip, now)}</span>}>
                  <TipEvidenceBody evidence={e} />
                </Evidence>
                <TipActions placeId={placeId} tipId={e.tip.id} signedIn={!!viewerId} isAuthor={!!viewerId && e.tip.author?.id === viewerId} />
              </Surface>
            </li>
          ))}
        </ul>
      ) : legacyTip ? (
        <Surface variant="inset" className="p-row flex gap-item">
          <Lightbulb className="text-sun shrink-0 mt-hair" size={20} aria-hidden />
          <div className="min-w-0">
            <p className="type-body text-ink-2">From the person who added this place, not yet confirmed</p>
            <p className="type-body text-ink break-words">{legacyTip}</p>
          </div>
        </Surface>
      ) : (
        <p className="type-body text-ink-2">No local tips yet.</p>
      )}
      <AddTipForm placeId={placeId} signedIn={!!viewerId} />
    </section>
  );
}
