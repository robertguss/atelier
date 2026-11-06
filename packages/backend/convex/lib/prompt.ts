import type { Doc, Id } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";
import { findLedger } from "./ledger";

// Every piece of text an agent reads about the room or its people is built
// here. Nothing in this module reads team chat: the team channel stays
// invisible to agents by construction.

export const PRIVATE_CHANNEL_SENTENCE =
  "The people in this room also have a private team channel that you cannot see.";

const RECENT_DECISIONS = 10;

export type MemberRole = "owner" | "teammate";
export interface AgentDecision {
  question: string;
  choice: string;
  answeredBy: string;
  at: number;
}
export interface RoomContext {
  roomName: string;
  handbook: string;
  members: { name: string; role: MemberRole }[];
  editsEnabled: boolean;
  decisions: AgentDecision[];
}
export interface Envelope {
  author: string;
  role: MemberRole;
  sentAt: number;
  delivery: "queued" | "steered";
  body: string;
}

// Tags that delimit agent-facing structure. A body or name that contains one
// is escaped so nobody can forge another author's message or the room block.
const STRUCTURE_TAG = /<(\/?)(message|room_context)\b/gi;

function neutralize(text: string) {
  return text.replaceAll(
    STRUCTURE_TAG,
    (_m, slash: string, name: string) => `&lt;${slash}${name}`
  );
}

const NAME_LIMIT = 60;

// A person's name as an agent reads it: whitespace and control characters,
// line breaks included, collapse to single spaces, and the result is capped
// and never empty. A display name can then add no line to the room block, a
// decision or a message header.
export function agentName(
  name: string | null | undefined,
  fallback = "Teammate"
) {
  const oneLine = (name ?? "").replaceAll(/[\s\p{Cc}]+/gu, " ").trim();
  return [...oneLine].slice(0, NAME_LIMIT).join("").trim() || fallback;
}

