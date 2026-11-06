import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// See docs/v0-spec.md, "Data model". Domain tables hold current state.
// `ledger` is append-only: every mutation that matters to collaboration adds
// a row there in the same transaction.

export const harnessId = v.union(
  v.literal("claude"),
  v.literal("codex"),
  v.literal("pi")
);

// queued: waiting for the agent's current turn to end.
// steering: sent into the running turn, waiting for the harness to accept it.
// steered: the harness took it mid-turn. delivered: carried by a new turn.
// answeredCard: it answered the agent's open question card.
// cancelled: never delivered; see cancelReason.
export const deliveryState = v.union(
  v.literal("queued"),
  v.literal("steering"),
  v.literal("steered"),
  v.literal("delivered"),
  v.literal("answeredCard"),
  v.literal("cancelled")
);

export const commandType = v.union(
  v.literal("run_turn"),
  v.literal("interrupt"),
  v.literal("steer"),
  v.literal("answer"),
  v.literal("settings")
);

// One question on a card. `id` is the harness's own question id, or any id
// the runner chooses that is unique on the card.
export const cardQuestion = v.object({
  allowFreeText: v.boolean(),
  header: v.string(),
  id: v.string(),
  multiSelect: v.boolean(),
  options: v.array(
    v.object({ description: v.optional(v.string()), label: v.string() })
  ),
  text: v.string(),
});

export const cardAnswer = v.object({
  freeText: v.optional(v.string()),
  labels: v.array(v.string()),
  questionId: v.string(),
});

