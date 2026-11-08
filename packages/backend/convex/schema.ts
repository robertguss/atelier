import { BLOCK_KINDS } from "@atelier/shared";
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

// The room document. A block is one heading, paragraph, item, quote, code
// block or divider.
const [firstKind, ...otherKinds] = BLOCK_KINDS;
export const blockKind = v.union(
  v.literal(firstKind),
  ...otherKinds.map((kind) => v.literal(kind))
);

// Who a block is attributed to: the participant who wrote it, or the scribe,
// with the participant that acted as scribe and the authors it drew from.
export const blockAuthor = v.union(
  v.object({
    kind: v.literal("participant"),
    participantId: v.id("participants"),
  }),
  v.object({
    credits: v.array(v.id("participants")),
    kind: v.literal("scribe"),
    participantId: v.id("participants"),
  })
);

// One version in the history: a model turn's writes, a person's edit session
// on a block, a scribe run, a restore, or the template seeding.
export const changeSetKind = v.union(
  v.literal("template_seed"),
  v.literal("model_turn"),
  v.literal("human_edit"),
  v.literal("scribe_run"),
  v.literal("restore")
);

// A block as history and checkpoints record it.
export const blockState = v.object({
  author: blockAuthor,
  // A to-do's tick. Unset means unticked, and is the only value other kinds have.
  checked: v.optional(v.boolean()),
  kind: blockKind,
  order: v.string(),
  text: v.string(),
});

export const templateSection = v.object({
  guidance: v.optional(v.string()),
  heading: v.string(),
});

