import { useState } from "react";
import { ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import { EVENT_CATEGORIES } from "@findmaxxing/shared/taxonomy";
import { createEvent } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button, ErrorText, Field, colors } from "@/components/ui";

/** Create an event where you are, starting in a chosen number of hours. You attend it. */
export default function NewEvent() {
  const router = useRouter();
  const { userId } = useSession();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [locationName, setLocationName] = useState("");
  const [inHours, setInHours] = useState("24");
  const [capacity, setCapacity] = useState("");
  const [category, setCategory] = useState(EVENT_CATEGORIES[0].slug);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      if (title.trim().length < 3 || description.trim().length < 10 || locationName.trim().length < 2) throw new Error("Add a title, a description (10+ characters) and where it is.");
      const hours = Number(inHours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 90) throw new Error("Choose when it starts.");
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) throw new Error("Allow location to pin the event where you are.");
      const here = await Location.getCurrentPositionAsync({});
      const id = await createEvent(userId, {
        title: title.trim(), description: description.trim(), locationName: locationName.trim(), lat: here.coords.latitude, lng: here.coords.longitude,
        startsAt: new Date(Date.now() + hours * 3600_000).toISOString(), categorySlug: category, capacity: capacity ? Number(capacity) : null, tags: [],
      });
      router.replace(`/event/${id}`);
    } catch (e) {
      setError(/rate_limited/.test(String(e)) ? "Too many events for now. Try again later." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, backgroundColor: colors.paper }}>
      <Field label="Title" value={title} onChangeText={setTitle} maxLength={90} />
      <Field label="Description" value={description} onChangeText={setDescription} multiline maxLength={1200} />
      <Field label="Where" value={locationName} onChangeText={setLocationName} maxLength={120} />
      <Field label="Starts in (hours)" value={inHours} onChangeText={setInHours} keyboardType="number-pad" />
      <Field label="Capacity (optional)" value={capacity} onChangeText={setCapacity} keyboardType="number-pad" />
      <Text style={{ fontWeight: "600" }}>Category</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {EVENT_CATEGORIES.map((c) => (
          <View key={c.slug}><Button title={`${c.emoji} ${c.label}`} variant={c.slug === category ? "ink" : "plain"} onPress={() => setCategory(c.slug)} /></View>
        ))}
      </View>
      <ErrorText>{error}</ErrorText>
      <Button title="Create event" variant="flare" onPress={submit} loading={busy} />
    </ScrollView>
  );
}
