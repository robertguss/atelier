// The parts of an expo-notifications response that routing reads. Kept
// structural so this module stays free of native imports and testable.
export interface NotificationResponseLike {
  notification: {
    request: {
      content: { data?: Record<string, unknown> | null };
      identifier: string;
    };
  };
}

const RITUAL_ID = /^[a-z0-9]+$/iu;

/**
 * The ritual a tapped notification should open, or undefined when the
 * response is missing, was already handled, or carries no valid ritual id.
 */
export const notificationRitualId = (
  response: NotificationResponseLike | null,
  lastIdentifier: string | undefined
): string | undefined => {
  if (
    !response ||
    response.notification.request.identifier === lastIdentifier
  ) {
    return undefined;
  }
  const id = response.notification.request.content.data?.ritualId;
  if (typeof id !== "string" || !RITUAL_ID.test(id)) {
    return undefined;
  }
  return id;
};
