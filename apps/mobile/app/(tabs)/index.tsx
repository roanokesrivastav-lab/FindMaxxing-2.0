import { useCallback, useEffect, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useRouter } from "expo-router";
import * as Location from "expo-location";
import type { Place } from "@findmaxxing/shared/types";
import { getCategory } from "@findmaxxing/shared/taxonomy";
import { placesIn, type Bounds } from "@/lib/api";
import { PlaceMap } from "@/components/PlaceMap";
import { Button, Card, ErrorText, Muted, Screen, s } from "@/components/ui";

const COLUMBUS = { latitude: 39.9686, longitude: -83.0037, latitudeDelta: 0.12, longitudeDelta: 0.12 };
const boundsOf = (r: typeof COLUMBUS): Bounds => ({ north: r.latitude + r.latitudeDelta / 2, south: r.latitude - r.latitudeDelta / 2, east: r.longitude + r.longitudeDelta / 2, west: r.longitude - r.longitudeDelta / 2 });

/** The map and the places in view: only what this person may see (discover_places under RLS). */
export default function Explore() {
  const router = useRouter();
  const [region, setRegion] = useState(COLUMBUS);
  const [bounds, setBounds] = useState<Bounds>(boundsOf(COLUMBUS));
  const [places, setPlaces] = useState<Place[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Location.getForegroundPermissionsAsync().then(async (p) => {
      if (!p.granted) return;
      const here = await Location.getLastKnownPositionAsync();
      if (here) {
        const r = { ...COLUMBUS, latitude: here.coords.latitude, longitude: here.coords.longitude };
        setRegion(r);
        setBounds(boundsOf(r));
      }
    }).catch(() => {});
  }, []);
  const load = useCallback(() => {
    placesIn(bounds).then((p) => { setPlaces(p); setError(null); }, (e: Error) => setError(e.message));
  }, [bounds]);
  useEffect(load, [load]);
  return (
    <Screen>
      <View style={{ height: 280 }}>
        <PlaceMap places={places} region={region} onRegionChange={setBounds} onSelect={(id) => router.push(`/place/${id}`)} />
      </View>
      <ErrorText>{error}</ErrorText>
      <FlatList
        data={places}
        keyExtractor={(p) => p.id}
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        ListEmptyComponent={<Muted>No places in this area yet.</Muted>}
        ListHeaderComponent={<View style={{ marginBottom: 8 }}><Button title="Add a place" variant="flare" onPress={() => router.push("/add-place")} /></View>}
        renderItem={({ item }) => (
          <Card onPress={() => router.push(`/place/${item.id}`)} label={item.name}>
            <Text style={s.muted}>{getCategory(item.categorySlug).emoji} {getCategory(item.categorySlug).label} · {item.neighborhood ?? item.city}</Text>
            <Text style={s.name}>{item.name}</Text>
            {item.ratingCount ? <Text style={s.muted}>★ {item.ratingAvg.toFixed(1)} ({item.ratingCount})</Text> : null}
          </Card>
        )}
      />
    </Screen>
  );
}
