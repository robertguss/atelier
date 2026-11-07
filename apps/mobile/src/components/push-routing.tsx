import { useConvexAuth } from "convex/react";
import Constants, { AppOwnership } from "expo-constants";
import type { NotificationResponse } from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";

import { notificationRitualId } from "../lib/notification-route";

// What one mounted listener shares with its effect cleanup.
interface Routing {
  disposed: boolean;
  lastId?: string;
  remove?: () => void;
}

// Opens the ritual a tapped notification names, including the tap that
// launched the app, until the routing is disposed.
const routeNotificationTaps = async (routing: Routing) => {
  const notifications = await import("expo-notifications");
  if (routing.disposed) {
    return;
  }
  const open = (response: NotificationResponse | null) => {
    if (routing.disposed) {
      return;
    }
    const id = notificationRitualId(response, routing.lastId);
    if (id === undefined || id === "" || !response) {
      return;
    }
    routing.lastId = response.notification.request.identifier;
    router.push({ params: { id }, pathname: "/ritual/[id]" });
  };
  const subscription =
    notifications.addNotificationResponseReceivedListener(open);
  routing.remove = () => {
    subscription.remove();
  };
  open(notifications.getLastNotificationResponse());
};

export const PushRouting = () => {
  const { isAuthenticated } = useConvexAuth();
  useEffect((): (() => void) | undefined => {
    if (
      !isAuthenticated ||
      Platform.OS === "web" ||
      // oxlint-disable-next-line typescript/no-deprecated -- executionEnvironment reports development builds as storeClient too, so only appOwnership tells Expo Go apart.
      Constants.appOwnership === AppOwnership.Expo
    ) {
      return undefined;
    }
    const routing: Routing = { disposed: false };
    routeNotificationTaps(routing).catch(() => {
      /* Device registration reports notification setup errors. */
    });
    return () => {
      routing.disposed = true;
      routing.remove?.();
    };
  }, [isAuthenticated]);
  return null;
};
