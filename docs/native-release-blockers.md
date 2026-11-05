# Native release blockers — 2026-10-27

Follow-up to the "Remaining mobile migration scope" table in
[release-mobile-verification.md](release-mobile-verification.md). Four of the
native gaps were fixed in code and covered by unit and database tests. No
simulator, device or Expo project was available, so **nothing here has run on a
phone**. The release decision in [beta-gate.md](beta-gate.md) is unchanged:
which gaps block the native release is still the owner's call.

Verified locally with `npm test`, `npm run typecheck`,
`npx eslint . --ignore-pattern '.claude/**'` and `tsc --noEmit -p apps/mobile`.

## Summary

| Gap | Status | Needs a device to confirm |
| --- | --- | --- |
| Auth persistence (AsyncStorage) | **Fixed**: session in the OS keystore, chunked, migrated | Keychain/Keystore behaviour, upgrade from an AsyncStorage build, background refresh |
| Push token survives sign-out | **Fixed**: removed on the server and unregistered locally before sign-out | Delivery stops after sign-out; re-registration after sign-in; account switch |
| Upload privacy (raw JPEG to Storage) | **Fixed for metadata**: EXIF/GPS/XMP stripped on the phone, non-JPEG refused, 5 MB cap | Real camera and library photos (iOS HEIC, Android), orientation |
| Event creation (three requests) | **Fixed**: one transactional RPC for web (Supabase adapter) and mobile | Nothing device-specific |
| Photo gallery (`photos: []`) | **Not done** | — |
| Session hydration / account switch | **Partly**: push registers once per account, not per token refresh | Cold boot, session-read failure, account switch |
| Push readiness (EAS project id, visible errors) | **Not done** | — |
| Feature completeness (profile, settings, tickets on web) | **Not done** (product decision) | — |

## 1. Secure session storage — fixed

**Contract.** Objective: the native Supabase session is stored in
`expo-secure-store`, not AsyncStorage. Scope: `apps/mobile/lib/secureStorage.ts`
(new, pure), `apps/mobile/lib/supabase.ts`, the `expo-secure-store ~57.0.4`
dependency (SDK 57's bundled version). Out of scope: the web build (no keystore;
keeps AsyncStorage/localStorage), refresh policy, biometric locking.
Acceptance: values over SecureStore's 2048-byte limit round-trip; every stored
value stays under it; a failed write never leaves a corrupt session; a session
in AsyncStorage from an older build is moved over and deleted there; sign-out
removes every chunk and any AsyncStorage copy. Tests:
`tests/mobile-secure-storage.test.ts` (11).

