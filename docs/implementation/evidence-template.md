# Per-ticket evidence template

Copy into the ticket’s existing `docs/features/<id>.md` (preserve existing history) or a new scoped evidence file.

```markdown
# <ticket> — <name>

Priority: Must. Branch / starting commit: <actual>. Status: <actual>.

## Contract
- Objective:
- Allowed components/files:
- Prerequisites verified:
- Out of scope:
- Assumptions / prior baseline failures:
- Preflight decision and evidence, if required:

## Changes
<Concrete resulting behavior; migrations/flags/adapters and compatibility implications.>

## Acceptance evidence
| Criterion | Actual evidence | Result / limitation |
| --- | --- | --- |
| <criterion> | <command/scenario/path> | <pass/fail/not run> |

## Tests
<Exact commands and results, including skips. Distinguish local/demo/real database/hosted/device.>

## Adversarial review
<Failure cases inspected, actual diff findings and fixes. Independent reviewer evidence where required.>

## Remaining issues
<Required fixes, blocked dependencies, hosted/device proof and why.>

## Handoff
- Commit(s):
- Ready for independent / user review:
- Next ready ticket:
```

Never erase a failed result or mark a required skipped check passed. Record later fixes and reruns as new evidence. No private credentials, real personal data or tokens in committed logs.
