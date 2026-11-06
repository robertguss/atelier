import { describe, expect, it } from "vitest";

import { notificationRitualId } from "./notification-route";

const response = (
  identifier: string,
  data?: Record<string, unknown> | null
) => ({
  notification: { request: { content: { data }, identifier } },
});

describe("notificationRitualId", () => {
  it("returns the ritual id from a new notification", () => {
    expect(
      notificationRitualId(response("n-1", { ritualId: "abc123" }), undefined)
    ).toBe("abc123");
  });

  it("ignores a missing response", () => {
    expect(notificationRitualId(null, undefined)).toBeUndefined();
  });

  it("ignores notifications without a string ritual id", () => {
    expect(notificationRitualId(response("n-1"), undefined)).toBeUndefined();
    expect(
      notificationRitualId(response("n-1", { ritualId: 42 }), undefined)
    ).toBeUndefined();
  });

  it("rejects ids with characters outside letters and digits", () => {
    expect(
      notificationRitualId(response("n-1", { ritualId: "../x" }), undefined)
    ).toBeUndefined();
  });

  it("does not route the same notification twice", () => {
    expect(
      notificationRitualId(response("n-1", { ritualId: "abc123" }), "n-1")
    ).toBeUndefined();
  });
});
