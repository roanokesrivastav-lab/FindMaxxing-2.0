/**
 * Push on phones: asks for permission once signed in, gets the Expo push
 * token, and stores it in push_subscriptions (kind 'expo'). From there the
 * Session 16 scheduler treats it like any device: per-type preferences, quiet
 * hours, at most five a day, never sent twice.
 *
 * Signing out goes through signOutAndForgetDevice, which removes the token
 * from the server and unregisters the device before the session ends
 * (lib/pushLifecycle.ts), so a signed-out phone stops receiving pushes.
 */
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { removePushToken, savePushToken } from "./api";
import { createPushLifecycle } from "./pushLifecycle";
import { requireSupabase } from "./supabase";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

const TOKEN_KEY = "findmaxxing.expo-push-token";
const pushCapable = () => Platform.OS !== "web" && Device.isDevice; // the web app has its own (web push)
const projectId = () => Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
const expoToken = async () => (await Notifications.getExpoPushTokenAsync(projectId() ? { projectId: projectId() } : undefined)).data;

const lifecycle = createPushLifecycle({
  async obtainToken() {
    if (!pushCapable()) return null;
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", { name: "Default", importance: Notifications.AndroidImportance.DEFAULT });
    }
    const current = await Notifications.getPermissionsAsync();
    const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
    return granted ? expoToken() : null;
  },
  async currentToken() {
    if (!pushCapable()) return null;
    const stored = await SecureStore.getItemAsync(TOKEN_KEY);
    if (stored) return stored;
    // Registered by a build from before the token was remembered: ask again, without prompting.
    return (await Notifications.getPermissionsAsync()).granted ? expoToken() : null;
  },
  saveServerToken: savePushToken,
  removeServerToken: removePushToken,
  unregisterDevice: () => Notifications.unregisterForNotificationsAsync(),
  rememberToken: (token) => SecureStore.setItemAsync(TOKEN_KEY, token),
  forgetToken: () => SecureStore.deleteItemAsync(TOKEN_KEY),
  async signOut() {
    const auth = requireSupabase().auth;
    // Offline, revoking on the server fails and supabase-js keeps the session; end it here regardless.
    if ((await auth.signOut()).error) {
      const { error } = await auth.signOut({ scope: "local" });
      if (error) throw error;
    }
  },
});

export const registerForPush = lifecycle.register;
export const signOutAndForgetDevice = lifecycle.signOut;
