import Link from "next/link";
import { SectionHeader } from "@/components/ui/SectionHeader";
import { OCCASIONS_SHOWN, occasionSentence, orderOccasionNotes, type OccasionNote, type Polarity } from "@/lib/places/occasions";
import { AddOccasionForm, RemoveOccasionButton } from "./OccasionActions";

function NoteItem({ n, viewerId, placeId }: { n: OccasionNote; viewerId: string | null; placeId: string }) {
  return (
    <li className="surface-flat py-item" data-occasion-note={n.id}>
      <p className="type-body text-ink font-semibold">{occasionSentence(n)}</p>
      {n.note ? <p className="type-body text-ink break-words">&ldquo;{n.note}&rdquo;</p> : null}
      <p className="type-body text-ink-2">
        {n.author ? (
          <Link href={`/u/${n.author.username}`} className="underline-offset-4 hover:underline">
            {n.author.displayName}
          </Link>
        ) : (
          "A former member"
        )}
        {viewerId && n.author?.id === viewerId ? <RemoveOccasionButton placeId={placeId} noteId={n.id} /> : null}
      </p>
    </li>
  );
}

function Side({ title, polarity, notes, viewerId, placeId }: { title: string; polarity: Polarity; notes: OccasionNote[]; viewerId: string | null; placeId: string }) {
  const shown = notes.slice(0, OCCASIONS_SHOWN);
  const rest = notes.slice(OCCASIONS_SHOWN);
  return (
    <div data-occasion-side={polarity}>
      <h3 className="type-body font-semibold text-ink-2">{title}</h3>
      {notes.length ? (
        <>
          <ul className="list-none m-0 p-0">
            {shown.map((n) => (
              <NoteItem key={n.id} n={n} viewerId={viewerId} placeId={placeId} />
            ))}
          </ul>
          {rest.length ? (
            <details data-see-all="">
              <summary className="type-body font-semibold cursor-pointer">See all {notes.length}</summary>
              <ul className="list-none m-0 p-0">
                {rest.map((n) => (
                  <NoteItem key={n.id} n={n} viewerId={viewerId} placeId={placeId} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : (
        <p className="type-body text-ink-2">No notes yet.</p>
      )}
    </div>
  );
}

/**
 * Slot 7 of the place page (2.7): individual, attributed occasion notes from
 * contributors, best for and less suited kept apart. People the viewer follows come
 * first, each as their own note; nothing is summarized or generated.
 */
export function PlaceOccasions({ placeId, notes, followingIds, viewerId }: { placeId: string; notes: OccasionNote[]; followingIds: string[]; viewerId: string | null }) {
  const ordered = orderOccasionNotes(notes, followingIds);
  return (
    <section aria-labelledby="occasions" data-block="occasions">
      <SectionHeader title="Best for / less suited" id="occasions" />
      <div className="flex flex-col gap-row">
        <Side title="Best for" polarity="best" notes={ordered.filter((n) => n.polarity === "best")} viewerId={viewerId} placeId={placeId} />
        <Side title="Less suited for" polarity="less" notes={ordered.filter((n) => n.polarity === "less")} viewerId={viewerId} placeId={placeId} />
      </div>
      <AddOccasionForm placeId={placeId} signedIn={!!viewerId} />
    </section>
  );
}
