import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// See docs/v0-spec.md, "Data model". Domain tables hold current state.
// `ledger` is append-only: every mutation that matters to collaboration adds
// a row there in the same transaction.

export const harnessId = v.union(v.literal('claude'), v.literal('codex'), v.literal('pi'));

// queued: waiting for the agent's current turn to end.
// steering: sent into the running turn, waiting for the harness to accept it.
// steered: the harness took it mid-turn. delivered: carried by a new turn.
// answeredCard: it answered the agent's open question card.
// cancelled: never delivered; see cancelReason.
export const deliveryState = v.union(
  v.literal('queued'),
  v.literal('steering'),
  v.literal('steered'),
  v.literal('delivered'),
  v.literal('answeredCard'),
  v.literal('cancelled'),
);

export const commandType = v.union(
  v.literal('run_turn'),
  v.literal('interrupt'),
  v.literal('steer'),
  v.literal('answer'),
  v.literal('settings'),
);

// One question on a card. `id` is the harness's own question id, or any id
// the runner chooses that is unique on the card.
export const cardQuestion = v.object({
  id: v.string(),
  header: v.string(),
  text: v.string(),
  options: v.array(v.object({ label: v.string(), description: v.optional(v.string()) })),
  multiSelect: v.boolean(),
  allowFreeText: v.boolean(),
});

// The answer to one question: the chosen option labels, free text, or both.
export const cardAnswer = v.object({
  questionId: v.string(),
  labels: v.array(v.string()),
  freeText: v.optional(v.string()),
});

