"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Row } from "@/components/ui/Row";
import { Surface } from "@/components/ui/Surface";
import { StatusLabel } from "@/components/ui/StatusLabel";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Field";
import { useToast } from "@/components/ui/Toast";
import { bulkSavesAction, undoBulkSavesAction } from "@/server/actions/saves";
import { getCategory } from "@/lib/data/taxonomy";
import { formatRating, pluralize } from "@/lib/utils/format";
import { photoSrc } from "@/lib/images/sizes";
import type { BulkOp, LibraryItem, SaveSnapshot } from "@/lib/places/library";
import { SAVE_STATUS_LABEL } from "@/lib/places/saves";
import { OnlyYou } from "./SaveDetailsForm";

type Action = "addTag" | "removeTag" | "visited" | "want_to_go" | "moveToList" | "remove";

/**
 * Library rows with multi-select, bulk edit and undo (3.2). Each row keeps what the
 * place is (photo or glyph, name, category, neighborhood, rating) apart from why you
 * saved it (status, tags, note), which only the owner ever sees.
 */
export function LibraryClient({ items, lists }: { items: LibraryItem[]; lists: { id: string; name: string }[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<Action>("visited");
  const [tag, setTag] = useState("");
  const [listId, setListId] = useState(lists[0]?.id ?? "");
  const [undo, setUndo] = useState<{ summary: string; snapshots: SaveSnapshot[] } | null>(null);
  const [pending, start] = useTransition();
  const router = useRouter();
  const { toast } = useToast();
  const id = useId();

  const toggle = (placeId: string) => {
    const next = new Set(selected);
    if (next.has(placeId)) next.delete(placeId);
    else next.add(placeId);
    setSelected(next);
  };
  const allOnPage = items.length > 0 && items.every((i) => selected.has(i.place.id));
  const opFor = (): BulkOp | null => {
    switch (action) {
      case "addTag":
      case "removeTag":
        return tag.trim() ? { kind: action, tag } : null;
      case "visited":
      case "want_to_go":
        return { kind: "status", status: action };
      case "moveToList":
        return listId ? { kind: "moveToList", listId } : null;
      case "remove":
        return { kind: "remove" };
    }
  };
  const apply = () => {
    const op = opFor();
    if (!op) return toast(action === "moveToList" ? "Make a list first" : "Type a tag first", "error");
    start(async () => {
      const res = await bulkSavesAction([...selected], op);
      if (!res.ok) return toast(res.error, "error");
      setUndo({ summary: res.data.summary, snapshots: res.data.snapshots });
      setSelected(new Set());
      setTag("");
      router.refresh();
    });
  };
  const doUndo = () => {
    if (!undo) return;
    start(async () => {
      const res = await undoBulkSavesAction(undo.snapshots);
      if (!res.ok) return toast(res.error, "error");
      setUndo(null);
      toast("Undone", "success");
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col gap-item" data-library="">
      <div className="flex flex-wrap items-center justify-between gap-item">
        <label className="type-body text-ink-2 inline-flex items-center gap-item">
          <input type="checkbox" checked={allOnPage} onChange={() => setSelected(allOnPage ? new Set() : new Set(items.map((i) => i.place.id)))} className="h-5 w-5" />
          Select all shown
        </label>
        <span className="type-body text-ink-2 inline-flex items-center gap-item">
          Status, tags and notes: <OnlyYou />
        </span>
      </div>

      {selected.size ? (
        <Surface variant="raised" className="sticky top-2 z-10 p-row flex flex-col gap-item" data-bulk-bar="" role="region" aria-label="Bulk edit">
          <p className="type-body font-semibold">{pluralize(selected.size, "place")} selected</p>
          <div className="flex flex-wrap items-end gap-item">
            <div className="min-w-[10rem] flex-1">
              <label htmlFor={`${id}-action`} className="type-body text-ink-2">Action</label>
              <Select id={`${id}-action`} value={action} onChange={(e) => setAction(e.target.value as Action)}>
                <option value="visited">Mark visited</option>
                <option value="want_to_go">Mark want to go</option>
                <option value="addTag">Add a tag</option>
                <option value="removeTag">Remove a tag</option>
                <option value="moveToList" disabled={!lists.length}>Move to a list</option>
                <option value="remove">Remove from saves</option>
              </Select>
            </div>
            {action === "addTag" || action === "removeTag" ? (
              <div className="min-w-[8rem] flex-1">
                <label htmlFor={`${id}-tag`} className="type-body text-ink-2">Tag</label>
                <Input id={`${id}-tag`} value={tag} maxLength={24} onChange={(e) => setTag(e.target.value)} />
              </div>
            ) : null}
            {action === "moveToList" ? (
              <div className="min-w-[8rem] flex-1">
                <label htmlFor={`${id}-list`} className="type-body text-ink-2">List</label>
                <Select id={`${id}-list`} value={listId} onChange={(e) => setListId(e.target.value)}>
                  {lists.map((l) => (
                    <option key={l.id} value={l.id}>{l.name}</option>
                  ))}
                </Select>
              </div>
            ) : null}
            <Button type="button" variant={action === "remove" ? "danger" : "ink"} size="md" onClick={apply} loading={pending}>
              Apply
            </Button>
            <Button type="button" variant="ghost" size="md" onClick={() => setSelected(new Set())}>
              Clear
            </Button>
          </div>
        </Surface>
      ) : null}

      {undo ? (
        <Surface variant="raised" className="p-row flex flex-wrap items-center justify-between gap-item" role="status" data-undo-bar="">
          <span className="type-body">{undo.summary}.</span>
          <span className="flex gap-item">
            <Button type="button" size="sm" variant="ink" onClick={doUndo} loading={pending}>
              Undo
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setUndo(null)}>
              Dismiss
            </Button>
          </span>
        </Surface>
      ) : null}

      <ul className="list-none m-0 p-0">
        {items.map(({ place, save }) => {
          const category = getCategory(place.categorySlug);
          const photo = place.photos[0];
          return (
            <li key={place.id} className="surface-flat flex items-start gap-item" data-library-row={place.id}>
              <input
                type="checkbox"
                className="mt-row h-5 w-5 shrink-0"
                checked={selected.has(place.id)}
                onChange={() => toggle(place.id)}
                aria-label={`Select ${place.name}`}
              />
              <div className="min-w-0 flex-1">
                <Row
                  as="div"
                  className="border-0"
                  href={`/places/${place.id}`}
                  title={place.name}
                  media={photo ? { photo: { src: photoSrc(photo.url, "sm"), alt: "" } } : { categorySlug: place.categorySlug }}
                  meta={
                    <>
                      {[category.label, place.neighborhood].filter(Boolean).join(" · ")}
                      {place.ratingCount ? ` · ${formatRating(place.ratingAvg)} from ${pluralize(place.ratingCount, "rating")}` : ""}
                    </>
                  }
                />
                <div className="pb-row flex flex-col gap-hair" data-why="">
                  <div className="flex flex-wrap items-center gap-item">
                    <StatusLabel tone={save.status === "visited" ? "positive" : "neutral"}>{SAVE_STATUS_LABEL[save.status]}</StatusLabel>
                    {save.tags.map((t) => (
                      <span key={t} className="chip h-7 text-xs">{t}</span>
                    ))}
                  </div>
                  {save.note ? <p className="type-body text-ink-2 line-clamp-2 break-words">{save.note}</p> : null}
                  {save.recommendedBy ? <p className="type-body text-ink-2 break-words">Recommended by {save.recommendedBy}</p> : null}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
