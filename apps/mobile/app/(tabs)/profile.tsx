import { useEffect, useState } from "react";
import { Text } from "react-native";
import { profile } from "@/lib/api";
import { useSession } from "@/lib/session";
import { signOutAndForgetDevice } from "@/lib/push";
import { Button, Card, ErrorText, Muted, Screen, Title, s } from "@/components/ui";

export default function Profile() {
  const { userId } = useSession();
  const [me, setMe] = useState<Record<string, unknown> | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (userId) profile(userId).then(setMe, () => {});
  }, [userId]);
  return (
    <Screen>
      <Title>{(me?.display_name as string) ?? "You"}</Title>
      <Muted>@{(me?.username as string) ?? ""}{me?.supporter ? " · Supporter" : ""}</Muted>
      {me?.bio ? <Card><Text style={s.muted}>{me.bio as string}</Text></Card> : null}
      <Muted>Edit your profile, settings, tickets and Plus on the website.</Muted>
      <ErrorText>{error}</ErrorText>
      <Button
        title="Sign out"
        variant="plain"
        loading={signingOut}
        onPress={() => {
          setSigningOut(true);
          setError(null);
          signOutAndForgetDevice().catch((e: Error) => {
            setError(`Could not sign out: ${e.message}`);
            setSigningOut(false);
          });
        }}
      />
    </Screen>
  );
}
