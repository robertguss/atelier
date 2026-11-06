import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

// See docs/v0-spec.md, "Data model". Domain tables hold current state.
// `ledger` is append-only: every mutation that matters to collaboration adds
// a row there in the same transaction.

export const harnessId = v.union(v.literal('claude'), v.literal('codex'), v.literal('pi'));

export default defineSchema({
  runners: defineTable({
    name: v.string(),
    machine: v.string(),
    lastHeartbeatAt: v.number(),
    harnesses: v.array(v.object({ id: harnessId, version: v.string() })),
  }).index('by_name', ['name']),

  rooms: defineTable({
    name: v.string(),
    runnerId: v.id('runners'),
    cwd: v.string(),
    handbook: v.string(),
    archivedAt: v.optional(v.number()),
  }),

  participants: defineTable({
    roomId: v.id('rooms'),
    kind: v.union(v.literal('human'), v.literal('harness')),
    harness: v.optional(harnessId),
    model: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    displayName: v.string(),
    harnessSessionId: v.optional(v.string()),
  }).index('by_room', ['roomId']),

  messages: defineTable({
    roomId: v.id('rooms'),
    authorParticipantId: v.id('participants'),
    body: v.string(),
    ritualId: v.optional(v.id('rituals')),
    turnId: v.optional(v.id('turns')),
    visibility: v.union(v.literal('room'), v.literal('sealed')),
  })
    .index('by_room', ['roomId'])
    .index('by_ritual', ['ritualId']),

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
  })
    .index('by_room', ['roomId'])
    .index('by_ritual', ['ritualId']),

  rituals: defineTable({
    roomId: v.id('rooms'),
    type: v.literal('independent_review'),
    status: v.union(v.literal('collecting'), v.literal('revealed'), v.literal('decided')),
    request: v.string(),
    participantIds: v.array(v.id('participants')),
    revealedAt: v.optional(v.number()),
  }).index('by_room', ['roomId']),

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
  }).index('by_room', ['roomId']),

  hands: defineTable({
    roomId: v.id('rooms'),
    turnId: v.id('turns'),
    participantId: v.id('participants'),
    question: v.string(),
    options: v.array(v.string()),
    status: v.union(v.literal('raised'), v.literal('answered')),
    answer: v.optional(v.string()),
  }).index('by_room_status', ['roomId', 'status']),

  commands: defineTable({
    runnerId: v.id('runners'),
    type: v.union(v.literal('run_turn'), v.literal('interrupt')),
    turnId: v.id('turns'),
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
  }).index('by_room', ['roomId']),

  pushTokens: defineTable({
    userSubject: v.string(),
    token: v.string(),
    platform: v.string(),
  }).index('by_user', ['userSubject']),
});
