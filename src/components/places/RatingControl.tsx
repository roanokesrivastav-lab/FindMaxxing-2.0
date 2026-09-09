"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { StarPicker, StarRating } from "@/components/ui/Stars";
import { ratePlaceAction, removeRatingAction } from "@/server/actions/places";
import { useToast } from "@/components/ui/Toast";
import { formatRating, pluralize } from "@/lib/utils/format";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Field";

const NOTE_MAX = 280;

export function RatingControl({
  placeId,
  ratingAvg,
  ratingCount,
  viewerRating,
  viewerRatingNote,
  signedIn,
}: {
  placeId: string;
  ratingAvg: number;
  ratingCount: number;
  viewerRating: number | null;
  viewerRatingNote: string | null;
  signedIn: boolean;
}) {
  const [agg, setAgg] = useState({ ratingAvg, ratingCount });
  const [mine, setMine] = useState<number | null>(viewerRating);
  const [savedNote, setSavedNote] = useState<string | null>(viewerRatingNote);
  const [note, setNote] = useState(viewerRatingNote ?? "");
  const [noteOpen, setNoteOpen] = useState(false);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();

  const requireAuth = () => {
    if (signedIn) return true;
    router.push(`/auth/sign-in?next=${encodeURIComponent(`/places/${placeId}`)}`);
    return false;
  };

  const submit = (score: number, noteValue: string | null, message: string) => {
    const prevScore = mine;
    const prevNote = savedNote;
    setMine(score);
    start(async () => {
      const res = await ratePlaceAction({ placeId, score, note: noteValue });
      if (!res.ok) {
        setMine(prevScore);
        setSavedNote(prevNote);
        toast(res.error, "error");
        return;
      }
      setAgg({ ratingAvg: res.data.ratingAvg, ratingCount: res.data.ratingCount });
      setSavedNote(noteValue);
      setNoteOpen(false);
      toast(message, "success");
      router.refresh();
    });
  };

  const rate = (score: number) => {
    if (!requireAuth()) return;
    submit(score, savedNote, mine ? "Rating updated" : "Thanks for rating!");
  };

  const saveNote = () => {
    if (!requireAuth() || !mine) return;
    const trimmed = note.trim();
    submit(mine, trimmed.length ? trimmed : null, trimmed.length ? "Note saved" : "Note removed");
  };

  const remove = () => {
    if (!signedIn || !mine) return;
    const prevScore = mine;
    const prevNote = savedNote;
    setMine(null);
    setSavedNote(null);
    setNote("");
    start(async () => {
      const res = await removeRatingAction(placeId);
      if (!res.ok) {
        setMine(prevScore);
        setSavedNote(prevNote);
        toast(res.error, "error");
        return;
      }
      setAgg(res.data);
      setNoteOpen(false);
      toast("Rating removed", "success");
      router.refresh();
    });
  };

  return (
    <div className="card p-4">
      <div className="flex items-center gap-4">
        <div className="text-center shrink-0 w-16">
          <div className="font-display text-4xl font-extrabold leading-none">{formatRating(agg.ratingAvg)}</div>
          <StarRating value={agg.ratingAvg} size={11} className="mt-1.5" />
          <div className="text-[11px] text-muted mt-1">{pluralize(agg.ratingCount, "rating")}</div>
        </div>
        <div className="h-12 w-px bg-line" aria-hidden />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold">{mine ? "Your rating" : "Rate this place"}</p>
          <StarPicker value={mine} onChange={rate} disabled={pending} size={30} />
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            <p className="text-xs text-muted">{mine ? "Tap to change" : "One rating per person. You can update it anytime."}</p>
            {mine ? (
              <button type="button" onClick={remove} disabled={pending} className="text-xs font-semibold text-muted hover:text-danger">
                Remove
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {mine ? (
        <div className="mt-3 pt-3 border-t border-line">
          {savedNote && !noteOpen ? (
            <div className="flex items-start gap-3">
              <p className="flex-1 text-sm text-ink-2 italic">&ldquo;{savedNote}&rdquo;</p>
              <button
                type="button"
                onClick={() => {
                  setNote(savedNote);
                  setNoteOpen(true);
                }}
                className="text-xs font-semibold text-flare-600 shrink-0"
              >
                Edit note
              </button>
            </div>
          ) : noteOpen ? (
            <div className="flex flex-col gap-2">
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
                rows={3}
                maxLength={NOTE_MAX}
                placeholder="What should someone know before they go? The tip you'd text a friend."
                aria-label="Your note about this place"
              />
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted mr-auto">
                  {note.length}/{NOTE_MAX}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setNote(savedNote ?? "");
                    setNoteOpen(false);
                  }}
                >
                  Cancel
                </Button>
                <Button type="button" size="sm" variant="ink" loading={pending} onClick={saveNote}>
                  Save note
                </Button>
              </div>
            </div>
          ) : (
            <button type="button" onClick={() => setNoteOpen(true)} className="text-sm font-semibold text-flare-600">
              + Add a note
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
