export interface ViewState {
  latitude: number;
  longitude: number;
  zoom: number;
}

export interface MapMarker {
  id: string;
  kind: "place" | "event";
  lat: number;
  lng: number;
  color: string;
  emoji: string;
  label: string;
}

export interface LngLat {
  lng: number;
  lat: number;
}
