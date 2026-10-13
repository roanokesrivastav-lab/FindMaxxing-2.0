## vexp - Context-Aware AI Coding <!-- vexp v3.3.3 -->

### Context strategy: call run_pipeline ONCE at task start
If the task already names the files/symbols to touch, SKIP vexp. Otherwise one
`run_pipeline({ "task": "..." })` returns ranked pivot files with line ranges and
blast radius. Do NOT open files one by one to find your way around - every extra
tool call costs a turn. Call it again ONLY when the task moves to a new area.
`get_skeleton` for files to understand, not edit. `verify_done` before calling a
multi-file task complete, then RUN the tests it names.

### Query shape (do this)
Anchor the task on real identifiers (ClassName, functionName) or file paths:
`run_pipeline({ "task": "fix JWT expiry in AuthService.validateToken" })`

vexp runs entirely on this machine, index in `.vexp/`;
`run_pipeline` transmits nothing to any external service.
On `status: "degraded"` or 0 pivots the index is still building - use your own tools.
For literal string sweeps use your native search - do NOT route text sweeps through vexp.
Repo SOURCE only: logs, dist/, node_modules/ and files outside the repo are NOT indexed.
<!-- /vexp -->

## Codex preflight and verification protocol

Before an external coding agent starts:

1. Read the confirmed task and Claude's implementation brief.
2. Check whether the scope, files, acceptance criteria, and test plan are clear.
3. Identify hidden risks, missing requirements, edge cases, and likely regressions.
4. Do not rewrite the plan unnecessarily. Return one of:
   - Approved
   - Approved with required changes
   - Blocked pending user input
5. If approved, produce a concise handoff contract containing:
   - Objective
   - Allowed scope
   - Files or components likely involved
   - Acceptance criteria
   - Required tests
   - Things the implementer must not change

Claude's implementation brief must include the coding prompt, acceptance criteria, and test cases. Codex audits these before implementation and verifies them afterward. Claude is responsible for specification, external agents for execution, and Codex for independent judgment, testing, integration, and risk detection.

After implementation:

1. Inspect the diff and relevant surrounding code.
2. Run or review the appropriate tests.
3. Check the implementation against every acceptance criterion.
4. Look for regressions, incomplete error handling, security issues, and unnecessary scope expansion.
5. Return:
   - What changed
   - What was verified
   - Problems found
   - Required fixes
   - Whether it is ready for user review

For high-risk or ambiguous changes, perform a separate adversarial audit:

- Assume the implementation contains a subtle defect.
- Search specifically for failure cases, permission mistakes, data loss, race conditions, and untested assumptions.
- Do not approve based only on the implementer's summary.

Use `/plan` for unclear or multi-system work, `/review` for completed changes, `/goal` for multi-turn outcomes, `/compact` after a major milestone, and a side chat for explanations that should not pollute the main implementation thread.
