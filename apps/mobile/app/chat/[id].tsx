import { useCallback, useEffect, useState } from "react";
import { FlatList, Text, View } from "react-native";
import { useLocalSearchParams } from "expo-router";
import { MAX_MESSAGE_LENGTH } from "@/lib/limits";
import { markRead, messages, sendMessage } from "@/lib/api";
import { useSession } from "@/lib/session";
import { supabase } from "@/lib/supabase";
import { Button, ErrorText, Field, Screen, colors } from "@/components/ui";

type Msg = Awaited<ReturnType<typeof messages>>[number];

/** A conversation, members only (RLS). Live through Supabase Realtime, like the web app. */
export default function Chat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId } = useSession();
  const [list, setList] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(() => messages(id).then((m) => { setList(m); markRead(id).catch(() => {}); }, (e: Error) => setError(e.message)), [id]);
  useEffect(() => {
    refresh();
    const channel = supabase?.channel(`messages:${id}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages", filter: `conversation_id=eq.${id}` }, () => void refresh())
      .subscribe();
    return () => {
      if (channel) void supabase?.removeChannel(channel);
    };
  }, [id, refresh]);
  const send = async () => {
    if (!userId || !draft.trim()) return;
    try {
      await sendMessage(id, userId, draft);
      setDraft("");
      await refresh();
    } catch (e) {
      setError(/blocked/.test(String(e)) ? "You can't message each other." : /rate_limited/.test(String(e)) ? "Too many messages for now." : (e as Error).message);
    }
  };
  return (
    <Screen>
      <FlatList
        data={list}
        keyExtractor={(m) => m.id}
        renderItem={({ item }) => {
          const own = item.senderId === userId;
          return (
            <View style={{ alignSelf: own ? "flex-end" : "flex-start", maxWidth: "80%", marginVertical: 3, padding: 10, borderRadius: 16, backgroundColor: own ? colors.ink : colors.surface, borderWidth: own ? 0 : 1, borderColor: colors.line }}>
              <Text style={{ color: own ? "#fff" : colors.ink, fontSize: 15 }}>{item.body}</Text>
            </View>
          );
        }}
      />
      <ErrorText>{error}</ErrorText>
      <Field label="Message" value={draft} onChangeText={setDraft} maxLength={MAX_MESSAGE_LENGTH} multiline />
      <Button title="Send" onPress={send} disabled={!draft.trim()} />
    </Screen>
  );
}
