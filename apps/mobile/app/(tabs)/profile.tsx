import { useEffect, useState } from "react";
import { Text } from "react-native";
import { profile } from "@/lib/api";
import { useSession } from "@/lib/session";
import { requireSupabase } from "@/lib/supabase";
import { Button, Card, Muted, Screen, Title, s } from "@/components/ui";

export default function Profile() {
  const { userId } = useSession();
  const [me, setMe] = useState<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (userId) profile(userId).then(setMe, () => {});
  }, [userId]);
  return (
    <Screen>
      <Title>{(me?.display_name as string) ?? "You"}</Title>
      <Muted>@{(me?.username as string) ?? ""}{me?.supporter ? " · Supporter" : ""}</Muted>
      {me?.bio ? <Card><Text style={s.muted}>{me.bio as string}</Text></Card> : null}
      <Muted>Edit your profile, settings, tickets and Plus on the website.</Muted>
      <Button title="Sign out" variant="plain" onPress={() => requireSupabase().auth.signOut()} />
    </Screen>
  );
}
