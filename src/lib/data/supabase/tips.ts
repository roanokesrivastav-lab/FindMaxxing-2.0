/**
 * Supabase twin of the tips repository (roadmap 2.6). RLS in 0060_place_tips.sql
 * decides visibility; the database refuses self-confirmation, status changes by
 * non-moderators, and writes to the confirmation columns. The checks here only
 * give clearer messages.
 */
import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";
import type { DataRepository } from "../repository";
import { DataError, type ProfileSummary } from "../types";
import { isCurrentTip, normalizeCorrection, normalizeTipInput, orderTips, type PlaceTip, type TipKind, type TipStatus } from "@/lib/places/tips";

type SummaryRow = { id: string; username: string; display_name: string; avatar_url: string | null } | null;
type TipRow = {
  id: string; place_id: string; body: string; kind: TipKind; expires_at: string | null; status: TipStatus;
  created_at: string; updated_at: string; last_confirmed_at: string | null;
  author: SummaryRow; confirmer: SummaryRow;
};
const PROFILE = "id, username, display_name, avatar_url";
const TIP_SELECT = `id, place_id, body, kind, expires_at, status, created_at, updated_at, last_confirmed_at, author:profiles!place_tips_author_id_fkey(${PROFILE}), confirmer:profiles!place_tips_last_confirmed_by_fkey(${PROFILE})`;

const summary = (r: SummaryRow): ProfileSummary | null => (r ? { id: r.id, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url } : null);
const toTip = (r: TipRow): PlaceTip => ({
  id: r.id, placeId: r.place_id, body: r.body, kind: r.kind, expiresAt: r.expires_at, status: r.status,
  author: summary(r.author), createdAt: r.created_at, updatedAt: r.updated_at,
  lastConfirmedAt: r.last_confirmed_at, lastConfirmedBy: summary(r.confirmer),
});

export function createSupabaseTips(
  supabase: SupabaseClient,
  h: { translate(error: PostgrestError): DataError },
): DataRepository["tips"] {
  const unwrap = <T>(res: { data: T | null; error: PostgrestError | null }): T => {
    if (res.error) throw h.translate(res.error);
    return res.data as T;
  };
  const getTip = async (tipId: string) =>
    unwrap(await supabase.from("place_tips").select(TIP_SELECT).eq("id", tipId).maybeSingle()) as unknown as TipRow | null;

  return {
    async list(placeId, _viewerId, now = Date.now()) {
      const rows = unwrap(
        await supabase.from("place_tips").select(TIP_SELECT).eq("place_id", placeId).eq("status", "published")
          .or(`expires_at.is.null,expires_at.gt.${new Date(now).toISOString()}`),
      ) as unknown as TipRow[];
      return orderTips(rows.map(toTip).filter((t) => isCurrentTip(t, now)));
    },
    async evidence(tipId) {
      const tip = await getTip(tipId);
      if (!tip) return null;
      const [confirmations, corrections] = await Promise.all([
        supabase.from("place_tip_confirmations").select(`created_at, user:profiles!place_tip_confirmations_user_id_fkey(${PROFILE})`).eq("tip_id", tipId).order("created_at", { ascending: false }),
        supabase.from("place_tip_corrections").select(`id, body, created_at, author:profiles!place_tip_corrections_author_id_fkey(${PROFILE})`).eq("tip_id", tipId).order("created_at", { ascending: false }),
      ]);
      return {
        tip: toTip(tip),
        confirmations: (unwrap(confirmations) as unknown as { created_at: string; user: SummaryRow }[]).map((c) => ({ user: summary(c.user), createdAt: c.created_at })),
        corrections: (unwrap(corrections) as unknown as { id: string; body: string; created_at: string; author: SummaryRow }[]).map((c) => ({ id: c.id, body: c.body, author: summary(c.author), createdAt: c.created_at })),
      };
    },
    async add(userId, placeId, input) {
      const clean = normalizeTipInput(input);
      const row = unwrap(
        await supabase.from("place_tips").insert({ place_id: placeId, author_id: userId, body: clean.body, kind: clean.kind, expires_at: clean.expiresAt }).select(TIP_SELECT).single(),
      ) as unknown as TipRow;
      return toTip(row);
    },
    async edit(userId, tipId, input) {
      const clean = normalizeTipInput(input);
      const rows = unwrap(
        await supabase.from("place_tips").update({ body: clean.body, kind: clean.kind, expires_at: clean.expiresAt }).eq("id", tipId).eq("author_id", userId).select(TIP_SELECT),
      ) as unknown as TipRow[];
      if (!rows.length) throw new DataError("Only the author can edit this tip", "forbidden");
      return toTip(rows[0]);
    },
    async confirm(userId, tipId) {
      const tip = await getTip(tipId);
      if (!tip) throw new DataError("Tip not found", "not_found");
      if (tip.author?.id === userId) throw new DataError("You can't confirm your own tip", "forbidden");
      unwrap(await supabase.from("place_tip_confirmations").insert({ tip_id: tipId, user_id: userId }));
    },
    async suggestCorrection(userId, tipId, body) {
      const text = normalizeCorrection(body);
      unwrap(await supabase.from("place_tip_corrections").insert({ tip_id: tipId, author_id: userId, body: text }));
    },
    async setStatus(_moderatorId, tipId, status) {
      const rows = unwrap(await supabase.from("place_tips").update({ status }).eq("id", tipId).select("id")) as { id: string }[];
      if (!rows.length) throw new DataError("Moderators only", "forbidden");
    },
  };
}