function attr(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatTime(ms: number) {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

// One person's message, as typed, inside a plain attribution tag.
export function envelope(e: Envelope) {
  return `<message from="${attr(agentName(e.author))}" role="${e.role}" sent="${formatTime(e.sentAt)}" delivery="${e.delivery}">\n${neutralize(e.body)}\n</message>`;
}

export function contextBlock(c: RoomContext) {
  const lines = [
    "<room_context>",
    `You are working in the Atelier room "${neutralize(c.roomName)}". More than one person can message you; each message is wrapped in a <message> tag naming its author.`,
    "People in this room:",
    ...c.members.map((m) => `- ${neutralize(agentName(m.name))} (${m.role})`),
    `File edits: ${c.editsEnabled ? "on" : "off"}`,
  ];
  if (c.handbook.trim()) {
    lines.push("Room handbook:", neutralize(c.handbook.trim()));
  }
  lines.push("Recent decisions:");
  if (c.decisions.length === 0) {
    lines.push("- none yet");
  }
  for (const d of c.decisions) {
    const question = d.question ? `${neutralize(d.question)} → ` : "";
    lines.push(
      `- ${question}${neutralize(d.choice)} (decided by ${neutralize(agentName(d.answeredBy))}, ${formatTime(d.at)})`
    );
  }
  lines.push(PRIVATE_CHANNEL_SENTENCE, "</room_context>");
  return lines.join("\n");
}

export function stoppedNote(stoppedBy: string) {
  return `Your previous turn was stopped by ${neutralize(agentName(stoppedBy))} before it finished.`;
}

function decisionFollowUpContext(decision: Doc<"decisions">) {
  return `Follow-up to the owner's decision: ${decision.choice}\nRationale: ${decision.rationale ?? ""}`;
}

function reviewFollowUpContext(request: string, answer: string | undefined) {
  return `Follow-up to your independent review. Original request: ${request}\nYour answer: ${answer ?? "The review turn failed; no answer was returned."}`;
}

// A queued message in its envelope. The owner's follow-up to a decision or a
// review also carries what it follows up, read at delivery time.
export async function renderMessage(
  ctx: QueryCtx,
  message: Doc<"messages">,
  delivery: Envelope["delivery"],
  members?: Doc<"roomMembers">[]
) {
  const author = await ctx.db.get(message.authorParticipantId);
  const text = envelope({
    author: author?.displayName ?? "Someone",
    body: message.body,
    delivery,
    role: roleIn(
      members ?? (await roomMembers(ctx, message.roomId)),
      message.authorParticipantId
    ),
    sentAt: message._creationTime,
  });
  let followUp = "";
  if (message.followUpDecisionId) {
    const decision = await ctx.db.get(message.followUpDecisionId);
    if (decision) {
      followUp = decisionFollowUpContext(decision);
    }
  } else if (message.followUpReviewTurnId) {
    const source = await ctx.db.get(message.followUpReviewTurnId);
    const ritual = source?.ritualId ? await ctx.db.get(source.ritualId) : null;
    if (source && ritual) {
      followUp = reviewFollowUpContext(ritual.request, source.finalText);
    }
  }
  return followUp ? `${text}\n\n${followUp}` : text;
}

export function turnPrompt(p: {
  context: string;
  stoppedBy?: string;
  messages: string[];
}) {
  return [
    p.context,
    ...(p.stoppedBy ? [stoppedNote(p.stoppedBy)] : []),
    ...p.messages,
  ].join("\n\n");
}

export async function roomMembers(ctx: QueryCtx, roomId: Id<"rooms">) {
  return await ctx.db
    .query("roomMembers")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
}

function roleIn(
  members: Doc<"roomMembers">[],
  participantId: Id<"participants">
): MemberRole {
  return members.find((m) => m.participantId === participantId)?.role ===
    "owner"
    ? "owner"
    : "teammate";
}

export async function loadRoomContext(
  ctx: QueryCtx,
  room: Doc<"rooms">,
  rows?: Doc<"roomMembers">[]
): Promise<RoomContext> {
  rows ??= await roomMembers(ctx, room._id);
  const members: RoomContext["members"] = [];
  for (const m of rows.filter((m) => m.removedAt === undefined)) {
    const participant = await ctx.db.get(m.participantId);
    if (participant) {
      members.push({
        name: participant.displayName,
        role: m.role === "owner" ? "owner" : "teammate",
      });
    }
  }
  return {
    decisions: await agentDecisions(ctx, room._id),
    editsEnabled: room.editsEnabled === true,
    handbook: room.handbook,
    members,
    roomName: room.name,
  };
}

// The only view of decisions an agent gets: question, choice, who answered
// and when. Never the rationale or linked team messages, and never a decision
// made on an independent review or on a card raised by a review or its
// follow-up, which stay the owner's.
export async function agentDecisions(
  ctx: QueryCtx,
  roomId: Id<"rooms">
): Promise<AgentDecision[]> {
  const shown = [];
  for await (const d of ctx.db
    .query("decisions")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .order("desc")) {
    if (shown.length === RECENT_DECISIONS) {
      break;
    }
    if (d.ritualId !== undefined) {
      continue;
    }
    const hand = d.handId ? await ctx.db.get(d.handId) : null;
    if (hand) {
      const turn = await ctx.db.get(hand.turnId);
      if (!turn || turn.ritualId || turn.followUp) {
        continue;
      }
    }
    shown.push({ decision: d, hand });
  }
  const out: AgentDecision[] = [];
  for (const { decision: d, hand } of shown.reverse()) {
    const crux = d.cruxId ? await ctx.db.get(d.cruxId) : null;
    const question = hand
      ? cardQuestionText(hand, d.questionId)
      : crux?.statement;
    const answererId =
      d.answeredByParticipantId ??
      (await findLedger(ctx, roomId, "decision.recorded", d._id))
        ?.actorParticipantId;
    const answerer = answererId ? await ctx.db.get(answererId) : null;
    out.push({
      answeredBy: answerer?.displayName ?? "someone",
      at: d._creationTime,
      choice: d.choice,
      question: question ?? "",
    });
  }
  return out;
}

// A decision without a question id answers the whole card, from chat.
function cardQuestionText(hand: Doc<"hands">, questionId: string | undefined) {
  if (questionId !== undefined) {
    return hand.questions.find((q) => q.id === questionId)?.text;
  }
  const [first, ...rest] = hand.questions;
  return (
    first &&
    (rest.length ? `${first.text} (and ${rest.length} more)` : first.text)
  );
}