export default defineSchema({
  runners: defineTable({
    name: v.string(),
    machine: v.string(),
    lastHeartbeatAt: v.number(),
    harnesses: v.array(v.object({ id: harnessId, version: v.string() })),
    // What each harness can do on this runner, as the runner last reported.
    // Kept apart from `harnesses`, which every heartbeat replaces.
    harnessCapabilities: v.optional(v.array(v.object({ id: harnessId, canRaiseCards: v.boolean() }))),
  }).index('by_name', ['name']),

  // One row per signed-in person, keyed on Clerk's tokenIdentifier so a
  // changed email address does not split or merge accounts.
  users: defineTable({
    tokenIdentifier: v.string(),
    email: v.optional(v.string()),
    name: v.optional(v.string()),
  }).index('by_token', ['tokenIdentifier']),

  // Room membership is separate from participants, so removing someone ends
  // their access without touching the authorship of what they wrote.
  roomMembers: defineTable({
    roomId: v.id('rooms'),
    userId: v.id('users'),
    role: v.union(v.literal('owner'), v.literal('member')),
    participantId: v.id('participants'),
    noticeVersion: v.optional(v.number()),
    noticeAcceptedAt: v.optional(v.number()),
    removedAt: v.optional(v.number()),
  })
    .index('by_room', ['roomId'])
    .index('by_user', ['userId'])
    .index('by_room_user', ['roomId', 'userId']),

  // An invite is for one room and one email address. Only a hash of the
  // token is stored; the token itself lives in the invite link.
  roomInvites: defineTable({
    roomId: v.id('rooms'),
    email: v.string(),
    tokenHash: v.string(),
    expiresAt: v.number(),
    status: v.union(v.literal('pending'), v.literal('accepted'), v.literal('revoked'), v.literal('expired')),
    clerkInvitationId: v.optional(v.string()),
    acceptedByUserId: v.optional(v.id('users')),
    acceptedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
  })
    .index('by_room', ['roomId'])
    .index('by_token_hash', ['tokenHash']),

  rooms: defineTable({
    name: v.string(),
    runnerId: v.id('runners'),
    cwd: v.string(),
    handbook: v.string(),
    archivedAt: v.optional(v.number()),
    // Whether agents may edit files in the room's folder. Missing means off.
    editsEnabled: v.optional(v.boolean()),
  }),

  participants: defineTable({
    roomId: v.id('rooms'),
    kind: v.union(v.literal('human'), v.literal('harness')),
    harness: v.optional(harnessId),
    model: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    displayName: v.string(),
    harnessSessionId: v.optional(v.string()),
    // The signed-in person behind a human participant.
    userId: v.optional(v.id('users')),
  }).index('by_room', ['roomId']),

  messages: defineTable({
    roomId: v.id('rooms'),
    authorParticipantId: v.id('participants'),
    body: v.string(),
    ritualId: v.optional(v.id('rituals')),
    turnId: v.optional(v.id('turns')),
    visibility: v.union(v.literal('room'), v.literal('sealed')),
    // Set on a follow-up to an independent review or its decision, and on the
    // agent's reply. Only the owner sees these.
    followUpRitualId: v.optional(v.id('rituals')),
    // What a follow-up refers to, so its context can be built when it is
    // dispatched rather than when it is sent.
    followUpDecisionId: v.optional(v.id('decisions')),
    followUpReviewTurnId: v.optional(v.id('turns')),
    // A person's message to an agent waits in that agent's queue. Agent
    // replies and older messages have no delivery state.
    toParticipantId: v.optional(v.id('participants')),
    delivery: v.optional(deliveryState),
    // The turn that carried the message to the agent.
    deliveredTurnId: v.optional(v.id('turns')),
    // Set while a steer is in flight to a running turn.
    steering: v.optional(v.object({ turnId: v.id('turns'), commandId: v.id('commands') })),
    cancelReason: v.optional(v.string()),
  })
    .index('by_room', ['roomId'])
    .index('by_ritual', ['ritualId'])
    .index('by_to_delivery', ['toParticipantId', 'delivery']),

  // Humans-only chat. A separate table so nothing that reads agent messages
  // or builds prompts can reach it. Posts cannot be edited or deleted.
  teamMessages: defineTable({
    roomId: v.id('rooms'),
    authorUserId: v.id('users'),
    authorParticipantId: v.id('participants'),
    body: v.string(),
  }).index('by_room', ['roomId']),

  turns: defineTable({
    roomId: v.id('rooms'),
    participantId: v.id('participants'),
    ritualId: v.optional(v.id('rituals')),
    status: v.union(
      v.literal('queued'),
      v.literal('running'),
      v.literal('done'),
      v.literal('failed'),
      v.literal('interrupted'),
    ),
    prompt: v.string(),
    partialText: v.optional(v.string()),
    finalText: v.optional(v.string()),
    usage: v.optional(
      v.object({
        inputTokens: v.number(),
        outputTokens: v.number(),
        costUsd: v.optional(v.number()),
      }),
    ),
    transcriptRef: v.optional(v.string()),
    harnessVersion: v.optional(v.string()),
    error: v.optional(v.string()),
    startedAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    // Marks a turn that follows up an independent review or its decision.
    // Such a turn is owner-only and must never be batched with other
    // messages. `separateSession` is fixed at claim: true when the room had an
    // active teammate, so the turn ran on the review's own session.
    followUp: v.optional(
      v.object({
        ritualId: v.id('rituals'),
        decisionId: v.optional(v.id('decisions')),
        separateSession: v.optional(v.boolean()),
      }),
    ),
    // The people whose queued messages this turn carries.
    requestedByParticipantIds: v.optional(v.array(v.id('participants'))),
    // The room's edit switch when the turn was dispatched.
    editsEnabled: v.optional(v.boolean()),
    // Set while the agent waits on an open question card. The turn stays running.
    waitingOnHandId: v.optional(v.id('hands')),
    // The person who stopped the turn, so the agent's next prompt can say so.
    stoppedByParticipantId: v.optional(v.id('participants')),
  })
    .index('by_room', ['roomId'])
    .index('by_ritual', ['ritualId'])
    .index('by_participant', ['participantId']),

  rituals: defineTable({
    roomId: v.id('rooms'),
    type: v.literal('independent_review'),
    status: v.union(v.literal('collecting'), v.literal('revealed'), v.literal('decided')),
    request: v.string(),
    participantIds: v.array(v.id('participants')),
    revealedAt: v.optional(v.number()),
    workflowId: v.optional(v.string()),
    ownerSubject: v.optional(v.string()),
    snapshot: v.optional(v.string()),
    pushStatus: v.optional(v.union(v.literal('queued'), v.literal('sent'), v.literal('skipped'), v.literal('failed'))),
    // In rooms with a teammate, follow-ups run on these harness sessions, one
    // per participant, never on the participant's ordinary session.
    followUpSessions: v.optional(v.array(v.object({ participantId: v.id('participants'), sessionId: v.string() }))),
  }).index('by_room', ['roomId']),

  reviewSnapshots: defineTable({
    ritualId: v.id('rituals'),
    text: v.string(),
  }).index('by_ritual', ['ritualId']),

  takeaways: defineTable({
    ritualId: v.id('rituals'),
    body: v.string(),
    authorParticipantId: v.id('participants'),
  }).index('by_ritual', ['ritualId']),

  cruxes: defineTable({
    ritualId: v.id('rituals'),
    roomId: v.id('rooms'),
    statement: v.string(),
    options: v.array(v.string()),
    authorParticipantId: v.id('participants'),
  }).index('by_ritual', ['ritualId']),

  decisions: defineTable({
    roomId: v.id('rooms'),
    cruxId: v.optional(v.id('cruxes')),
    ritualId: v.optional(v.id('rituals')),
    choice: v.string(),
    rationale: v.optional(v.string()),
    // Set on a decision recorded by answering one question on a card.
    handId: v.optional(v.id('hands')),
    questionId: v.optional(v.string()),
    answeredByParticipantId: v.optional(v.id('participants')),
  }).index('by_room', ['roomId']),

  // A question card: one to four questions an agent asked through its
  // harness's own question prompt. Answered whole, once, by whoever is first.
  hands: defineTable({
    roomId: v.id('rooms'),
    turnId: v.id('turns'),
    participantId: v.id('participants'),
    // The harness's id for the pending request, so the runner can route the answer.
    requestId: v.string(),
    questions: v.array(cardQuestion),
    status: v.union(v.literal('raised'), v.literal('answered'), v.literal('cancelled'), v.literal('expired')),
    answers: v.optional(v.array(cardAnswer)),
    answeredByParticipantId: v.optional(v.id('participants')),
    answeredAt: v.optional(v.number()),
    via: v.optional(v.union(v.literal('card'), v.literal('chat'))),
    raisedAt: v.number(),
    // When a card closed without an answer, and why.
    closedAt: v.optional(v.number()),
    closeReason: v.optional(v.string()),
  })
    .index('by_room_status', ['roomId', 'status'])
    .index('by_turn', ['turnId']),

  commands: defineTable({
    runnerId: v.id('runners'),
    // run_turn starts a turn. The others are control commands for a turn that
    // is already running, and carry what the runner needs in `payload`.
    type: commandType,
    turnId: v.id('turns'),
    payload: v.optional(v.any()),
    status: v.union(
      v.literal('pending'),
      v.literal('claimed'),
      v.literal('done'),
      v.literal('failed'),
    ),
    leaseExpiresAt: v.optional(v.number()),
    error: v.optional(v.string()),
  }).index('by_runner_status', ['runnerId', 'status']),

  ledger: defineTable({
    roomId: v.optional(v.id('rooms')),
    type: v.string(),
    actorParticipantId: v.optional(v.id('participants')),
    subjectId: v.optional(v.string()),
    parentLedgerId: v.optional(v.id('ledger')),
    provider: v.optional(v.string()),
    model: v.optional(v.string()),
    harnessVersion: v.optional(v.string()),
    payload: v.optional(v.any()),
    at: v.number(),
  })
    .index('by_room', ['roomId'])
    .index('by_room_type', ['roomId', 'type', 'subjectId']),

  pushTokens: defineTable({
    userSubject: v.string(),
    token: v.string(),
    platform: v.string(),
  }).index('by_user', ['userSubject']),
});
