import { api } from "@atelier/backend/api";
import { useMutation, useQuery } from "convex/react";
import Constants, { AppOwnership } from "expo-constants";
import { isDevice } from "expo-device";
import { useState } from "react";
import { Platform } from "react-native";

import { Body, Button, Section } from "./ui";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// The EAS project id, from the EAS config or else the app config's extra.
// expo-constants types easConfig through expo-manifests, which isn't
// installed, so both sources are read as unknown and narrowed.
const easProjectId = (): string | undefined => {
  const easConfig: unknown = Reflect.get(Constants, "easConfig");
  const extra: unknown = Constants.expoConfig?.extra;
  const fromEas = isRecord(easConfig) ? easConfig.projectId : undefined;
  const fromExtra =
    isRecord(extra) && isRecord(extra.eas) ? extra.eas.projectId : undefined;
  const projectId = fromEas ?? fromExtra;
  return typeof projectId === "string" ? projectId : undefined;
};

// Asks for permission and returns this device's Expo push token.
const requestPushToken = async (projectId: string | undefined) => {
  const notifications = await import("expo-notifications");
  if (Platform.OS === "android") {
    await notifications.setNotificationChannelAsync("default", {
      importance: notifications.AndroidImportance.DEFAULT,
      name: "Reviews",
    });
  }
  const permission = await notifications.requestPermissionsAsync();
  if (!permission.granted) {
    throw new Error("Notifications are not enabled in device settings.");
  }
  const token = await notifications.getExpoPushTokenAsync({ projectId });
  return token.data;
};

const statusText = (supported: boolean, registered: boolean) => {
  if (!supported) {
    return "Review notifications need an EAS development build on a physical device. Reviews still run while Expo Go is closed.";
  }
  return registered
    ? "This account has a registered notification device."
    : "Get notified when all review answers are ready.";
};

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const PushReadiness = () => {
  const register = useMutation(api.push.register);
  const readiness = useQuery(api.push.readiness);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const projectId = easProjectId();
  const supported =
    // oxlint-disable-next-line typescript/no-deprecated -- executionEnvironment reports development builds as storeClient too, so only appOwnership tells Expo Go apart.
    Constants.appOwnership !== AppOwnership.Expo &&
    Platform.OS !== "web" &&
    isDevice &&
    projectId !== undefined &&
    projectId !== "";
  const enable = async () => {
    setBusy(true);
    try {
      const token = await requestPushToken(projectId);
      await register({ platform: Platform.OS, token });
      setError("");
    } catch (error_) {
      setError(describeError(error_));
    }
    setBusy(false);
  };
  const showError = (error_: unknown) => {
    setError(describeError(error_));
  };
  return (
    <Section title="Notifications">
      <Body>{statusText(supported, readiness?.registered === true)}</Body>
      {supported && (
        <Button
          label="Enable notifications on this device"
          disabled={busy}
          onPress={() => {
            enable().catch(showError);
          }}
        />
      )}
      {error ? <Body>{error}</Body> : null}
    </Section>
  );
};
