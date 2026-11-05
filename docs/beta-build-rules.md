# Beta build rules

Rules for building the roadmap toward the 80% beta (owner instruction, 2026-11-05).

- Base is tier1-owner-controls. Own branch, one commit per ticket, push after each. Never merge or deploy.
- Follow the preamble in docs/roadmap-80.md section 2. docs/founder-decisions.md overrides the roadmap.
- The owner has green-lit building in roadmap order and cannot be asked questions during a run. Take a spec's recommended option and record it. Add a dependency only if there is no reasonable alternative, pinned exactly and noted in the ticket doc.
- Out of scope: X1 paid curators, X2 broader imports, X3 multi-city and non-walking routes, X4 richer taste matching. Paid events: build nothing new, but do not remove or break existing paid flows; their tests must still pass.
- No real external calls and no keys. Use deterministic fakes behind adapters, and state plainly what is not live.
- New features stay behind pilot flags and on in demo configuration, so the owner can see them in demo mode.
- Run npm run check before committing each ticket. Write docs/features/<ticket>.md with changes, test results, and what you could not verify.
- Roadmap section 3 areas need their required proof. If a required test cannot run, mark the ticket NOT VERIFIED and do not build tickets that depend on it.
- If a ticket is blocked, record why and continue with the next ticket that does not depend on it. Never mark unverified work done.
- Migration blocks, to avoid collisions: 0041 reserved for 0.1b; Core 0042-0049; Events 0050-0059; Places 0060-0069; Map 0070-0074; Local 0075-0079; Imports 0080-0084; Outings 0085-0094; Trips 0095-0099. If tooling requires contiguous numbers, stop and report.
