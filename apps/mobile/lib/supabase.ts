/**
 * The app talks to Supabase directly with the public anon key and the user's
 * own session: every rule (who sees what, who may write what, limits) is
 * enforced by RLS and triggers in the database, exactly as for the web app.
 * Configure with EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.
 *
 * On phones the session is kept in the OS keystore (lib/secureStorage.ts);
 * a session an older build left in AsyncStorage is moved there on first read.
 * The web build has no keystore and keeps using AsyncStorage (localStorage).
 */
import "react-native-url-polyfill/auto";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";
import { createChunkedSecureStorage } from "./secureStorage";

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

// Readable after the first unlock so a token refresh in the background still
// works; never copied to another device through backups.
const keystore = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
const authStorage =
  Platform.OS === "web"
    ? AsyncStorage
    : createChunkedSecureStorage(
        {
          getItem: (key) => SecureStore.getItemAsync(key, keystore),
          setItem: (key, value) => SecureStore.setItemAsync(key, value, keystore),
          removeItem: (key) => SecureStore.deleteItemAsync(key, keystore),
        },
        { legacy: AsyncStorage },
      );

/** Null until the two public variables are set (see apps/mobile/README.md). */
export const supabase: SupabaseClient | null =
  url && anonKey
    ? createClient(url, anonKey, {
        auth: {
          storage: authStorage,
          persistSession: true,
          autoRefreshToken: true,
          // Web reads the session from the URL after email links; native does not.
          detectSessionInUrl: Platform.OS === "web",
        },
      })
    : null;

export function requireSupabase(): SupabaseClient {
  if (!supabase) throw new Error("Supabase is not configured: set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY.");
  return supabase;
}
