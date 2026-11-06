import { useConvexAuth } from "convex/react";
import Constants from "expo-constants";
import { router } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";

import { notificationRitualId } from "../lib/notification-route";

export function PushRouting() {
  const { isAuthenticated } = useConvexAuth();
  useEffect(() => {
    if (
      !isAuthenticated ||
      Platform.OS === "web" ||
      Constants.appOwnership === "expo"
    ) {
      return;
    }
    let disposed = false;
    let remove: (() => void) | undefined;
    let lastId: string | undefined;
    void import("expo-notifications")
      .then(async (notifications) => {
        if (disposed) {
          return;
        }
        const open = (
          response: import("expo-notifications").NotificationResponse | null
        ) => {
          if (disposed) {
            return;
          }
          const id = notificationRitualId(response, lastId);
          if (!id || !response) {
            return;
          }
          lastId = response.notification.request.identifier;
          router.push({ params: { id }, pathname: "/ritual/[id]" });
        };
        const subscription =
          notifications.addNotificationResponseReceivedListener(open);
        remove = () => {
          subscription.remove();
        };
        open(await notifications.getLastNotificationResponseAsync());
      })
      .catch(() => {
        /* Device registration reports notification setup errors. */
      });
    return () => {
      disposed = true;
      remove?.();
    };
  }, [isAuthenticated]);
  return null;
}
