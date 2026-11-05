import { useState } from "react";
import { signInSchema } from "@findmaxxing/shared/validation";
import { requireSupabase } from "@/lib/supabase";
import { Button, ErrorText, Field, Muted, Screen, Title } from "@/components/ui";

/** Email and password, the same accounts as the web app (sign-up and resets happen there). */
export default function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const parsed = signInSchema.safeParse({ email, password });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message ?? "Check your details");
    setBusy(true);
    const { error: err } = await requireSupabase().auth.signInWithPassword({ email: parsed.data.email, password: parsed.data.password });
    setBusy(false);
    // A wrong password is a 400; no status at all means the server wasn't reached.
    setError(!err ? null : err.status === 400 ? "That email and password don't match" : "Can't reach FindMaxxing right now. Check your connection and try again.");
  };
  return (
    <Screen style={{ justifyContent: "center" }}>
      <Title>FindMaxxing</Title>
      <Muted>Local knowledge, mapped.</Muted>
      <Field label="Email" value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" autoComplete="email" />
      <Field label="Password" value={password} onChangeText={setPassword} secureTextEntry autoComplete="password" />
      <ErrorText>{error}</ErrorText>
      <Button title="Sign in" onPress={submit} loading={busy} />
      <Muted>New here? Create an account on the website, then sign in.</Muted>
    </Screen>
  );
}
