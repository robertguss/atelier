import { api } from "@atelier/backend/api";
import { useMutation, useQuery } from "convex/react";
import Constants from "expo-constants";
import { isDevice } from "expo-device";
import { useState } from "react";
import { Platform } from "react-native";

import { Body, Button, Section } from "./ui";

export function PushReadiness() {
  const register = useMutation(api.push.register);
  const readiness = useQuery(api.push.readiness);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const projectId =
    Constants.easConfig?.projectId ??
    Constants.expoConfig?.extra?.eas?.projectId;
  const supported =
    Constants.appOwnership !== "expo" &&
    Platform.OS !== "web" &&
    isDevice &&
    !!projectId;
  async function enable() {
    setBusy(true);
    try {
      const notifications = await import("expo-notifications");
      if (Platform.OS === "android")
        await notifications.setNotificationChannelAsync("default", {
          name: "Reviews",
          importance: notifications.AndroidImportance.DEFAULT,
        });
      const permission = await notifications.requestPermissionsAsync();
      if (!permission.granted)
        throw new Error("Notifications are not enabled in device settings.");
      const token = await notifications.getExpoPushTokenAsync({ projectId });
      await register({ token: token.data, platform: Platform.OS });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section title="Notifications">
      <Body>
        {supported
          ? readiness?.registered
            ? "This account has a registered notification device."
            : "Get notified when all review answers are ready."
          : "Review notifications need an EAS development build on a physical device. Reviews still run while Expo Go is closed."}
      </Body>
      {supported && (
        <Button
          label="Enable notifications on this device"
          disabled={busy}
          onPress={enable}
        />
      )}
      {error ? <Body>{error}</Body> : null}
    </Section>
  );
}
