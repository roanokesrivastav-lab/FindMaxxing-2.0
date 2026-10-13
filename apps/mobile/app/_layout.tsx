import { useEffect } from "react";
import { Stack, useRouter, useSegments } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { SessionProvider, useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import { registerForPush } from "@/lib/push";
import { Muted, Screen, Title, colors } from "@/components/ui";

/** Signed out: only the sign-in screen. Signed in: the tabs, and push is offered. */
function Gate() {
  const { session, loading } = useSession();
  const segments = useSegments();
  const router = useRouter();
  useEffect(() => {
    if (loading) return;
    const onSignIn = segments[0] === "sign-in";
    if (!session && !onSignIn) router.replace("/sign-in");
    if (session && onSignIn) router.replace("/");
  }, [session, loading, segments, router]);
  useEffect(() => {
    if (session) registerForPush().catch(() => {});
  }, [session]);
  return (
    <Stack screenOptions={{ headerTintColor: colors.ink, headerStyle: { backgroundColor: colors.paper }, contentStyle: { backgroundColor: colors.paper } }}>
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="sign-in" options={{ title: "Sign in", headerShown: false }} />
      <Stack.Screen name="place/[id]" options={{ title: "Place" }} />
      <Stack.Screen name="event/[id]" options={{ title: "Event" }} />
      <Stack.Screen name="chat/[id]" options={{ title: "Conversation" }} />
      <Stack.Screen name="add-place" options={{ title: "Add a place", presentation: "modal" }} />
      <Stack.Screen name="new-event" options={{ title: "New event", presentation: "modal" }} />
    </Stack>
  );
}

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <StatusBar style="dark" />
      {supabase ? (
        <SessionProvider>
          <Gate />
        </SessionProvider>
      ) : (
        <Screen style={{ justifyContent: "center" }}>
          <Title>FindMaxxing</Title>
          <Muted>This build has no backend configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY (see apps/mobile/README.md) and restart.</Muted>
          <Text accessibilityRole="text" style={{ color: colors.muted, marginTop: 8 }}>The app uses the same Supabase project as the web app, with the public anon key only.</Text>
        </Screen>
      )}
    </SafeAreaProvider>
  );
}
