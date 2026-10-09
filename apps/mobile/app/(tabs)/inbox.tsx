import { useCallback, useState } from "react";
import { ScrollView, Text } from "react-native";
import { useFocusEffect, useRouter } from "expo-router";
import type { AppNotification, ConversationSummary } from "@findmaxxing/shared/types";
import { notificationText } from "@findmaxxing/shared/notifications";
import { conversations, markNotificationsRead, notifications } from "@/lib/api";
import { Card, ErrorText, Muted, Screen, Title, s } from "@/components/ui";

/** Messages (members only) and notifications (owner only), as on the web. */
export default function Inbox() {
  const router = useRouter();
  const [chats, setChats] = useState<ConversationSummary[]>([]);
  const [items, setItems] = useState<AppNotification[]>([]);
  const [error, setError] = useState<string | null>(null);
  useFocusEffect(useCallback(() => {
    Promise.all([conversations(), notifications()]).then(([c, n]) => {
      setChats(c);
      setItems(n);
      if (n.some((x) => !x.readAt)) markNotificationsRead().catch(() => {});
    }, (e: Error) => setError(e.message));
  }, []));
  return (
    <Screen>
      <ErrorText>{error}</ErrorText>
      <ScrollView contentContainerStyle={{ gap: 8 }}>
        <Title>Messages</Title>
        {chats.length ? chats.map((c) => (
          <Card key={c.id} onPress={() => router.push(`/chat/${c.id}`)} label={c.eventTitle ?? c.other?.displayName ?? "Conversation"}>
            <Text style={s.name}>{c.kind === "group" ? (c.eventTitle ?? "Event chat") : (c.other?.displayName ?? "Deleted account")}{c.unread ? ` · ${c.unread} new` : ""}</Text>
            <Text style={s.muted} numberOfLines={1}>{c.lastBody ?? "No messages yet"}</Text>
          </Card>
        )) : <Muted>No conversations yet.</Muted>}
        <Title>Notifications</Title>
        {items.length ? items.map((n) => (
          <Card key={n.id}><Text style={[s.name, { fontWeight: n.readAt ? "400" : "600" }]}>{notificationText({ ...n, actorName: n.actor?.displayName ?? null })}</Text></Card>
        )) : <Muted>Nothing yet.</Muted>}
      </ScrollView>
    </Screen>
  );
}