export default defineSchema({
  blockRevisions: defineTable({
    after: v.optional(blockState),
    before: v.optional(blockState),
    blockId: v.id("blocks"),
    changeSetId: v.id("changeSets"),
    documentId: v.id("documents"),
    op: v.union(
      v.literal("insert"),
      v.literal("update"),
      v.literal("move"),
      v.literal("delete")
    ),
    // The document rev this revision produced.
    rev: v.number(),
  })
    // Replaying revisions after a checkpoint, in order.
    .index("by_document_rev", ["documentId", "rev"])
    // What one change set changed.
    .index("by_change_set", ["changeSetId"])
    // One block's history.
    .index("by_block", ["blockId"]),

  // One row per block, so an edit rewrites one small row and never a shared
  // array. Deleted blocks keep their row, with `deletedAt` set.
  blocks: defineTable({
    author: blockAuthor,
    checked: v.optional(v.boolean()),
    deletedAt: v.optional(v.number()),
    documentId: v.id("documents"),
    // Guidance text a template seeded, cleared once the text is changed, so
    // saving a room as a template copies guidance and never room content.
    fromTemplate: v.optional(v.boolean()),
    // Set when a human edits a block attributed to someone else.
    humanEditedAt: v.optional(v.number()),
    kind: blockKind,
    // A person's edit lease, and the change set their edits go into.
    leaseChangeSetId: v.optional(v.id("changeSets")),
    leaseExpiresAt: v.optional(v.number()),
    leaseHolderParticipantId: v.optional(v.id("participants")),
    // A fractional-indexing key: blocks sort by it, and an insert between two
    // blocks gets a key between theirs without renumbering the rest.
    order: v.string(),
    // The document rev of the block's latest revision. Writers send it back
    // to detect that someone else changed the block in between.
    rev: v.number(),
    roomId: v.id("rooms"),
    // For a block the scribe wrote: the blocks it was drawn from.
    sourceBlockIds: v.optional(v.array(v.id("blocks"))),
    text: v.string(),
  })
    // Reading the document in order.
    .index("by_document_order", ["documentId", "order"])
    // Live blocks only, in order: removed blocks stay as rows for history and never slow a read.
    .index("by_document_live", ["documentId", "deletedAt", "order"]),

  changeSets: defineTable({
    actorParticipantId: v.optional(v.id("participants")),
    at: v.number(),
    documentId: v.id("documents"),
    kind: changeSetKind,
    // The document rev of its latest revision, and how many it holds.
    lastRev: v.number(),
    revisionCount: v.number(),
    roomId: v.id("rooms"),
    scribeRunId: v.optional(v.id("scribeRuns")),
    turnId: v.optional(v.id("turns")),
  })
    // History, newest first.
    .index("by_document", ["documentId"])
    // A model turn's writes all join that turn's one change set.
    .index("by_turn", ["turnId"])
    // A scribe run commits as one change set.
    .index("by_scribe_run", ["scribeRunId"]),

  checkpointBlocks: defineTable({
    blockId: v.id("blocks"),
    checkpointId: v.id("documentCheckpoints"),
    ...blockState.fields,
  })
    // Loading one checkpoint's blocks.
    .index("by_checkpoint", ["checkpointId"]),

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

  comments: defineTable({
    authorParticipantId: v.id("participants"),
    body: v.string(),
    // The model participants a person's comment @mentions; each was sent a
    // thread delivery. Always empty on a model's comment, which summons no one.
    mentions: v.array(v.id("participants")),
    roomId: v.id("rooms"),
    threadId: v.id("threads"),
    // The model turn that wrote it, for a model's comment.
    turnId: v.optional(v.id("turns")),
  })
    // A thread's comments in order.
    .index("by_thread", ["threadId"])
    // A model turn's comments, to apply its per-turn cap.
    .index("by_turn", ["turnId"]),

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
  documentCheckpoints: defineTable({
    blockCount: v.number(),
    documentId: v.id("documents"),
    reason: v.union(
      v.literal("interval"),
      v.literal("before_scribe"),
      v.literal("after_scribe"),
      v.literal("before_restore")
    ),
    rev: v.number(),
  })
    // Finding the nearest checkpoint at or before a rev.
    .index("by_document_rev", ["documentId", "rev"]),

  // One shared document per room. `rev` counts every block revision ever
  // written to it. The scribe lock is set while a scribe run owns the document.
  documents: defineTable({
    rev: v.number(),
    // Revisions since the last checkpoint; a checkpoint is taken every 200.
    revisionsSinceCheckpoint: v.number(),
    roomId: v.id("rooms"),
    scribeLockExpiresAt: v.optional(v.number()),
    scribeRunId: v.optional(v.id("scribeRuns")),
    seededAt: v.number(),
    // The template it was seeded from. Missing means Atelier's default.
    templateId: v.optional(v.id("templates")),
  })
    // Each room has one document, found from the room.
    .index("by_room", ["roomId"]),

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
    commentId: v.optional(v.id("comments")),
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
    streamOffset: v.optional(v.number()),
    // A thread delivery: a person's comment that @mentions this agent. It
    // waits in the agent's queue like a message, but runs as its own turn,
    // whose reply goes into the thread. Never shown as a chat message.
    threadId: v.optional(v.id("threads")),
    toParticipantId: v.optional(v.id("participants")),
    turnId: v.optional(v.id("turns")),
    visibility: v.union(v.literal("room"), v.literal("sealed")),
  })
    .index("by_room", ["roomId"])
    .index("by_ritual", ["ritualId"])
    .index("by_to_delivery", ["toParticipantId", "delivery"])
    // The deliveries a comment's mentions created.
    .index("by_comment", ["commentId"]),

  participants: defineTable({
    displayName: v.string(),
    // The document rev that session has seen, so its next turn is shown only
    // what changed since. It belongs to `harnessSessionId`, never another session.
    documentRevSeen: v.optional(v.number()),
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
    // Follow-ups run on these harness sessions, one per participant, never on
    // the participant's ordinary session. Each keeps the document rev its
    // session has seen.
    followUpSessions: v.optional(
      v.array(
        v.object({
          documentRevSeen: v.optional(v.number()),
          participantId: v.id("participants"),
          sessionId: v.string(),
        })
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
  })
    // A runner's rooms, to deliver what waited while it was offline.
    .index("by_runner", ["runnerId"]),

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

  // One row per operation in a scribe run's draft, so a large draft never
  // forms one oversized row. Applied in `seq` order when the run commits.
  // An op names a block already in the document by `blockId`, or one the
  // draft adds by the `seq` of its add op (`targetSeq`); likewise for the
  // block it goes after (`afterBlockId`, `afterSeq`, or `atStart`). With
  // none of those it goes at the end.
  scribeDraftOps: defineTable({
    afterBlockId: v.optional(v.id("blocks")),
    afterSeq: v.optional(v.number()),
    atStart: v.optional(v.boolean()),
    blockId: v.optional(v.id("blocks")),
    kind: v.optional(blockKind),
    op: v.union(
      v.literal("keep"),
      v.literal("replace"),
      v.literal("add"),
      v.literal("remove"),
      v.literal("move")
    ),
    scribeRunId: v.id("scribeRuns"),
    seq: v.number(),
    sourceBlockIds: v.optional(v.array(v.id("blocks"))),
    targetSeq: v.optional(v.number()),
    text: v.optional(v.string()),
  })
    // A run's draft, in order.
    .index("by_run_seq", ["scribeRunId", "seq"]),

  // A scribe run: the participant acting as scribe and how the run ended.
  scribeRuns: defineTable({
    documentId: v.id("documents"),
    endedAt: v.optional(v.number()),
    participantId: v.id("participants"),
    // Why a released run ended without changing the document.
    releaseReason: v.optional(v.string()),
    roomId: v.id("rooms"),
    startedAt: v.number(),
    startedByParticipantId: v.id("participants"),
    status: v.union(
      v.literal("running"),
      v.literal("committed"),
      v.literal("released")
    ),
    turnId: v.optional(v.id("turns")),
  })
    // A document's runs.
    .index("by_document", ["documentId"]),

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
  // Robert's templates: an ordered list of headings, each with optional
  // guidance text. Atelier's default is a code constant, not a row.
  templates: defineTable({
    name: v.string(),
    ownerUserId: v.id("users"),
    sections: v.array(templateSection),
  })
    // Listing the owner's templates.
    .index("by_owner", ["ownerUserId"]),

  // A comment thread on a passage of a block. The anchor is a text-quote
  // selector (the passage, with text before and after) plus its character
  // position in the block's plain text.
  threads: defineTable({
    blockId: v.id("blocks"),
    // Set when the passage was removed: the change set that removed it.
    detachedBeforeChangeSetId: v.optional(v.id("changeSets")),
    documentId: v.id("documents"),
    exact: v.string(),
    position: v.number(),
    prefix: v.string(),
    roomId: v.id("rooms"),
    state: v.union(v.literal("open"), v.literal("settled")),
    suffix: v.string(),
  })
    // Open threads in a document, and settled ones for the Settled section.
    .index("by_document_state", ["documentId", "state"])
    // Threads on one block, to re-anchor when its text changes.
    .index("by_block", ["blockId"]),

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
    // The document rev the turn's claim showed it. Saved beside its session
    // when the turn finishes, never before, so a failed turn advances nothing.
    documentRev: v.optional(v.number()),
    editsEnabled: v.optional(v.boolean()),
    endedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    finalText: v.optional(v.string()),
    // Marks a turn that follows up an independent review or its decision.
    // Such a turn is owner-only and must never be batched with other
    // messages. `separateSession` is fixed at claim: true when the turn ran on
    // the review's own session. Every follow-up claimed once rooms had a
    // document is; older solo follow-ups continued the ordinary session.
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
    // Set on the turn that acts as scribe for a scribe run. Like a review, it
    // runs on a fresh session that is never saved, with file edits off, and
    // takes no steer; it changes the document only through its draft.
    scribeRunId: v.optional(v.id("scribeRuns")),
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
    // Set on a turn that answers an @mention in a comment thread. It runs
    // alone, takes no steer, and its final text becomes a reply in the thread.
    threadId: v.optional(v.id("threads")),
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
