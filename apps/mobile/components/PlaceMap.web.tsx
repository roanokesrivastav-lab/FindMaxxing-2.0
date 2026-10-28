/** react-native-maps has no web renderer: the web build shows the list only (the full map is the web app's). */
import { Text, View } from "react-native";
import type { Place } from "@findmaxxing/shared/types";
import type { Bounds } from "@/lib/api";
import { colors } from "./ui";

export function PlaceMap({ places }: { places: Place[]; region: unknown; onRegionChange: (b: Bounds) => void; onSelect: (id: string) => void }) {
  return (
    <View style={{ padding: 12, borderRadius: 16, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line }}>
      <Text style={{ color: colors.muted }}>The map is in the iOS and Android apps. {places.length} places in this area below.</Text>
    </View>
  );
}
