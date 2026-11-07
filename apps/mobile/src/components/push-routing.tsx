import { useConvexAuth } from "convex/react";
import Constants, { AppOwnership } from "expo-constants";
import type { NotificationResponse } from "expo-notifications";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";

import { notificationTarget } from "../lib/notification-route";

// What one mounted listener shares with its effect cleanup.
interface Routing {
  disposed: boolean;
  lastId?: string;
  remove?: () => void;
}

// Opens the review or room a tapped notification names, including the tap
// that launched the app, until the routing is disposed.
const routeNotificationTaps = async (routing: Routing) => {
  const notifications = await import("expo-notifications");
  if (routing.disposed) {
    return;
  }
  const open = (response: NotificationResponse | null) => {
    if (routing.disposed) {
      return;
    }
    const target = notificationTarget(response, routing.lastId);
    if (target === undefined || !response) {
      return;
    }
    routing.lastId = response.notification.request.identifier;
    if (target.kind === "ritual") {
      router.push({ params: { id: target.id }, pathname: "/ritual/[id]" });
    } else {
      // The asking agent is preselected, so its question shows by the composer.
      router.push({
        params: {
          id: target.id,
          ...(target.participantId === undefined
            ? {}
            : { participantId: target.participantId }),
        },
        pathname: "/room/[id]",
      });
    }
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
