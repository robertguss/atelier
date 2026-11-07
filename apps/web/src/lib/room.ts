import type { api } from '@atelier/backend/api';
import type { FunctionReturnType } from 'convex/server';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

export type Pane = FunctionReturnType<typeof api.agent.pane>;
export type LiveTurns = FunctionReturnType<typeof api.agent.live>;
export type PaneAgent = Pane['agents'][number];
export type PaneMessage = Pane['messages'][number];
export type PaneTurn = Pane['turns'][number];
export type PaneCard = Pane['cards'][number];
export type RoomData = NonNullable<FunctionReturnType<typeof api.rooms.get>>;
export type Participant = RoomData['participants'][number];

/**
 * The pane leaves out the text and tool calls of active turns, which stream
 * through the live query; this puts them back.
 */
export function withLive(pane: Pane, live: LiveTurns | undefined): Pane {
  if (!live?.length) return pane;
  const byId = new Map<string, LiveTurns[number]>(live.map((l) => [l.id, l]));
  return {
    ...pane,
    turns: pane.turns.map((turn) => {
      const l = byId.get(turn.id);
      return l ? { ...turn, partialText: l.partialText, items: l.items } : turn;
    }),
  };
}

/** The last value that wasn't undefined, so a query keeps showing old data while new arguments load. */
export function useLastDefined<T>(value: T | undefined): T | undefined {
  const last = useRef(value);
  if (value !== undefined) last.current = value;
  return value ?? last.current;
}

export type Names = (participantId: string | null | undefined) => string;

export function namesFrom(participants: readonly Participant[]): Names {
  const byId = new Map(participants.map((p) => [p._id as string, p.displayName]));
  return (id) => (id ? (byId.get(id) ?? 'Someone') : 'Someone');
}

/** A message to an agent still waiting for its turn, or being steered into the running one. */
export function isWaiting(message: PaneMessage) {
  return message.delivery === 'queued' || message.delivery === 'steering';
}

export type TimelineItem =
  | { kind: 'message'; key: string; at: number; message: PaneMessage }
  | { kind: 'turn'; key: string; at: number; turn: PaneTurn; replies: PaneMessage[]; cards: PaneCard[] };

/**
 * The agent pane's timeline, oldest first: people's messages to agents that
 * have left the queue, and each turn with its replies and closed cards. Open
 * cards are pinned above the composer and queued messages sit in the queue
 * strip, so neither appears here.
 */
export function buildTimeline(pane: Pane): TimelineItem[] {
  const turnIds = new Set<string>(pane.turns.map((t) => t.id));
  const replies = new Map<string, PaneMessage[]>();
  const items: TimelineItem[] = [];
  for (const message of pane.messages) {
    if (message.turnId && turnIds.has(message.turnId)) {
      replies.set(message.turnId, [...(replies.get(message.turnId) ?? []), message]);
    } else if (!isWaiting(message)) {
      items.push({ kind: 'message', key: message.id, at: message.at, message });
    }
  }
  for (const turn of pane.turns) {
    const cards = pane.cards.filter((c) => c.turnId === turn.id && c.status !== 'raised');
    items.push({ kind: 'turn', key: turn.id, at: turn.at, turn, replies: replies.get(turn.id) ?? [], cards });
  }
  return items.sort((a, b) => a.at - b.at);
}

export interface ToolItem {
  key: string;
  name: string;
  summary: string;
  ok: boolean | null;
}

/** A turn's tool activity, oldest first, as the pane already orders it. */
export function toolItemsFor(turn: PaneTurn): ToolItem[] {
  return turn.items.map((item, index) => ({ key: `${turn.id}:${index}`, ...item }));
}

export function isOffline(pane: Pane, now: number) {
  return now - pane.runner.lastHeartbeatAt > pane.runner.offlineAfterMs;
}

/** Why a message to an agent was never delivered, as a sentence ending. */
export function cancelReasonText(reason: string | null) {
  if (reason === 'removed') return 'its author was removed from the room';
  if (reason === 'runner offline') return "the agents' machine was offline";
  return reason ?? 'it was cancelled';
}

export function formatTime(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function useNow(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function useMediaQuery(query: string) {
  return useSyncExternalStore(
    (onChange) => {
      const list = window.matchMedia(query);
      list.addEventListener('change', onChange);
      return () => list.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
  );
}

/**
 * Keeps a scroll container pinned to its end while its content grows, as
 * long as the reader is at the end. Scrolling up stops following; scrolling
 * back to the end resumes it.
 */
export function useStickToBottom<Scroll extends HTMLElement, Content extends HTMLElement>() {
  const scrollRef = useRef<Scroll>(null);
  const contentRef = useRef<Content>(null);
  const atEnd = useRef(true);

  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const pin = () => {
      if (atEnd.current) scroller.scrollTop = scroller.scrollHeight;
    };
    const onScroll = () => {
      atEnd.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener('scroll', onScroll);
    };
  }, []);

  // New rows render before the observer sees the size change; pin in the same frame.
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller && atEnd.current) scroller.scrollTop = scroller.scrollHeight;
  });

  return { scrollRef, contentRef };
}

function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable (private windows); the default still applies.
  }
}

const lastTargetKey = (roomId: string) => `atelier:last-target:${roomId}`;

export function readLastTarget(roomId: string): string | null {
  return readStored(lastTargetKey(roomId));
}

export function writeLastTarget(roomId: string, participantId: string) {
  writeStored(lastTargetKey(roomId), participantId);
}

/** Which side panels are expanded beside the document. */
export interface SidePanels {
  agent: boolean;
  team: boolean;
}

// A room opened for the first time shows the agents and keeps team chat folded away.
const FIRST_VISIT_PANELS: SidePanels = { agent: true, team: false };
const panelsKey = (roomId: string) => `atelier:panels:${roomId}`;

export function readPanels(roomId: string): SidePanels {
  const stored = readStored(panelsKey(roomId));
  if (!stored) return FIRST_VISIT_PANELS;
  try {
    const parsed = JSON.parse(stored) as Partial<SidePanels>;
    return { agent: parsed.agent ?? FIRST_VISIT_PANELS.agent, team: parsed.team ?? FIRST_VISIT_PANELS.team };
  } catch {
    return FIRST_VISIT_PANELS;
  }
}

export function writePanels(roomId: string, panels: SidePanels) {
  writeStored(panelsKey(roomId), JSON.stringify(panels));
}

// How many team messages this browser has shown, so a folded team chat can
// count the rest as unread.
const teamSeenKey = (roomId: string) => `atelier:team-seen:${roomId}`;

export function readTeamSeen(roomId: string): number {
  return Number(readStored(teamSeenKey(roomId))) || 0;
}

export function writeTeamSeen(roomId: string, count: number) {
  writeStored(teamSeenKey(roomId), String(count));
}

/** Team messages after the first `seen`, leaving out the person's own. */
export function unreadTeamCount(messages: readonly { authorParticipantId: string }[], seen: number, meId: string | null) {
  return messages.slice(seen).filter((m) => m.authorParticipantId !== meId).length;
}

/** What a folded agent pane flags: open question cards first, then agents at work. */
export function agentAttention(pane: Pane): string | null {
  const questions = pane.cards.filter((c) => c.status === 'raised').length;
  if (questions) return questions === 1 ? '1 question' : `${questions} questions`;
  if (pane.agents.some((a) => a.status === 'running' || a.status === 'starting')) return 'Working';
  return null;
}