**What changed.** Values are split into chunks of at most 600 UTF-16 units
(≤ 1800 UTF-8 bytes, never splitting a surrogate pair). The key holds a manifest
(`chunked:v1:<generation>:<count>`) written only after all chunks of a new
generation are stored; old chunks are deleted afterwards, so a crash midway
leaves the previous session readable. A missing chunk reads as signed out.
Migration happens on first read; if the keystore write fails the AsyncStorage
copy is kept so the upgrade cannot sign anyone out. Keychain items use
`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: readable for background token refresh
after the first unlock, never restored to another device from a backup.

**Needs a device.** That SecureStore accepts the keys and sizes on iOS and
Android; upgrading an installed AsyncStorage build signs the user straight in;
background refresh with the phone locked after first unlock.

**Known limits.** iOS keeps Keychain items after the app is uninstalled, so a
reinstall can come back signed in (common to SecureStore apps; clear on first
launch if the owner wants otherwise). A crash between writing chunks and the
manifest can leave orphan chunks of an unused generation; they are never read.

## 2. Push token removed on sign-out — fixed

**Contract.** Objective: a signed-out device stops receiving pushes. Scope:
`apps/mobile/lib/pushLifecycle.ts` (new, pure), `lib/push.ts`, `lib/api.ts`
(`removePushToken`), `app/_layout.tsx`, `app/(tabs)/profile.tsx`. Out of scope:
the server push transport, EAS project setup. No migration: RLS already lets a
user delete their own `push_subscriptions` rows ("users remove their devices",
`0021`); both web adapters already had `removeDevice`. Acceptance: sign-out
deletes this device's row while the session is still valid, unregisters the
device locally, forgets the remembered token, then ends the session; offline,
local unregistration and sign-out still happen; a registration in flight cannot
re-add the token; a user cannot delete another user's token. Tests:
`tests/mobile-push-lifecycle.test.ts` (8 lifecycle + 1 PGlite RLS).

**What changed.** The registered token is remembered in SecureStore; tokens
from earlier builds are looked up without prompting. Sign-out order: wait for
any registration → delete the row (`kind = 'expo'`, own rows only) →
`Notifications.unregisterForNotificationsAsync()` → forget → `auth.signOut()`,
falling back to a local sign-out when the server revoke fails (supabase-js
otherwise keeps the session offline). The profile screen shows a spinner and
an error if sign-out itself fails. Registration now runs once per user id,
not on every token refresh.

**Needs a device.** Pushes stop after sign-out (including offline sign-out);
after signing in again, `getExpoPushTokenAsync` re-registers the unregistered
device and the token is saved for the new account; account switch on one
phone. Unverified assumption: re-registration after
`unregisterForNotificationsAsync` works on both platforms with SDK 57.

**Known limits.** If the server delete fails (offline), the row stays until the
scheduler gets `DeviceNotRegistered` from Expo and drops it, or the token is
saved again by the next account.

## 3. Upload privacy — metadata fixed; pipeline parity not

**Contract.** Objective: no location or camera metadata leaves the phone in a
place photo. Scope: `apps/mobile/lib/jpegMetadata.ts` (new, pure, no new
dependency), `uploadPlacePhoto` in `lib/api.ts`. Out of scope: resizing,
`sm`/`md` variants and server-side decoding (the web pipeline in
`src/lib/images`), avatars (no native upload). Acceptance: EXIF (incl. GPS),
XMP, maker/MPF blocks, comments and bytes after end-of-image are removed; image
data, JFIF, ICC and Adobe blocks are byte-identical; orientation is kept;
non-JPEG, truncated and over-5 MB input is refused, not uploaded. Tests:
`tests/mobile-jpeg-metadata.test.ts` (7, with real JPEGs from sharp carrying
GPS EXIF and XMP: the output decodes to identical pixels with no EXIF/XMP).

**Needs a device.** Real iOS and Android camera and library photos:
specifically whether `expo-image-picker` (quality 0.6) always returns JPEG. An
iOS HEIC library photo would now be refused with "Use a JPEG photo." rather
than uploaded; if that happens on a device, re-encode with
`expo-image-manipulator` (SDK 57: `~57.0.21`) before stripping.

**Left.** Phone uploads still skip the variants and server-side checks the web
pipeline applies; Storage's 5 MB/MIME limits are the only server bound.

## 4. Event creation in one step — fixed

**Contract.** Objective: event, tags and the creator's attendance are created
together or not at all. Scope: new migration
`supabase/migrations/0036_create_event_with_details.sql`, the web Supabase
adapter (`events.create`), mobile `createEvent`. The demo adapter already does
all three in one in-memory step and is unchanged. Out of scope: event edits.
Acceptance: one call creates all three as the caller; a failing tag rolls back
the event; insert policies (linked place visibility), table checks and
anonymous access are enforced; the function is `security invoker`. Tests:
`tests/event-create-atomic.test.ts` (5, PGlite over every migration).

**Needs.** Applying `0036` to staging (`supabase db push`) before deploying the
web adapter change, which calls the new RPC.

## Still open

- **Photo gallery parity**: `toPlace` returns `photos: []` and the place
  screen has no gallery; private-photo delivery to the app needs a design.
- **Session hydration / account switch**: `Gate` renders its stack while the
  session loads; profile state is not cleared on user change. Needs device
  testing of cold boot and account switch.
- **Push readiness**: no EAS project id in `app.json`; registration errors are
  still swallowed in `Gate`.
- **Feature completeness**: profile editing, settings, tickets and Plus are
  web-only; the owner decides what the native release needs.
- **Everything above on a device**: iOS and Android, per the "Needs a device"
  notes, plus the batch 5 list in release-mobile-verification.md.
