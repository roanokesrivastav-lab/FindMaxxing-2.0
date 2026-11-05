# Accessibility pass: WCAG 2.2 AA on the main flows

Date: 2026-10-27. Base: `tier1-owner-controls` at `9e1f37b`. Demo mode, fresh seed data.

## How it was checked

- `npm run build && npm run a11y` (`scripts/a11y.mjs`): axe-core 4.14 over 24 pages, now at
  **phone (390×844, touch)** and **desktop (1280×900)**, with reduced motion and the
  feature-flagged screens (messages, notifications, payments) switched on, the way
  `scripts/e2e-features.mjs` runs them. `A11Y_WIDTHS=phone` (or `desktop`) runs one width.
- axe's `target-size` rule (WCAG 2.2 AA, 2.5.8) is off by default. The script now
  turns it on, and both counts below include it.
- A keyboard walk (Tab through each page, about 15–70 stops per page): every focused
  element must show an outline, ring or focused wrapper, and must not be fully covered
  by sticky or floating UI (2.4.7, 2.4.11). Pages walked: explore, place, event (signed
  out and in), saved, profile, settings, messages, notifications and checkout, at both
  widths. Every map pin on explore was walked at both widths too.
- Contrast of the focus ring against every surface token, worked out with
  `src/lib/utils/contrast.ts` (1.4.11).

Pages scanned: explore, place detail (signed out and in), save sheet, report sheet,
sign in, sign up, forgot password, events, event detail (signed out and in),
onboarding (`/welcome`, as a freshly signed-up account), saved, add a place, create an
event, profile, settings, messages (with conversations and empty), a message thread,
notifications, checkout (`/checkout/demo?plan=plus`), moderation queue, and the 404.

## Before / after (axe, both widths, target-size on)

| | Serious / critical | Moderate / minor |
|---|---|---|
| Before | **1** | **5** |
| After | **0** | **0** |

Before, in detail:

- serious, `target-size`, explore @phone: the map's attribution toggle (ⓘ) sat under
  the floating "Use my location" button, leaving 6×24 px of it tappable.
- moderate, `heading-order` ×4: messages (empty) and notifications, at both widths.
  `EmptyState` always rendered an `h3` directly under the page `h1`.
- moderate, `page-has-heading-one`, explore @desktop: explore had no `h1` at all,
  at either width.

The keyboard walk and the focus-ring contrast check found problems axe doesn't
measure. They are listed under "Fixed" below.

## Fixed

**Touch targets (2.5.8)**
- Explore, phone: the attribution control now sits left of the "Use my location" column,
  so the two never overlap, whether the attribution is collapsed or expanded
  (`globals.css`, `.explore-map`).
- Clear-search buttons on explore, saved and people were bare 16 px icons. They are now
  32 px round buttons. "Load earlier messages" is 44 px tall.

**Visible focus and focus not obscured (2.4.7, 2.4.11, 1.4.11)**
- Global focus outline changed from `flare` to the existing `flare-ink` token. Bright
  flare measured 2.77:1 on `paper-2`, 2.84:1 on `flare-100` and 2.97:1 on `pulse-50`.
  `flare-ink` is at least 3:1 on every surface, including ink (3.04:1).
- The explore and saved search boxes and the chat composer had `outline-none` and no
  replacement. Their wrappers now show an ink border and ring while focused, like
  `.field:focus`.
- Phone: anything scrolled into view on focus landed under the fixed bottom nav (the
  tag links and Report on place pages, notification toggles in settings). `html`
  now has `scroll-padding-bottom` equal to the nav height on phones.
- Map pins: a pin reached with Tab could be under the search bar, the results card, the
  desktop list panel or another pin, or off the map. A focused pin that's hidden now
  eases into the clear part of the map (it jumps instead under reduced motion) and comes
  to the front. It also stays on the map while focused, even if the refresh that the move
  triggers drops it from the results. Before, that sent focus back to `body`.
  (`MapCanvas.tsx`, `globals.css`.)
- Phone, all maps except explore: the rule lifting the attribution above the nav applied
  to every map, which pushed it out of small maps such as a place's, where it was clipped
  and could take focus while invisible. That rule now applies only to the explore map.

**Names, roles, structure (1.3.1, 4.1.2, 2.4.6)**
- `EmptyState` takes a `heading` level: `h2` by default, `h3` where it sits inside an `h2`
  section (profile activity tabs, "All saved", the reports sections, people search), and
  `h1` on the error and 404 pages, which had no `h1` before.
- Explore has a visually hidden `h1`. Its "Events" and "Places" fold toggles are now
  buttons inside `h2`s (the accordion pattern), so the outline reads h1 › h2 › card h3.
- The explore avatar link is named "Your profile", not the person's name.
- Loading skeletons put `aria-label="Loading"` on a plain `div`. Screen readers ignore
  that, and axe flags it as `aria-prohibited-attr` once a skeleton is on screen. They
  are now `role="status"` with hidden "Loading…" text, and so is the map's loading
  placeholder.

**Reduced motion (2.3.3, 2.2.2)**
- Jumping to a form's first error used `scrollIntoView({ behavior: "smooth" })`. A smooth
  scroll requested from script ignores the CSS reduced-motion rule, so the code now checks
  `prefers-reduced-motion` itself. Everything else was already covered by the global rule
  in `globals.css` and by `MapCanvas`'s zero-duration flights.

**Loading, empty and error states**
- New `loading.tsx` for routes that had none, so navigating to them used to give no
  feedback: messages, a message thread, notifications, checkout, onboarding (`/welcome`),
  settings, tickets and the moderation queue. Each uses the existing skeletons.
- Chat thread: a failed refresh (offline, server down) used to fail silently. It now shows
  a status line saying new messages will appear once the connection is back, and
  clears itself on the next successful poll. A failed "Load earlier messages"
  shows an error toast instead of doing nothing, and network errors no longer throw
  unhandled.
- Already in place and checked: empty states on explore, events, saved, a saved list,
  messages, notifications, tickets, people, profile activity and reports; explore's
  "Couldn't load results. Retry"; onboarding's inline `role="alert"` errors; checkout's
  error toasts; the root `error.tsx` and `global-error.tsx` boundaries; and the map's
  "Map tiles didn't load" state.

## Left / not covered

- **The main checkout had no a11y script or mobile app.** This worktree was cut from
  `main` (`c8514fb`), which has neither, so the branch was moved to
  `tier1-owner-controls`, which does. Merging this branch therefore brings in everything
  on `tier1-owner-controls` too.
- The Expo app (`apps/mobile`) was not part of this pass, which covered the web app only.
- Loading skeletons were fixed from the code, but no scan captures a mid-navigation
  skeleton. The root error boundary can't be triggered on demand, so it was checked by
  sharing `EmptyState` with the 404, which is scanned.
- Profile activity tabs use `role="tab"` without tab panels or arrow-key movement. Each
  tab is still a reachable button and axe doesn't flag them, but the full ARIA tabs
  pattern would be better.
- Admin pages, `/plan`, `/plus`, `/ads` and `/help` were not scanned and have no
  `loading.tsx`.
- Automated checks can't cover 1.4.10 reflow at 320 px, 1.4.12 text spacing, or how
  screen readers actually announce things. Those still need a manual pass with
  VoiceOver or TalkBack.
- The checkout scanned is the demo checkout. Stripe-hosted checkout is outside the app.
