import { useTheme } from "expo-router";
import {
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type TextInputProps,
  type TextStyle,
} from "react-native";

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
          color: colors.text,
          backgroundColor: colors.card,
          borderColor: colors.border,
        },
        props.style,
      ]}
    />
  );
}

export const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 16,
    padding: 24,
  },
  title: { fontSize: 34, fontWeight: "700" },
  body: { fontSize: 16, lineHeight: 22 },
  section: { gap: 8 },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    textTransform: "uppercase",
    opacity: 0.6,
  },
  button: {
    paddingHorizontal: 20,
    paddingVertical: 13,
    borderRadius: 12,
    alignItems: "center",
  },
  buttonLabel: { fontSize: 16, fontWeight: "600" },
  field: {
    fontSize: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
