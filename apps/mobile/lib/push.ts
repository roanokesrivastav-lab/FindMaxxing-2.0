/**
 * Push on phones: asks for permission once signed in, gets the Expo push
 * token, and stores it in push_subscriptions (kind 'expo'). From there the
 * Session 16 scheduler treats it like any device: per-type preferences, quiet
 * hours, at most five a day, never sent twice.
 */
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import Constants from "expo-constants";
import { Platform } from "react-native";
import { savePushToken } from "./api";

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: false, shouldSetBadge: false }),
});

export async function registerForPush(): Promise<string | null> {
  if (Platform.OS === "web" || !Device.isDevice) return null; // the web app has its own (web push)
  if (Platform.OS === "android") {
    await Notifications.setNotificationChannelAsync("default", { name: "Default", importance: Notifications.AndroidImportance.DEFAULT });
  }
  const current = await Notifications.getPermissionsAsync();
  const granted = current.granted || (await Notifications.requestPermissionsAsync()).granted;
  if (!granted) return null;
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const { data: token } = await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined);
  await savePushToken(token);
  return token;
}
