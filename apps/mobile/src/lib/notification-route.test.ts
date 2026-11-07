import { describe, expect, it } from "vitest";

import { notificationTarget } from "./notification-route";

const response = (
  identifier: string,
  data?: Record<string, unknown> | null
) => ({
  notification: { request: { content: { data }, identifier } },
});

describe(notificationTarget, () => {
  it("returns the ritual a review notification names", () => {
    expect(
      notificationTarget(response("n-1", { ritualId: "abc123" }), undefined)
    ).toStrictEqual({ id: "abc123", kind: "ritual" });
  });

  it("returns the room and the asking agent a question notification names", () => {
    expect(
      notificationTarget(
        response("n-1", { participantId: "p1", roomId: "abc123" }),
        undefined
      )
    ).toStrictEqual({ id: "abc123", kind: "room", participantId: "p1" });
    expect(
      notificationTarget(response("n-1", { roomId: "abc123" }), undefined)
    ).toStrictEqual({ id: "abc123", kind: "room" });
  });

  it("ignores a missing response", () => {
    expect(notificationTarget(null, undefined)).toBeUndefined();
  });

  it("ignores notifications without a string id", () => {
    expect(notificationTarget(response("n-1"), undefined)).toBeUndefined();
    expect(
      notificationTarget(response("n-1", { ritualId: 42 }), undefined)
    ).toBeUndefined();
    expect(
      notificationTarget(response("n-1", { roomId: 42 }), undefined)
    ).toBeUndefined();
  });

  it("rejects ids with characters outside letters and digits", () => {
    expect(
      notificationTarget(response("n-1", { ritualId: "../x" }), undefined)
    ).toBeUndefined();
    expect(
      notificationTarget(response("n-1", { roomId: "../x" }), undefined)
    ).toBeUndefined();
    expect(
      notificationTarget(
        response("n-1", { participantId: "../x", roomId: "abc123" }),
        undefined
      )
    ).toStrictEqual({ id: "abc123", kind: "room" });
  });

  it("does not route the same notification twice", () => {
    expect(
      notificationTarget(response("n-1", { ritualId: "abc123" }), "n-1")
    ).toBeUndefined();
  });
});
