import { useEffect, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useRouter } from "expo-router";
import type { Event } from "@findmaxxing/shared/types";
import { upcomingEvents } from "@/lib/api";
import { Button, Card, ErrorText, Muted, Screen, s } from "@/components/ui";

const WHEN = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

export default function Events() {
  const router = useRouter();
  const [events, setEvents] = useState<Event[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    upcomingEvents().then(setEvents, (e: Error) => setError(e.message));
  }, []);
  return (
    <Screen>
      <Button title="Create an event" variant="flare" onPress={() => router.push("/new-event")} />
      <ErrorText>{error}</ErrorText>
      <FlatList
        data={events}
        keyExtractor={(e) => e.id}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={<Muted>No upcoming events.</Muted>}
        renderItem={({ item }) => (
          <Card onPress={() => router.push(`/event/${item.id}`)} label={item.title}>
            <Text style={s.muted}>{WHEN.format(new Date(item.startsAt))}</Text>
            <Text style={s.name}>{item.title}</Text>
            <Text style={s.muted}>{item.locationName} · {item.attendeeCount} going</Text>
          </Card>
        )}
      />
    </Screen>
  );
}
