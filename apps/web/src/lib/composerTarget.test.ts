import { describe, expect, it } from "vitest";

import { composerTarget } from "./composerTarget";

const claude = { harness: "claude", participantId: "p-claude" };
const codex = { harness: "codex", participantId: "p-codex" };
const pi = { harness: "pi", participantId: "p-pi" };

describe(composerTarget, () => {
  it("picks the agent with an open card over the last target", () => {
    expect(
      composerTarget({
        agents: [claude, codex, pi],
        lastTarget: "p-codex",
        openCardAgentIds: ["p-pi"],
      })
    ).toBe("p-pi");
  });

  it("picks the earliest open card when several agents wait", () => {
    expect(
      composerTarget({
        agents: [claude, codex, pi],
        lastTarget: null,
        openCardAgentIds: ["p-codex", "p-pi"],
      })
    ).toBe("p-codex");
  });

  it("uses the last target when no card is open", () => {
    expect(
      composerTarget({
        agents: [claude, codex],
        lastTarget: "p-codex",
        openCardAgentIds: [],
      })
    ).toBe("p-codex");
  });

  it("falls back to Claude when there is no usable last target", () => {
    expect(
      composerTarget({
        agents: [codex, claude],
        lastTarget: null,
        openCardAgentIds: [],
      })
    ).toBe("p-claude");
    expect(
      composerTarget({
        agents: [codex, claude],
        lastTarget: "p-gone",
        openCardAgentIds: [],
      })
    ).toBe("p-claude");
  });

  it("ignores an open card for an agent no longer in the room", () => {
    expect(
      composerTarget({
        agents: [claude],
        lastTarget: null,
        openCardAgentIds: ["p-gone"],
      })
    ).toBe("p-claude");
  });

  it("uses the first agent when the room has no Claude, and null with no agents", () => {
    expect(
      composerTarget({
        agents: [codex, pi],
        lastTarget: null,
        openCardAgentIds: [],
      })
    ).toBe("p-codex");
    expect(
      composerTarget({ agents: [], lastTarget: null, openCardAgentIds: [] })
    ).toBeNull();
  });
});
