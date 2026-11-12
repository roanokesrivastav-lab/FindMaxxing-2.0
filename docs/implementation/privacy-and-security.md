# Privacy, authorization and trust invariants

These apply to every Must ticket, including demo mode and direct API/RPC paths.

- Private save notes, tags, reasons, source lists and personal photos remain owner-only. Sharing a place/outing does not share the owner’s private collection metadata. Test another user, friend, group member, removed member, anonymous and share-link paths.
- The first rating/review personal-photo rule is self-declared, allows library photos, and never blocks save/join/plan/bulk Visited. Use authorized media delivery; do not create public storage URLs for owner-only media.
- Outings share a permitted place reference and a deliberately written shared reason. Revoked/expired invitations and removed/blocked members lose API/page/chat/notification access, including after a native relaunch.
- Hard constraints veto an outing choice. No vote count overrides a required accessibility/dietary/budget need. Locks and edits must be atomic and auditable.
- Capacity includes actual going and live paid holds under the narrowed contract. Paid tickets/refunds retain existing semantics; no new paid product scope. Full sessions stay Full without waitlisting in the Must release.
- Do not send private notes/saved names/restricted venue data to external model/routing/analytics providers by assuming in-app viewer permission also grants export consent. Follow the existing explicit contracts and consent/retention rules.
- Tentative walking routing persists our plan/verdict only, not restricted provider durations/distances/geometry. Unknown route/hours remains unknown; use adapter fakes without real keys/calls under build rules.
- Weekly memories require explicit self-reported attendance and opted-in shared own posts/media/reviews. An RSVP, direction tap or private photo alone is not proof or permission. Audience cannot broaden automatically; withdrawal, deletion, moderation and membership changes propagate.
- Reports/guide expiry and explicit helpful counters require real evidence and abuse controls. No reports means unknown; impressions are not proof a tip helped someone.

High-risk contract changes need independent preflight before coding and adversarial verification afterward. Never classify a snapshot push as security approval or a staging/production release.