export default defineSchema({
  commands: defineTable({
    error: v.optional(v.string()),
    leaseExpiresAt: v.optional(v.number()),
    payload: v.optional(v.any()),
    runnerId: v.id("runners"),
    status: v.union(
      v.literal("pending"),
      v.literal("claimed"),
      v.literal("done"),
      v.literal("failed")
    ),
    turnId: v.id("turns"),
    // run_turn starts a turn. The others are control commands for a turn that
    // is already running, and carry what the runner needs in `payload`.
    type: commandType,
  })
    .index("by_runner_status", ["runnerId", "status"])
    .index("by_turn", ["turnId"])
    .index("by_status_lease", ["status", "leaseExpiresAt"]),

  cruxes: defineTable({
    authorParticipantId: v.id("participants"),
    options: v.array(v.string()),
    ritualId: v.id("rituals"),
    roomId: v.id("rooms"),
    statement: v.string(),
  }).index("by_ritual", ["ritualId"]),

  decisions: defineTable({
    answeredByParticipantId: v.optional(v.id("participants")),
    choice: v.string(),
    cruxId: v.optional(v.id("cruxes")),
    // Set on a decision recorded by answering a card: one per question when
    // answered on the card, or one for the whole card, without a question id,
    // when answered by a chat message.
    handId: v.optional(v.id("hands")),
    questionId: v.optional(v.string()),
    rationale: v.optional(v.string()),
    ritualId: v.optional(v.id("rituals")),
    roomId: v.id("rooms"),
  }).index("by_room", ["roomId"]),

  // A question card: one to four questions an agent asked through its
  // harness's own question prompt. Answered whole, once, by whoever is first.
  hands: defineTable({
    answeredAt: v.optional(v.number()),
    answeredByParticipantId: v.optional(v.id("participants")),
    answers: v.optional(v.array(cardAnswer)),
    // When a card closed without an answer (closedAt), and why (closeReason).
    closeReason: v.optional(v.string()),
    closedAt: v.optional(v.number()),
    participantId: v.id("participants"),
    questions: v.array(cardQuestion),
    raisedAt: v.number(),
    // The harness's id for the pending request, so the runner can route the answer.
    requestId: v.string(),
    roomId: v.id("rooms"),
    status: v.union(
      v.literal("raised"),
      v.literal("answered"),
      v.literal("cancelled"),
      v.literal("expired")
    ),
    turnId: v.id("turns"),
    via: v.optional(v.union(v.literal("card"), v.literal("chat"))),
  })
    .index("by_room_status", ["roomId", "status"])
    .index("by_turn", ["turnId"]),

  ledger: defineTable({
    actorParticipantId: v.optional(v.id("participants")),
    at: v.number(),
    harnessVersion: v.optional(v.string()),
    model: v.optional(v.string()),
    parentLedgerId: v.optional(v.id("ledger")),
    payload: v.optional(v.any()),
    provider: v.optional(v.string()),
    roomId: v.optional(v.id("rooms")),
    subjectId: v.optional(v.string()),
    type: v.string(),
  })
    .index("by_room", ["roomId"])
    .index("by_room_type", ["roomId", "type", "subjectId"]),

  messages: defineTable({
    authorParticipantId: v.id("participants"),
    body: v.string(),
    cancelReason: v.optional(v.string()),
    // A person's message to an agent waits in that agent's queue: see
    // toParticipantId, delivery and deliveredTurnId. Agent replies and older
    // messages have no delivery state.
    deliveredTurnId: v.optional(v.id("turns")),
    delivery: v.optional(deliveryState),
    // What a follow-up refers to, so its context can be built when it is
    // dispatched rather than when it is sent.
    followUpDecisionId: v.optional(v.id("decisions")),
    followUpReviewTurnId: v.optional(v.id("turns")),
    // Set on a follow-up to an independent review or its decision, and on the
    // agent's reply. Only the owner sees these.
    followUpRitualId: v.optional(v.id("rituals")),
    ritualId: v.optional(v.id("rituals")),
    roomId: v.id("rooms"),
    // Set while a steer is in flight to a running turn.
    steering: v.optional(
      v.object({ commandId: v.id("commands"), turnId: v.id("turns") })
    ),
    toParticipantId: v.optional(v.id("participants")),
    turnId: v.optional(v.id("turns")),
    visibility: v.union(v.literal("room"), v.literal("sealed")),
  })
    .index("by_room", ["roomId"])
    .index("by_ritual", ["ritualId"])
    .index("by_to_delivery", ["toParticipantId", "delivery"]),

  participants: defineTable({
    displayName: v.string(),
    harness: v.optional(harnessId),
    harnessSessionId: v.optional(v.string()),
    kind: v.union(v.literal("human"), v.literal("harness")),
    model: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    roomId: v.id("rooms"),
    userId: v.optional(v.id("users")),
  }).index("by_room", ["roomId"]),

  pushTokens: defineTable({
    platform: v.string(),
    token: v.string(),
    userSubject: v.string(),
  }).index("by_user", ["userSubject"]),

  reviewSnapshots: defineTable({
    ritualId: v.id("rituals"),
    text: v.string(),
  }).index("by_ritual", ["ritualId"]),

  rituals: defineTable({
    // In rooms with a teammate, follow-ups run on these harness sessions, one
    // per participant, never on the participant's ordinary session.
    followUpSessions: v.optional(
      v.array(
        v.object({ participantId: v.id("participants"), sessionId: v.string() })
      )
    ),
    ownerSubject: v.optional(v.string()),
    participantIds: v.array(v.id("participants")),
    pushStatus: v.optional(
      v.union(
        v.literal("queued"),
        v.literal("sent"),
        v.literal("skipped"),
        v.literal("failed")
      )
    ),
    request: v.string(),
    revealedAt: v.optional(v.number()),
    roomId: v.id("rooms"),
    snapshot: v.optional(v.string()),
    status: v.union(
      v.literal("collecting"),
      v.literal("revealed"),
      v.literal("decided")
    ),
    type: v.literal("independent_review"),
    workflowId: v.optional(v.string()),
  }).index("by_room", ["roomId"]),

  // An invite is for one room and one email address. Only a hash of the
  // token is stored; the token itself lives in the invite link.
  roomInvites: defineTable({
    acceptedAt: v.optional(v.number()),
    acceptedByUserId: v.optional(v.id("users")),
    clerkInvitationId: v.optional(v.string()),
    email: v.string(),
    expiresAt: v.number(),
    revokedAt: v.optional(v.number()),
    roomId: v.id("rooms"),
    status: v.union(
      v.literal("pending"),
      v.literal("accepted"),
      v.literal("revoked"),
      v.literal("expired")
    ),
    tokenHash: v.string(),
  })
    .index("by_room", ["roomId"])
    .index("by_token_hash", ["tokenHash"]),

  // Room membership is separate from participants, so removing someone ends
  // their access without touching the authorship of what they wrote.
  roomMembers: defineTable({
    noticeAcceptedAt: v.optional(v.number()),
    noticeVersion: v.optional(v.number()),
    participantId: v.id("participants"),
    removedAt: v.optional(v.number()),
    role: v.union(v.literal("owner"), v.literal("member")),
    roomId: v.id("rooms"),
    userId: v.id("users"),
  })
    .index("by_room", ["roomId"])
    .index("by_user", ["userId"])
    .index("by_room_user", ["roomId", "userId"]),

  rooms: defineTable({
    archivedAt: v.optional(v.number()),
    cwd: v.string(),
    // Whether agents may edit files in the room's folder. Missing means off.
    editsEnabled: v.optional(v.boolean()),
    handbook: v.string(),
    name: v.string(),
    runnerId: v.id("runners"),
  }),

  runners: defineTable({
    // Kept apart from `harnesses`, which every heartbeat replaces.
    harnessCapabilities: v.optional(
      v.array(v.object({ canRaiseCards: v.boolean(), id: harnessId }))
    ),
    harnesses: v.array(v.object({ id: harnessId, version: v.string() })),
    lastHeartbeatAt: v.number(),
    machine: v.string(),
    name: v.string(),
  }).index("by_name", ["name"]),

  takeaways: defineTable({
    authorParticipantId: v.id("participants"),
    body: v.string(),
    ritualId: v.id("rituals"),
  }).index("by_ritual", ["ritualId"]),

  // Humans-only chat. A separate table so nothing that reads agent messages
  // or builds prompts can reach it. Posts cannot be edited or deleted.
  teamMessages: defineTable({
    authorParticipantId: v.id("participants"),
    authorUserId: v.id("users"),
    body: v.string(),
    roomId: v.id("rooms"),
  }).index("by_room", ["roomId"]),

  // An agent's tool activity during a turn, one row per tool call: its name
  // and a one-line summary. Raw output stays on the runner's disk.
  turnItems: defineTable({
    callId: v.string(),
    name: v.string(),
    ok: v.optional(v.boolean()),
    seq: v.number(),
    summary: v.string(),
    turnId: v.id("turns"),
  }).index("by_turn_call", ["turnId", "callId"]),

  // A turn's streamed text, one row per turn. Kept apart from the turn so the
  // runner's twice-a-second writes only reach the query for active turns.
  turnStreams: defineTable({
    text: v.string(),
    turnId: v.id("turns"),
  }).index("by_turn", ["turnId"]),

  turns: defineTable({
    editsEnabled: v.optional(v.boolean()),
    endedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    finalText: v.optional(v.string()),
    // Marks a turn that follows up an independent review or its decision.
    // Such a turn is owner-only and must never be batched with other
    // messages. `separateSession` is fixed at claim: true when the room had an
    // active teammate, so the turn ran on the review's own session.
    followUp: v.optional(
      v.object({
        decisionId: v.optional(v.id("decisions")),
        ritualId: v.id("rituals"),
        separateSession: v.optional(v.boolean()),
      })
    ),
    harnessVersion: v.optional(v.string()),
    // Older turns kept their streamed text here. New text goes to turnStreams,
    // so streaming does not rewrite the turn every half second.
    partialText: v.optional(v.string()),
    participantId: v.id("participants"),
    prompt: v.string(),
    // The people whose queued messages this turn carries.
    requestedByParticipantIds: v.optional(v.array(v.id("participants"))),
    ritualId: v.optional(v.id("rituals")),
    roomId: v.id("rooms"),
    startedAt: v.optional(v.number()),
    status: v.union(
      v.literal("queued"),
      v.literal("running"),
      v.literal("done"),
      v.literal("failed"),
      v.literal("interrupted")
    ),
    // The person who stopped the turn, so the agent's next prompt can say so.
    stoppedByParticipantId: v.optional(v.id("participants")),
    transcriptRef: v.optional(v.string()),
    usage: v.optional(
      v.object({
        costUsd: v.optional(v.number()),
        inputTokens: v.number(),
        outputTokens: v.number(),
      })
    ),
    // Set while the agent waits on an open question card. The turn stays running.
    waitingOnHandId: v.optional(v.id("hands")),
  })
    .index("by_room", ["roomId"])
    .index("by_ritual", ["ritualId"])
    .index("by_participant", ["participantId"])
    .index("by_participant_status", ["participantId", "status"])
    .index("by_room_status", ["roomId", "status"]),

  // One row per signed-in person, keyed on Clerk's tokenIdentifier so a
  // changed email address does not split or merge accounts.
  users: defineTable({
    email: v.optional(v.string()),
    name: v.optional(v.string()),
    tokenIdentifier: v.string(),
  }).index("by_token", ["tokenIdentifier"]),
});
