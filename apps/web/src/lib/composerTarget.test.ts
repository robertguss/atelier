import { describe, expect, it } from "vitest";

import { composerTarget } from "./composerTarget";

const claude = { participantId: "p-claude", harness: "claude" };
const codex = { participantId: "p-codex", harness: "codex" };
const pi = { participantId: "p-pi", harness: "pi" };

describe("composerTarget", () => {
  it("picks the agent with an open card over the last target", () => {
    expect(
      composerTarget({
        agents: [claude, codex, pi],
        openCardAgentIds: ["p-pi"],
        lastTarget: "p-codex",
      })
    ).toBe("p-pi");
  });

  it("picks the earliest open card when several agents wait", () => {
    expect(
      composerTarget({
        agents: [claude, codex, pi],
        openCardAgentIds: ["p-codex", "p-pi"],
        lastTarget: null,
      })
    ).toBe("p-codex");
  });

  it("uses the last target when no card is open", () => {
    expect(
      composerTarget({
        agents: [claude, codex],
        openCardAgentIds: [],
        lastTarget: "p-codex",
      })
    ).toBe("p-codex");
  });

  it("falls back to Claude when there is no usable last target", () => {
    expect(
      composerTarget({
        agents: [codex, claude],
        openCardAgentIds: [],
        lastTarget: null,
      })
    ).toBe("p-claude");
    expect(
      composerTarget({
        agents: [codex, claude],
        openCardAgentIds: [],
        lastTarget: "p-gone",
      })
    ).toBe("p-claude");
  });

  it("ignores an open card for an agent no longer in the room", () => {
    expect(
      composerTarget({
        agents: [claude],
        openCardAgentIds: ["p-gone"],
        lastTarget: null,
      })
    ).toBe("p-claude");
  });

  it("uses the first agent when the room has no Claude, and null with no agents", () => {
    expect(
      composerTarget({
        agents: [codex, pi],
        openCardAgentIds: [],
        lastTarget: null,
      })
    ).toBe("p-codex");
    expect(
      composerTarget({ agents: [], openCardAgentIds: [], lastTarget: null })
    ).toBeNull();
  });
});
