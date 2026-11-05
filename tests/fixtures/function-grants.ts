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
      "moderate_target(text,uuid,text,text)", "moderation_queue(timestamp with time zone,uuid,integer)",
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
      "check_rate_limit(text)", "consume_trip_plan()", "count_upload(text,text)", "reserve_ticket(uuid)",
      "start_direct(uuid)", "track_event(text,jsonb)", "notify_trip_plan_ready(text)",
    ],
  },
  {
    anon: false,
    reason: "Registration binds token to auth.uid(), caps devices and validates endpoint/token; delivery and device dropping remain service-only. Token transfer is existing account-switch behavior.",
    signatures: ["save_expo_push_token(text)", "save_push_subscription(text,text,text)"],
  },
];

export const FUNCTION_GRANT_ALLOWLIST = groups.flatMap(({ anon, reason, signatures }) =>
  signatures.map((signature) => ({ signature, anon, authenticated: true, reason })),
);
