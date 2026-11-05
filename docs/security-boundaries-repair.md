# Security and privacy repair — batch 1

Repairs audit findings F6 (push destination requests), F7 (auth redirects), and F8 (private block relationships). Other audit findings remain separate work.

## Changes

- Auth actions, sign-in/sign-up pages, and the callback now use one same-origin redirect validator. Backslashes, controls, encoded bypasses, and external destinations fall back to the appropriate internal landing page. Normal paths, encoded neighborhood names, queries, and fragments remain supported.
- Browser push registration accepts supported Google, Mozilla, Apple, and Windows provider destinations over HTTPS on port 443. The application and database enforce the same provider policy. Expo token registration is unchanged.
- Delivery checks stored browser subscriptions again, validates every resolved IP address, and pins the socket to the validated DNS answers. Private/reserved IPs, DNS changes between validation and connection, and redirect destinations cannot send the server into an internal network. TLS still uses the provider's hostname and normal certificate verification.
- Public block helper RPCs reveal only relationships involving the authenticated caller. Unrestricted helpers live in `findmaxxing_private`, with no API-role schema usage or execution grants. Trusted message triggers and notification creation use those helpers so block enforcement and notification suppression still work.
- Migration `0026_security_boundaries.sql` makes these database changes without editing previously applied migrations. Existing unsupported push rows are preserved by the migration; delivery refuses them and the normal device-removal path discards them when encountered. The new constraint is intentionally `NOT VALID` for existing rows but enforces new/updated writes.

## Focused acceptance coverage

| Finding | Tests |
| --- | --- |
| F6 | Supported providers, deceptive hostnames, credentials, unsafe ports, IPv4/IPv6 and encoded IPs, mixed public/private DNS answers, lookup pinning, legacy rows, direct registration RPC, database/application policy parity, delivery cleanup, DNS failures, and the real web-push library's redirect behavior |
| F7 | Raw and encoded malicious destinations, dot-segment normalization, every auth action and signed-in auth page, callback Location headers, and preservation of normal destinations |
| F8 | Cross-user and reversed-pair probes, anonymous calls, private-schema access denial, participant queries, suppression with unrelated/no JWT, and existing messaging/notification/moderation suites |

The tests use isolated demo data, embedded Postgres, DNS stubs, and an intercepted HTTPS request. No real push request is sent. The HTTPS transport test invokes the installed web-push library with valid generated encryption/VAPID keys rather than replacing the library itself.

## Rollout

1. Apply migration `0026_security_boundaries.sql` to a disposable staging database using the usual migration process.
2. Deploy the application changes alongside the migration. Database block privacy requires the migration; server-side push delivery protections require the application deployment.
3. Verify one real browser subscription/delivery for supported browsers, a private-block RPC probe through PostgREST, and successful auth redirects on staging. Keep `findmaxxing_private` out of exposed API schemas and do not grant API roles access to its unrestricted helpers.
4. Additional push providers require a reviewed addition to both provider policies and parity tests. No environment-variable bypass is provided.

No hosted migrations, production deployment, production device cleanup, or real notification delivery were performed during the local repair.

## Provider references

- Google lists `fcm.googleapis.com` for message sending in its [network configuration documentation](https://firebase.google.com/docs/cloud-messaging/network-configuration).
- Mozilla identifies `updates.push.services.mozilla.com` in the [Autopush documentation](https://mozilla-services.github.io/autopush-rs/).
- Apple explicitly requires support for subdomains of `push.apple.com` in [Meet Web Push](https://webkit.org/blog/12945/meet-web-push/).
- Microsoft requires validating the `notify.windows.com` domain for WNS channel URIs in its [WNS overview](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/push-notifications/wns-overview).

## Verification completed

| Check | Result |
| --- | --- |
| Full tests | Passed: 35 files, 734 tests (643 existing + 91 added) |
| Web type-check | Passed, rerun after the production build finished |
| Lint | Passed |
| Production build (Webpack) | Passed, isolated demo configuration |
| Default production build (Turbopack) | Still environment-blocked by local port binding `EPERM`, including escalated execution |
| Browser end-to-end | Passed: 19/19, isolated demo store |
| Accessibility | Passed: 15 pages, zero violations; keyboard focus test passed |
| Mobile type-check | Passed |
| Expo web export | Passed |
| Whitespace/diff check | Passed |

Post-implementation adversarial review covered direct RPC bypass, preexisting
subscriptions, DNS rebinding, mixed IP families, private helper access, and
redirect normalization at the actual auth entry points. The notification
function's body was also compared with the prior migration: its only behavioral
change is using the private block helper. All existing messaging, moderation,
and notification tests pass.

No remaining local blocker was found for this batch. Ready for user code review;
hosted protection still requires migration and deployment, followed by the
staging checks above. The other six audit findings remain open. vexp tools were
not available in this session; verification used direct diff/source inspection
and the repository's declared test commands.
