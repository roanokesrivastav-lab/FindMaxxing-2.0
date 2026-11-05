// Run in a child process with a given TZ: prints what the server would render
// for a fixed clock/zone snapshot. Output must not depend on the process TZ.
import { renderToString } from "react-dom/server";
import { ViewerTimeProvider } from "../../src/components/time/ViewerTime";
import { EventCard } from "../../src/components/events/EventCard";
import { LocalDate } from "../../src/components/time/LocalDate";
import { formatEventWhen, relativeDayLabel, toDateInputValue, toTimeInputValue } from "../../src/lib/utils/format";
import type { Event } from "../../src/lib/data/types";

const snapshot = { timeZone: "America/New_York", now: Date.parse("2026-10-22T03:30:00Z") };
const event = {
  id: "e1",
  title: "Late show",
  categorySlug: "music",
  description: "",
  startsAt: "2026-10-22T23:24:00Z",
  endsAt: "2026-10-23T01:00:00Z",
  locationName: "Somewhere",
  status: "published",
  capacity: null,
  attendeeCount: 3,
} as unknown as Event;

const html = renderToString(
  <ViewerTimeProvider initial={snapshot}>
    <EventCard event={event} />
    <LocalDate value={event.startsAt} format={{ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }} zone />
  </ViewerTimeProvider>,
);

process.stdout.write(
  JSON.stringify({
    html,
    when: formatEventWhen(event.startsAt, event.endsAt, snapshot),
    day: relativeDayLabel(event.startsAt, snapshot),
    input: [toDateInputValue(Date.parse(event.startsAt), snapshot), toTimeInputValue(Date.parse(event.startsAt), snapshot)],
  }),
);
