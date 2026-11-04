# Founder decisions

Decisions from the founder session, recorded 2026-11-02. These override `docs/roadmap-80.md` wherever the two
disagree. The roadmap tickets have not been rewritten yet. The session isn't finished: the references after Yelp and
The Infatuation, and the feature pass, are still to come.

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

## New idea: public and private place photos

- Every place has a **public photo** pulled from online.
- The first time you go to a place (or a friend has gone), you must take one photo. It becomes your **private photo**,
  and you always see it unless you choose to change it.

## Open questions

1. **Onboarding interest picker:** not decided in this pass.
2. **Group outing scope:** does "push off" cover only the vote (5.3), or all of M5? Itinerary 6.3 depends on 5.3 and
   5.5, so the walking plan moves too unless it gets a new entry point. The milestone journey and the 12 outing points
   need rewriting either way.
3. **Photo source:** where do public photos come from, and do its terms let us store and display them?
4. **Photo requirement:** what does "required" block, and how do we know someone went? An RSVP or directions tap
   doesn't prove attendance.
5. **Friend-triggered photos:** when a friend went but you didn't, whose photo do you see, and did the friend agree to
   share it?
6. **Best for / less suited (2.7):** keep it as contributor-written advice, or drop it along with friend summaries?
7. **Yelp conflict:** the research example "Two friends recommend it for quiet conversation" is a summary of friends'
   opinions. The no-summaries decision is treated as winning.
8. **Beli reference:** the research didn't document Beli's place page. Check the app before writing the ticket.

## Still to review

Atlas Obscura onward in the reference list, and the full feature pass.
