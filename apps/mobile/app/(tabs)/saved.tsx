import { useCallback, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { Place, SavedList } from "@findmaxxing/shared/types";
import { lists, savedPlaces } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Card, ErrorText, Muted, Screen, Title, s } from "@/components/ui";

/** Your lists and every saved place (owner-only under RLS). */
export default function Saved() {
  const router = useRouter();
  const { userId } = useSession();
  const [data, setData] = useState<{ lists: SavedList[]; places: Place[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    if (!userId) return;
    Promise.all([lists(), savedPlaces(userId)]).then(([l, p]) => setData({ lists: l, places: p }), (e: Error) => setError(e.message));
  }, [userId]));
  return (
    <Screen>
      <ErrorText>{error}</ErrorText>
      <ScrollView contentContainerStyle={{ gap: 8 }}>
        <Title>Lists</Title>
        {data?.lists.length ? data.lists.map((l) => (
          <Card key={l.id}><Text style={s.name}>{l.name}</Text><Text style={s.muted}>{l.placeCount} places</Text></Card>
        )) : <Muted>No lists yet.</Muted>}
        <View style={{ height: 8 }} />
        <Title>Saved places</Title>
        {data?.places.length ? data.places.map((p) => (
          <Card key={p.id} onPress={() => router.push(`/place/${p.id}`)} label={p.name}><Text style={s.name}>{p.name}</Text><Text style={s.muted}>{p.neighborhood ?? p.city}</Text></Card>
        )) : <Muted>Nothing saved yet.</Muted>}
      </ScrollView>
    </Screen>
  );
}
