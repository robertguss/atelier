export interface TargetableAgent {
  participantId: string;
  harness: string | null;
}

/**
 * Which agent the agent composer writes to when the person hasn't picked one:
 * the agent waiting on an open question card (the earliest, if several),
 * then the person's last target, then Claude, then the first agent.
 */
export function composerTarget({
  agents,
  openCardAgentIds,
  lastTarget,
}: {
  agents: readonly TargetableAgent[];
  /** Agents with an open card, earliest card first. */
  openCardAgentIds: readonly string[];
  lastTarget: string | null;
}): string | null {
  const inRoom = (id: string | null) => id !== null && agents.some((a) => a.participantId === id);
  const waiting = openCardAgentIds.find(inRoom);
  if (waiting) return waiting;
  if (inRoom(lastTarget)) return lastTarget;
  return (agents.find((a) => a.harness === 'claude') ?? agents[0])?.participantId ?? null;
}
