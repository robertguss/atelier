import { useTheme } from "expo-router";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { TextInputProps, TextStyle } from "react-native";

export function Centered({ children }: { children: React.ReactNode }) {
  return <View style={styles.centered}>{children}</View>;
}

export function Title({ children }: { children: React.ReactNode }) {
  return (
    <Text style={[styles.title, { color: useTheme().colors.text }]}>
      {children}
    </Text>
  );
}

export function Body({
  children,
  style,
  selectable,
}: {
  children: React.ReactNode;
  style?: TextStyle;
  selectable?: boolean;
}) {
  return (
    <Text
      selectable={selectable}
      style={[styles.body, { color: useTheme().colors.text }, style]}
    >
      {children}
    </Text>
  );
}

export function Muted({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: TextStyle;
}) {
  return <Body style={{ opacity: 0.55, ...style }}>{children}</Body>;
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={[styles.sectionTitle, { color: useTheme().colors.text }]}>
        {title}
      </Text>
      {children}
    </View>
  );
}

export function Button({
  label,
  onPress,
  disabled,
  kind = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary";
}) {
  const { colors } = useTheme();
  const primary = kind === "primary";
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: primary ? colors.primary : colors.card,
          opacity: pressed || disabled ? 0.5 : 1,
        },
      ]}
    >
      <Text
        style={[styles.buttonLabel, { color: primary ? "white" : colors.text }]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

export function Field(props: TextInputProps) {
  const { colors } = useTheme();
  return (
    <TextInput
      placeholderTextColor="#8e8e93"
      autoCapitalize="none"
      autoCorrect={false}
      {...props}
      style={[
        styles.field,
        {
          backgroundColor: colors.card,
          borderColor: colors.border,
          color: colors.text,
        },
        props.style,
      ]}
    />
  );
}

export const styles = StyleSheet.create({
  body: { fontSize: 16, lineHeight: 22 },
  button: {
    alignItems: "center",
    borderRadius: 12,
    paddingHorizontal: 20,
    paddingVertical: 13,
  },
  buttonLabel: { fontSize: 16, fontWeight: "600" },
  centered: {
    alignItems: "center",
    flex: 1,
    gap: 16,
    justifyContent: "center",
    padding: 24,
  },
  field: {
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    opacity: 0.6,
    textTransform: "uppercase",
  },
  title: { fontSize: 34, fontWeight: "700" },
});
