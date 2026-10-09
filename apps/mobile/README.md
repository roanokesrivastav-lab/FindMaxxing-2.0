# FindMaxxing mobile (Expo)

The iOS and Android app, sharing the web app's Supabase backend, and its types,
taxonomy and validation through `packages/shared`. It talks to Supabase
directly with the **anon key and the user's session**: every rule (visibility
tiers, who can write what, capacity, tickets, blocks, rate limits,
suspension) is enforced by RLS and triggers in the database, so the app cannot
do anything the website can't.

## Run it

From the repository root (npm workspaces install everything once):

```sh
npm install
cp apps/mobile/.env.example apps/mobile/.env   # then fill in the two values
npm run start --workspace @findmaxxing/mobile  # Expo dev server; press i / a / w
```

`.env` needs `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_ANON_KEY`: the
**same public values as the web app**, never the service-role key. Without them
the app opens to a "no backend configured" screen.

- iOS simulator: needs Xcode (`npx expo run:ios`).
- Android emulator: needs Android Studio (`npx expo run:android`).
- Web build: `npm run export:web --workspace @findmaxxing/mobile` (the map is
  native-only; the web build lists places instead).

After changing an `EXPO_PUBLIC_` value, clear Metro's cache (`--clear`): the
values are inlined at build time.

## What's in it

Sign in (accounts are created on the website), Explore (native map plus the
places in view, from `discover_places`), place details with save and
save-to-list, events with join and leave, create an event where you are, add a
place where you are with a camera photo (stored under your own folder, as the
storage policy requires, through `create_place_with_details`), Saved, an Inbox
with messages (live through Supabase Realtime) and notifications, and Profile.

## Push

On a real device, once signed in, the app asks for notification permission and
stores its Expo push token with `save_expo_push_token` in `push_subscriptions`
(kind `expo`). The web app's scheduler (`/api/cron/notifications`) then sends to
it through Expo's push service with the same rules as web push: per-type
preferences, quiet hours, at most five a day, never twice. Building a push-capable
binary needs an EAS project id (`eas init`) and, for iOS, an Apple developer
account.

## React versions

React Native 0.86 needs exactly `react@19.2.3`; the web app runs a later 19.2.
npm keeps this workspace's copy in `apps/mobile/node_modules`, and
`metro.config.js` makes every import of `react` and `react-dom` resolve to it.

## Not done here

Store submission (App Store, Play) and native builds: no Xcode or Android SDK
was available, so the app was verified by type-checking and an Expo web export
rendered in a browser. See the owner checklist in the root README.
