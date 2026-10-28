import { useState } from "react";
import { Image, ScrollView, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as ImagePicker from "expo-image-picker";
import * as Location from "expo-location";
import { placeSchema } from "@findmaxxing/shared/validation";
import { PLACE_CATEGORIES } from "@findmaxxing/shared/taxonomy";
import { createPlace, uploadPlacePhoto } from "@/lib/api";
import { useSession } from "@/lib/session";
import { Button, ErrorText, Field, Muted, colors } from "@/components/ui";

/**
 * Add a place where you stand, with a photo from the camera. Validated with
 * the same schema as the web form; the database checks it all again
 * (create_place_with_details: rate limit, suspension, photo ownership).
 */
export default function AddPlace() {
  const router = useRouter();
  const { userId } = useSession();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [localTip, setLocalTip] = useState("");
  const [city, setCity] = useState("Columbus");
  const [category, setCategory] = useState(PLACE_CATEGORIES[0].slug);
  const [photo, setPhoto] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const takePhoto = async () => {
    const perm = await ImagePicker.requestCameraPermissionsAsync();
    const result = perm.granted
      ? await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: true, aspect: [4, 3] })
      : await ImagePicker.launchImageLibraryAsync({ quality: 0.6, mediaTypes: ["images"] });
    if (!result.canceled) setPhoto(result.assets[0].uri);
  };

  const submit = async () => {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (!perm.granted) throw new Error("Allow location to pin the place where you are.");
      const here = await Location.getCurrentPositionAsync({});
      const parsed = placeSchema.safeParse({ name, description, localTip, categorySlug: category, lat: here.coords.latitude, lng: here.coords.longitude, city, tags: [], visibility: "public" });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "Check the form");
      const photos = photo ? [await uploadPlacePhoto(userId, photo)] : [];
      const id = await createPlace({ ...parsed.data, localTip: parsed.data.localTip ?? null, neighborhood: parsed.data.neighborhood ?? null, photos });
      router.replace(`/place/${id}`);
    } catch (e) {
      setError(/rate_limited/.test(String(e)) ? "Too many places for now. Try again later." : (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ScrollView contentContainerStyle={{ padding: 16, gap: 12, backgroundColor: colors.paper }}>
      <Field label="Name" value={name} onChangeText={setName} maxLength={80} />
      <Field label="What makes it good" value={description} onChangeText={setDescription} multiline maxLength={1000} />
      <Field label="Local tip (optional)" value={localTip} onChangeText={setLocalTip} maxLength={280} />
      <Field label="City" value={city} onChangeText={setCity} maxLength={80} />
      <Text style={{ fontWeight: "600" }}>Category</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
        {PLACE_CATEGORIES.map((c) => (
          <View key={c.slug}><Button title={`${c.emoji} ${c.label}`} variant={c.slug === category ? "ink" : "plain"} onPress={() => setCategory(c.slug)} /></View>
        ))}
      </View>
      {photo ? <Image source={{ uri: photo }} style={{ height: 180, borderRadius: 12 }} accessibilityLabel="The photo you took" /> : null}
      <Button title={photo ? "Retake photo" : "Take a photo"} variant="plain" onPress={takePhoto} />
      <Muted>It is pinned where you are standing, and public.</Muted>
      <ErrorText>{error}</ErrorText>
      <Button title="Add place" variant="flare" onPress={submit} loading={busy} />
    </ScrollView>
  );
}
