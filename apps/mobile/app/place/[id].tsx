import { useEffect, useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import type { Place, SavedList } from "@findmaxxing/shared/types";
import { getCategory, getInterest } from "@findmaxxing/shared/taxonomy";
import { addToList, lists, place as loadPlace, save } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button, Card, ErrorText, Muted, Screen, Title, s } from "@/components/ui";

/** A place, if this person may see it (RLS), with save and save-to-list. */
export default function PlaceScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();
  const [p, setP] = useState<Place | null | undefined>(undefined);
  const [myLists, setMyLists] = useState<SavedList[]>([]);
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    loadPlace(id).then(setP, () => setP(null));
    lists().then(setMyLists, () => {});
  }, [id]);
  if (p === undefined) return <Screen><Muted>Loading…</Muted></Screen>;
  if (!p) return <Screen><Title>Not found</Title><Muted>This place doesn't exist, or it isn't shared with you.</Muted></Screen>;
  const run = (fn: () => Promise<unknown>, done: string) => fn().then(() => setNote(done), (e: Error) => setNote(e.message));
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12 }}>
      <Muted>{getCategory(p.categorySlug).emoji} {getCategory(p.categorySlug).label} · {p.neighborhood ?? p.city}</Muted>
      <Title>{p.name}</Title>
      <Text style={s.muted}>{p.description}</Text>
      {p.localTip ? <Card><Text style={s.label}>Local tip</Text><Text style={s.muted}>{p.localTip}</Text></Card> : null}
      <Muted>{p.tags.map((t) => getInterest(t).label).join(" · ")}</Muted>
      {userId ? <Button title="Save" onPress={() => run(() => save(p.id, userId), "Saved")} /> : null}
      {myLists.map((l) => (
        <View key={l.id}><Button title={`Add to ${l.name}`} variant="plain" onPress={() => run(() => addToList(l.id, p.id), `Added to ${l.name}`)} /></View>
      ))}
      <ErrorText>{note && !/^(Saved|Added)/.test(note) ? note : null}</ErrorText>
      {note && /^(Saved|Added)/.test(note) ? <Text accessibilityLiveRegion="polite" style={s.label}>{note}</Text> : null}
    </ScrollView>
  );
}
