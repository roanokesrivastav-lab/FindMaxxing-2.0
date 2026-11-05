/**
 * Reviewed API-callable, non-trigger public SECURITY DEFINER functions (0039).
 * This is an explicit allowlist, not a snapshot to regenerate from the database.
 * Adding an overload or a role requires reviewing its body and caller boundary.
 * Other definer functions must deny both API roles. Service/internal functions
 * are intentionally absent; effective privileges include inherited/PUBLIC grants.
 */
const groups = [
  {
    anon: true,
    reason: "Viewer-bound visibility and text search; returns only visible IDs or eligibility for the current caller.",
    signatures: [
      "can_view_event(uuid)", "can_view_place(uuid)", "can_view_place_photo_object(text)", "can_view_place_tip(uuid)",
      "discover_event_text_ids(text,text[],text[])", "discover_place_text_ids(text,text[],text[])",
      "is_local(text)", "is_mutual_follow(uuid)", "is_trusted_local(text)",
    ],
  },
  {
    anon: true,
    reason: "Current caller's admin/moderator membership only; false without a subject.",
    signatures: ["is_admin()", "is_moderator()"],
  },
  {
    anon: true,
    reason: "Storage policy helper exposes attachment existence only, not photo content or its place; access remains can_view_place_photo_object gated.",
    signatures: ["has_attached_photo_object(text)"],
  },
  {
    anon: false,
    reason: "Admin reads use is_admin(); mutations use admin_require() or an explicit is_admin() gate and audit writes.",
    signatures: [
      "admin_content(text,text,text,uuid,timestamp with time zone,uuid,integer)",
      "admin_history(text,uuid,text,timestamp with time zone,uuid,integer)", "admin_rate_limit_hits()",
      "admin_set_moderator(uuid,boolean,text)", "admin_set_suspended(uuid,boolean,text)",
      "admin_set_taxonomy_retired(text,text,boolean,text)",
      "admin_upsert_taxonomy(text,text,text,text,integer,text,text,text)",
      "admin_users(text,timestamp with time zone,uuid,integer)",
      "analytics_funnel(timestamp with time zone,timestamp with time zone)",
      "analytics_save_sources(timestamp with time zone,timestamp with time zone)",
      "analytics_weekly_contributors(integer)", "review_ad_campaign(uuid,boolean,text)",
    ],
  },
  {
    anon: false,
    reason: "Moderator gate on queue/content and audited changes; no arbitrary member can invoke moderation power.",
    signatures: [
      "moderate_target(text,uuid,text,text)", "moderation_queue(timestamp with time zone,uuid,integer)", "set_place_public_photo(uuid,uuid,text)",
      "moderation_target(text,uuid)", "reset_reputation(uuid,text)", "set_local_status(uuid,boolean,text)",
    ],
  },
  {
    anon: false,
    reason: "Subject-bound private status or membership; cross-user lookup denied, or caller must be one endpoint of a block relation.",
    signatures: [
      "account_is_closing(uuid)", "is_suspended(uuid)", "has_blocked(uuid,uuid)",
      "is_blocked_between(uuid,uuid)", "is_conversation_member(uuid)",
      "can_message(uuid)", "my_removed_content()",
    ],
  },
  {
    anon: false,
    reason: "Plus badge is intentionally public to signed-in viewers; does not return billing identifiers.",
    signatures: ["is_plus(uuid)"],
  },
  {
    anon: false,
    reason: "Authenticated creation uses auth.uid(), ownership/visible linked items, validation and write triggers; updates restrict creator_id to auth.uid().",
    signatures: [
      "create_place_with_details(text,text,text,text,double precision,double precision,text,text,text,text,text[],jsonb)",
      "update_event_with_tags(uuid,text,text,uuid,text,text,double precision,double precision,timestamp with time zone,timestamp with time zone,text,integer,text[])",
      "update_place_with_tags(uuid,text,text,text,text,double precision,double precision,text,text,text,text[])",
      "create_ad_campaign(text,uuid,text,text,text,double precision,double precision,double precision,double precision,timestamp with time zone,timestamp with time zone,integer)",
      "set_ad_campaign_paused(uuid,boolean)", "set_event_price(uuid,integer)", "event_ticket_summary(uuid)",
    ],
  },
  {
    anon: false,
    reason: "Work is charged/scoped to auth.uid(): own quota, ticket, conversation membership, analytics or notification; no caller-supplied victim ID.",
    signatures: [
      "check_rate_limit(text)", "consume_trip_plan()", "count_upload(text,text)", "count_personal_upload(text)", "reserve_ticket(uuid)",
      "start_direct(uuid)", "track_event(text,jsonb)", "notify_trip_plan_ready(text)",
    ],
  },
  {
    anon: false,
    reason: "Registration binds token to auth.uid(), caps devices and validates endpoint/token; delivery and device dropping remain service-only. Token transfer is existing account-switch behavior.",
    signatures: ["save_expo_push_token(text)", "save_push_subscription(text,text,text)"],
  },
  {
    anon: true,
    reason: "Roadmap 4.3 (0052): Readiness counts for an event the caller can already see (can_view_event), null otherwise. Counts only, never names.",
    signatures: ["event_readiness(uuid)", "event_readiness(events)"],
  },
  {
    anon: false,
    reason: "Roadmap 4.3 (0052): the caller confirms only an event they created (creator_id = auth.uid(), under the event row lock), before its deadline.",
    signatures: ["confirm_session(uuid)"],
  },
  {
    anon: false,
    reason: "Roadmap 4.4 (0054): the caller's own participation only (auth.uid(), active account), under the event row lock; seats via seats_taken; priced events refused. host_remove_participant requires creator_id = auth.uid().",
    signatures: [
      "join_event(uuid)", "leave_event(uuid)", "set_interest(uuid,boolean)", "accept_offer(uuid)", "decline_offer(uuid)",
      "host_remove_participant(uuid,uuid)",
    ],
  },
  {
    anon: true,
    reason: "Roadmap 4.5a (0055): series visibility, and whether the current caller hosts an event (false without a subject); booleans for the caller only.",
    signatures: ["can_view_series(uuid)", "viewer_hosts_event(uuid)"],
  },
  {
    anon: false,
    reason: "Roadmap 4.5a (0055): host tools re-check is_series_host/is_event_host (or owner for hosts, moderator for moderate_series) for auth.uid() on every call, so a revoked host loses access at once; follow writes only the caller's own row.",
    signatures: [
      "create_series(text,text,text,uuid,text,text,double precision,double precision,text,integer[],integer,time without time zone,integer,date,date,integer,integer,integer,jsonb,jsonb,text,text[])",
      "update_occurrence(uuid,text,text,uuid,text,text,double precision,double precision,timestamp with time zone,timestamp with time zone,integer)",
      "update_series_from(uuid,text,text,uuid,text,text,double precision,double precision,integer[],integer,time without time zone,integer,integer)",
      "cancel_occurrence(uuid)", "end_series(uuid,date)", "set_series_host(uuid,uuid,boolean)", "follow_series(uuid,boolean)",
      "set_attended(uuid,uuid,boolean)", "moderate_series(uuid,boolean)",
    ],
  },
  {
    anon: true,
    reason: "Roadmap R3 (0056): club visibility, the caller's right to see member names, and the member count (never names); caller-bound.",
    signatures: ["can_view_club(uuid)", "viewer_sees_club_members(uuid)", "club_member_count(uuid)"],
  },
  {
    anon: false,
    reason: "Roadmap R3 (0056): owner-only club changes (owner_id = auth.uid()); series attach requires is_series_host for auth.uid(); join/leave writes only the caller's row; moderate_club requires is_moderator().",
    signatures: [
      "create_club(text,text,uuid[])", "set_club_series(uuid,uuid,boolean)", "join_club(uuid,boolean)",
      "remove_club_member(uuid,uuid)", "moderate_club(uuid,boolean)",
    ],
  },
  {
    anon: false,
    reason: "Roadmap R2 (0058): writes only the caller's own alert settings (auth.uid()), rounding the area to a coarse cell; categories validated.",
    signatures: ["set_need_player_alerts(boolean,text[],double precision,double precision,integer)"],
  },
];

export const FUNCTION_GRANT_ALLOWLIST = groups.flatMap(({ anon, reason, signatures }) =>
  signatures.map((signature) => ({ signature, anon, authenticated: true, reason })),
);
