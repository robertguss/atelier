import { describe, expect, it } from "vitest";

import { includedParticipantIds, toggleExcluded } from "./review-participants";

const participants = [{ _id: "a" }, { _id: "b" }, { _id: "c" }];

describe(toggleExcluded, () => {
  it("excludes an included participant and re-includes them on a second toggle", () => {
    const excluded = toggleExcluded([], "b");
    expect(excluded).toStrictEqual(["b"]);
    expect(toggleExcluded(excluded, "b")).toStrictEqual([]);
  });
});

describe(includedParticipantIds, () => {
  it("keeps the original participant order", () => {
    expect(includedParticipantIds(participants, ["b"])).toStrictEqual([
      "a",
      "c",
    ]);
  });

  it("is empty when everyone is excluded", () => {
    expect(includedParticipantIds(participants, ["c", "a", "b"])).toStrictEqual(
      []
    );
  });
});
