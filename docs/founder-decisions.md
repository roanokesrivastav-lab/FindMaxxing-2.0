# Founder decisions

Decisions from the founder session recorded 2026-11-02, plus the owner's answers to the open questions
recorded 2026-11-05. These override `docs/roadmap-80.md` wherever the two disagree. The roadmap tickets
were rewritten to match on 2026-11-04 and unblocked on 2026-11-05.

## Decided

| Topic | Decision | Roadmap tickets affected |
| --- | --- | --- |
| Overall look | Mix of Local editorial and Quiet utility, used in separate scenarios. The current Social journal structure is scrapped. | 1.1 |
| Events tab | Quiet utility. The main tab for events you usually go to or have signed up for. | 1.5 |
| Event detail | Opening an event shows the Local editorial treatment. | 4.1 |
| Explore map | No list on the same tab as the map. Filter tabs such as "15 min away" and "Has room" stay. | 2.3 is dropped as written (it replaces separate modes with a panel); 2.2, 2.4a |
| Place page | Photo first. Scroll down for more information. | 2.5 (reverses "photos follow") |
| Event card | Hosts can toggle a Party poster on events it suits. Everything else uses the Readiness row. Calendar date block rejected as too lifeless. | 4.1, 4.3, 1.1 (DateBlock primitive) |
| Group outing vote | Pushed until after events. Friends can discuss plans among themselves for now. | M5, 6.3, 8.1c–d, milestone journey, scoreboard |
| Cards and elevation | Role-based surfaces. | 1.1 |
| Social context line | On hold. Neither option looked good; both are visually boring. | 1.4 |
| Personality | Photography-led. | 1.1, 2.5 |
| Mapstr | Implement: save first and suggest tags later, separate what it is from why you saved it, keep who recommended it, "Pick somewhere from my saves", bulk edit, undo, export. | 3.1, 3.2, new ticket for the picker |
| Yelp | Implement: rating next to its count, relevant recent observation, separate personal fit, friends and community, claims open their evidence, sponsored kept separate. | 2.5, 2.6 |
| Friends' reviews | No summaries of friends' reviews. Show the actual reviews when you open a place, the way Beli does. | 2.5, 2.7 |

### Owner answers, 2026-11-05 (formerly open questions)

| Topic | Decision | Roadmap tickets affected |
| --- | --- | --- |
| Competitor research "For us" notes | All accepted for now, to be judged once implemented. Where one conflicts with an earlier decision, the earlier decision wins: **no list or bottom panel on the map tab (selected-pin preview only), no summaries of friends' opinions, no friend match scores.** The research document itself is not in this repository, so individual notes are applied as their tickets are built. | All; 2.1, 2.2 (map tab) |
| Onboarding interest picker (was Q1) | Thumbnail rows, six interests, "More interests", Skip. | 1.2, 1.3 |
| Group outing scope (was Q2) | "Push off" means **order**: all of M5 stays and is built after M4. The walking plan and the milestone journey stay. | M5, 6.3, 6.4, 8.1c–e, 8.2, 8.3, milestone journey, checkpoint 2, scoreboard |
| Photo source (was Q3) | Public photos for the pilot are uploaded by the team or with permission. The provider is decided after the 3.3 spec. | 2.8, 3.3 |
| Photo requirement (was Q4) | A private photo is required only for a user's **first rating or review** of a place. It never blocks saving, planning, joining, or bulk marking Visited. Self-declared: no proof of attendance. Library photos are allowed. | 2.8 |
| Friend-triggered photos (was Q5) | If only a friend went: show the public photo plus the friend's own review and the photos they chose to post. Private photos are never shared. | 2.8 |
| Best for / less suited (was Q6) | Stays, written and attributed by contributors. | 2.7, 2.5 |
| Yelp vs no-summaries (was Q7) | No summaries of friends' opinions (confirmed by the conflict rule above). | 2.5 |
| Friends' reviews order (was Q8, in part) | Friends' actual reviews appear **first** on a place, then others. The owner still has to check Beli's page; this does not block building. | 2.5 |
| Social context line | Stays on hold. | 1.4 |
| 4.0 spec | All recommendations D-A to D-M in `docs/features/4.0.md` are accepted. | 4.0, 4.2–4.6, 4.8, 8.1b |
| Routing provider | Tentatively Mapbox walking, behind the adapter. Not live until keys are added. | 6.0, 6.1 |

## Public and private place photos (decided 2026-11-05)

- Every place has a **public photo**. For the pilot it is uploaded by the team or with permission; an
  online provider is chosen after the 3.3 spec.
- A user's **first rating or review** of a place requires one photo. It becomes their **private photo**,
  and they always see it unless they choose to change it. It is self-declared (no proof of attendance),
  and a photo from the library is allowed. It never blocks saving, planning, joining, or bulk marking
  Visited.
- If only a friend went, you see the public photo plus that friend's own review and the photos they
  chose to post. Private photos are never shared.
- Naming note: "private place photos" already exists in the code with a different meaning (uploads
  whose visibility follows the place; see `docs/feature-status.md`). Ticket 2.8 must not reuse that name.

## Activity filter default (decided 2026-11-11)

- Ticket **2.4b** defaults to **Has room** as its availability filter, not **Needs players**.

## Shared founder feature priorities (decided 2026-11-11)

The founders answered today’s questionnaire together. Ronak’s supplied choices represent all three founders; do not require separate ballots. **Must for everything except these Later items:**

| Ticket | Later feature |
| --- | --- |
| 1.4 | Social context line |
| 2.2 | Selection and camera restore |
| 2.6 | Tip provenance and freshness |
| 3.4a | Parse pasted Notes |
| 3.4b | Confirm private imports |
| 3.5 | Single-link importer |
| 4.4 | Waitlist and expiring offers |
| 7.3 | Optional post-visit action |
| R2 | Opt-in need-players alerts |
| R3 | Lightweight clubs |
| X1–X4 | All deferred 20-point categories |

No Cut choices were supplied. All other rows of today’s 57-row questionnaire are Must, including **R4 weekly outing memories**, existing foundations/specs, native parity and release work. Priority does not mean implemented or verified. Earlier rejected directions (such as 2.3’s map-plus-list panel) remain rejected; they were not questionnaire rows.

Full decisions: [founder-priorities-2026-11-11.json](founder-priorities-2026-11-11.json). Proposed implementation sequence, dependency reductions and Fable prompts: [proposed-roadmap-2026-11-11.md](proposed-roadmap-2026-11-11.md). Keep Must work independent of Later features; revised high-risk contracts still need Codex preflight. Native 8.1b is Must for safe admission/RPC compatibility, while its waitlist/offer UI follows deferred 4.4.

## Still open

- **Beli reference:** the owner still has to check Beli's place page. Building proceeds on "friends'
  actual reviews first, then others".
- **Public photo provider:** decided after the 3.3 spec.
- **Feature pass:** completed as the shared 2026-11-11 questionnaire decision above; no longer an open question.
