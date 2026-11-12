# Independent review and founder checkpoint

Use AGENTS.md’s preflight and verification protocol. Scope each review to the actual assigned contract and inspect the implementation rather than trusting a summary.

## Before implementation

- Confirm Must scope and that no Later feature is an implicit prerequisite.
- Check coding prompt, likely files, acceptance and tests; return Approved / Approved with required changes / Blocked pending input.
- For revised capacity/series, membership/invite, privacy/media/memory or itinerary contracts, review the explicit spec before coding.

## After implementation

- Inspect complete diff and surrounding consumers, compatibility, flags, migrations and demo parity.
- Map every acceptance criterion to evidence; run/review appropriate real-path tests and required race/role cases.
- Adversarially check leaks, stale access, overbooking, lock order, duplicate notifications, DST, invalid plans, untrusted media and unknown data.
- Report what changed, what was verified, findings/required fixes and readiness. A green local gate is not a platform release decision.

## Founder review bundle

Current mobile captures for normal/full/cancelled/empty/error/no-photo/large-text states; implemented vs proposed labels; end-to-end journey evidence; blockers and remaining Must rows; unchanged Later backlog; next decisions with evidence. Keep a dated change-log entry for any priority/behavior revision rather than rewriting the Nov 11 source snapshot.
