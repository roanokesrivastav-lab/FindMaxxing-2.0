import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text } from "react-native";
import { useLocalSearchParams } from "expo-router";
import type { Event } from "@findmaxxing/shared/types";
import { event as loadEvent, join, leave } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button, ErrorText, Muted, Screen, Title, s } from "@/components/ui";

const WHEN = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });

/** An event with join and leave. Capacity, "not ended" and tickets are enforced by the database. */
export default function EventScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();
  const [e, setE] = useState<(Event & { going: boolean }) | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => loadEvent(id).then(setE, () => setE(null)), [id]);
  useEffect(() => {
    load();
  }, [load]);
  if (e === undefined) return <Screen><Muted>Loading…</Muted></Screen>;
  if (!e) return <Screen><Title>Not found</Title><Muted>This event doesn't exist, or it isn't shared with you.</Muted></Screen>;
  const toggle = async () => {
    if (!userId) return;
    setBusy(true);
    try {
      await (e.going ? leave(e.id, userId) : join(e.id, userId));
      setError(null);
      await load();
    } catch (err) {
      setError(/ticket/.test(String(err)) ? "This event needs a ticket: buy one on the website." : /full/.test(String(err)) ? "This event is full." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Muted>{WHEN.format(new Date(e.startsAt))}</Muted>
      <Title>{e.title}</Title>
      <Text style={s.muted}>{e.locationName}{e.placeName ? ` · ${e.placeName}` : ""}</Text>
      <Text style={s.muted}>{e.description}</Text>
      <Muted>{e.attendeeCount} going{e.capacity ? ` · ${Math.max(0, e.capacity - e.attendeeCount)} spots left` : ""}</Muted>
      {e.status === "published" && e.creatorId !== userId ? <Button title={e.going ? "Leave" : "Join"} variant={e.going ? "plain" : "ink"} loading={busy} onPress={toggle} /> : null}
      <ErrorText>{error}</ErrorText>
    </ScrollView>
  );
}
