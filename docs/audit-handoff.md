# External Audit Handoff Contract

## Objective

Audit the current FindMaxxing web application, Expo mobile application, and shared package; identify confirmed defects and risks; produce a prioritized repair plan; and verify any approved repairs against the acceptance criteria and tests.

## Allowed scope

- Inspect the web app, `apps/mobile`, `packages/shared`, Supabase migrations, scripts, tests, and documentation.
- Reproduce and classify defects.
- Propose minimal, traceable fixes for confirmed defects.
- Add or update focused tests required to prove approved fixes.
- Review mobile migration readiness and identify native-only gaps.

## Out of scope unless separately approved

- Store submission or production deployment.
- Broad redesign or feature expansion.
- Replacing the Supabase data model.
- Weakening RLS, authentication, validation, rate limits, or permission checks.
- Removing existing tests merely to make checks pass.
- Treating Expo web export as proof that native iOS and Android builds work.

## Acceptance criteria

1. Every reported defect is classified as confirmed, probable, or unverified.
2. Each confirmed defect has a reproduction or a focused regression test.
3. Approved fixes preserve web/mobile parity for shared validation, taxonomy, types, and permission behavior.
4. No server-only secrets or service-role credentials reach client/mobile code.
5. Existing authorization, RLS, storage visibility, moderation, account deletion, and rate-limit behavior remains intact.
6. Web type-check, lint, tests, and build status are reported accurately.
7. Mobile type-check and Expo web export status are reported accurately.
8. Native iOS/Android behavior is explicitly marked unverified unless tested on the required toolchains.
9. Changes remain within the approved files and do not include unrelated cleanup.

## Required audit tests

- `npm run typecheck`
- `npm run lint`
- `npm run test`
- `npm run build`
- `npm run typecheck --workspace @findmaxxing/mobile`
- `npm run export:web --workspace @findmaxxing/mobile`
- `npm run e2e` when a browser/build environment is available
- `npm run a11y` when a browser/build environment is available
- Focused security/permission tests for auth, RLS, storage, moderation, account deletion, and rate limits

## Required audit output

- What was inspected
- Confirmed defects with severity and reproduction
- Probable or unverified risks
- Root cause for each confirmed defect
- Proposed fix and affected files
- Acceptance criteria and test cases
- Required fixes before implementation
- Whether the project is ready for implementation

## Implementer must not change

- Public behavior outside the approved defect scope.
- Database permissions or RLS policies without explicit approval and regression tests.
- Authentication, authorization, storage visibility, rate-limit, moderation, or account-deletion safeguards merely to simplify implementation.
- Existing tests or test fixtures solely to hide failures.
- Production configuration, deployment settings, or store metadata unless explicitly included in scope.
