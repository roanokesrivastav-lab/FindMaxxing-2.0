import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View, type TextInputProps, type ViewStyle } from "react-native";

export const colors = { paper: "#f6f4ee", surface: "#ffffff", ink: "#17181d", ink2: "#3a3b42", muted: "#62636b", line: "#e3dfd4", flare: "#b8371f", pulse: "#6b4cff" };

export function Screen({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[s.screen, style]}>{children}</View>;
}

export function Title({ children }: { children: ReactNode }) {
  return <Text style={s.title} accessibilityRole="header">{children}</Text>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <Text style={s.muted}>{children}</Text>;
}

export function Card({ children, onPress, label }: { children: ReactNode; onPress?: () => void; label?: string }) {
  return onPress ? (
    <Pressable onPress={onPress} accessibilityRole="link" accessibilityLabel={label} style={({ pressed }) => [s.card, pressed && { opacity: 0.85 }]}>{children}</Pressable>
  ) : <View style={s.card}>{children}</View>;
}

export function Button({ title, onPress, loading, variant = "ink", disabled }: { title: string; onPress: () => void; loading?: boolean; variant?: "ink" | "flare" | "plain"; disabled?: boolean }) {
  const bg = variant === "plain" ? colors.surface : variant === "flare" ? colors.flare : colors.ink;
  return (
    <Pressable accessibilityRole="button" accessibilityState={{ disabled: disabled || loading, busy: loading }} disabled={disabled || loading} onPress={onPress}
      style={({ pressed }) => [s.button, { backgroundColor: bg, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 }, variant === "plain" && s.plain]}>
      {loading ? <ActivityIndicator color={variant === "plain" ? colors.ink : "#fff"} /> : <Text style={[s.buttonText, variant === "plain" && { color: colors.ink }]}>{title}</Text>}
    </Pressable>
  );
}

export function Field({ label, ...props }: TextInputProps & { label: string }) {
  return (
    <View style={{ gap: 4 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput accessibilityLabel={label} placeholderTextColor={colors.muted} style={[s.input, props.multiline && { minHeight: 80, textAlignVertical: "top" }]} {...props} />
    </View>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return children ? <Text style={s.error} accessibilityRole="alert">{children}</Text> : null;
}

export const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.paper, padding: 16, gap: 12 },
  title: { fontSize: 24, fontWeight: "700", color: colors.ink },
  muted: { fontSize: 14, color: colors.muted },
  card: { backgroundColor: colors.surface, borderRadius: 16, borderWidth: 1, borderColor: colors.line, padding: 14, gap: 4 },
  button: { height: 48, borderRadius: 999, alignItems: "center", justifyContent: "center", paddingHorizontal: 20 },
  plain: { borderWidth: 1, borderColor: colors.line },
  buttonText: { color: "#fff", fontWeight: "600", fontSize: 16 },
  label: { fontSize: 14, fontWeight: "600", color: colors.ink },
  input: { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.line, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 10, fontSize: 16, color: colors.ink },
  error: { color: "#be2828", fontSize: 14 },
  name: { fontSize: 17, fontWeight: "600", color: colors.ink },
});
