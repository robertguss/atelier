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

const ID = /^[a-z0-9]+$/iu;

const validId = (value: unknown) =>
  typeof value === "string" && ID.test(value) ? value : undefined;

/** Where a tapped notification leads: a review, or a room with the agent that asked. */
export type NotificationTarget =
  | { kind: "ritual"; id: string }
  | { kind: "room"; id: string; participantId?: string };

/**
 * Where a tapped notification should go, or undefined when the response is
 * missing, was already handled, or names no valid ritual or room.
 */
export const notificationTarget = (
  response: NotificationResponseLike | null,
  lastIdentifier: string | undefined
): NotificationTarget | undefined => {
  if (
    !response ||
    response.notification.request.identifier === lastIdentifier
  ) {
    return undefined;
  }
  const data = response.notification.request.content.data ?? {};
  const ritualId = validId(data.ritualId);
  if (ritualId !== undefined) {
    return { id: ritualId, kind: "ritual" };
  }
  const roomId = validId(data.roomId);
  if (roomId === undefined) {
    return undefined;
  }
  const participantId = validId(data.participantId);
  return {
    id: roomId,
    kind: "room",
    ...(participantId === undefined ? {} : { participantId }),
  };
};
