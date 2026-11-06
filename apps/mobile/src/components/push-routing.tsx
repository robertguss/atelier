import Constants from 'expo-constants';
import { useConvexAuth } from 'convex/react';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

export function PushRouting() {
  const { isAuthenticated } = useConvexAuth();
  useEffect(() => {
    if (!isAuthenticated || Platform.OS === 'web' || Constants.appOwnership === 'expo') return;
    let disposed = false;
    let remove: (() => void) | undefined;
    let lastId: string | undefined;
    void import('expo-notifications').then(async notifications => {
      if (disposed) return;
      const open = (response: import('expo-notifications').NotificationResponse | null) => {
        if (!response || disposed || response.notification.request.identifier === lastId) return;
        const id = response.notification.request.content.data?.ritualId;
        if (typeof id !== 'string' || !/^[a-z0-9]+$/i.test(id)) return;
        lastId = response.notification.request.identifier;
        router.push({ pathname: '/ritual/[id]', params: { id } });
      };
      const subscription = notifications.addNotificationResponseReceivedListener(open);
      remove = () => subscription.remove();
      open(await notifications.getLastNotificationResponseAsync());
    }).catch(() => { /* Device registration reports notification setup errors. */ });
    return () => { disposed = true; remove?.(); };
  }, [isAuthenticated]);
  return null;
}
