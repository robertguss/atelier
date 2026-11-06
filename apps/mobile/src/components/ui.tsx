import { useTheme } from "expo-router";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import type { TextInputProps, TextStyle } from "react-native";

const styles = StyleSheet.create({
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

export const Centered = ({ children }: { children: React.ReactNode }) => (
  <View style={styles.centered}>{children}</View>
);

export const Title = ({ children }: { children: React.ReactNode }) => (
  <Text style={[styles.title, { color: useTheme().colors.text }]}>
    {children}
  </Text>
);

export const Body = ({
  children,
  style,
  selectable,
}: {
  children: React.ReactNode;
  style?: TextStyle;
  selectable?: boolean;
}) => (
  <Text
    selectable={selectable}
    style={[styles.body, { color: useTheme().colors.text }, style]}
  >
    {children}
  </Text>
);

export const Muted = ({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: TextStyle;
}) => <Body style={{ opacity: 0.55, ...style }}>{children}</Body>;

export const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <View style={styles.section}>
    <Text style={[styles.sectionTitle, { color: useTheme().colors.text }]}>
      {title}
    </Text>
    {children}
  </View>
);

export const Button = ({
  label,
  onPress,
  disabled,
  kind = "primary",
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  kind?: "primary" | "secondary";
}) => {
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
          opacity: pressed || disabled === true ? 0.5 : 1,
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
};

export const Field = (props: TextInputProps) => {
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
};
