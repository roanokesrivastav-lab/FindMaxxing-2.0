/** Native map (react-native-maps); the web build uses PlaceMap.web.tsx. */
import MapView, { Marker, type Region } from "react-native-maps";
import type { Place } from "@findmaxxing/shared/types";
import type { Bounds } from "@/lib/api";

export function PlaceMap({ places, region, onRegionChange, onSelect }: { places: Place[]; region: Region; onRegionChange: (b: Bounds) => void; onSelect: (id: string) => void }) {
  return (
    <MapView
      style={{ flex: 1, minHeight: 260, borderRadius: 16 }}
      initialRegion={region}
      showsUserLocation
      onRegionChangeComplete={(r) => onRegionChange({ north: r.latitude + r.latitudeDelta / 2, south: r.latitude - r.latitudeDelta / 2, east: r.longitude + r.longitudeDelta / 2, west: r.longitude - r.longitudeDelta / 2 })}
    >
      {places.map((p) => (
        <Marker key={p.id} coordinate={{ latitude: p.lat, longitude: p.lng }} title={p.name} description={p.neighborhood ?? p.city} onCalloutPress={() => onSelect(p.id)} />
      ))}
    </MapView>
  );
}
