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

export const cardAnswer = v.object({
  questionId: v.string(),
  labels: v.array(v.string()),
  freeText: v.optional(v.string()),
});

// The room document. A block is one heading, paragraph or list item.
export const blockKind = v.union(v.literal('heading'), v.literal('paragraph'), v.literal('listItem'));

// Who a block is attributed to: the participant who wrote it, or the scribe,
// with the participant that acted as scribe and the authors it drew from.
export const blockAuthor = v.union(
  v.object({ kind: v.literal('participant'), participantId: v.id('participants') }),
  v.object({
    kind: v.literal('scribe'),
    participantId: v.id('participants'),
    credits: v.array(v.id('participants')),
  }),
);

// One version in the history: a model turn's writes, a person's edit session
// on a block, a scribe run, a restore, or the template seeding.
export const changeSetKind = v.union(
  v.literal('template_seed'),
  v.literal('model_turn'),
  v.literal('human_edit'),
  v.literal('scribe_run'),
  v.literal('restore'),
);

// A block as history and checkpoints record it.
export const blockState = v.object({
  order: v.string(),
  kind: blockKind,
  text: v.string(),
  author: blockAuthor,
});

export const templateSection = v.object({ heading: v.string(), guidance: v.optional(v.string()) });

export default defineSchema({
  runners: defineTable({
    name: v.string(),
    machine: v.string(),
    lastHeartbeatAt: v.number(),
    harnesses: v.array(v.object({ id: harnessId, version: v.string() })),
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
  })
    // A runner's rooms, to deliver what waited while it was offline.
    .index('by_runner', ['runnerId']),

  participants: defineTable({
    roomId: v.id('rooms'),
    kind: v.union(v.literal('human'), v.literal('harness')),
    harness: v.optional(harnessId),
    model: v.optional(v.string()),
    reasoning: v.optional(v.string()),
    displayName: v.string(),
    harnessSessionId: v.optional(v.string()),
    // The document rev that session has seen, so its next turn is shown only
    // what changed since. It belongs to `harnessSessionId`, never another session.
    documentRevSeen: v.optional(v.number()),
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
    deliveredTurnId: v.optional(v.id('turns')),
    // Set while a steer is in flight to a running turn.
    steering: v.optional(v.object({ turnId: v.id('turns'), commandId: v.id('commands') })),
    cancelReason: v.optional(v.string()),
    // A thread delivery: a person's comment that @mentions this agent. It
    // waits in the agent's queue like a message, but runs as its own turn,
    // whose reply goes into the thread. Never shown as a chat message.
    threadId: v.optional(v.id('threads')),
    commentId: v.optional(v.id('comments')),
  })
    .index('by_room', ['roomId'])
    .index('by_ritual', ['ritualId'])
    .index('by_to_delivery', ['toParticipantId', 'delivery'])
    // The deliveries a comment's mentions created.
    .index('by_comment', ['commentId']),

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
    // Older turns kept their streamed text here. New text goes to turnStreams,
    // so streaming does not rewrite the turn every half second.
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
    // messages. `separateSession` is fixed at claim: true when the turn ran on
    // the review's own session. Every follow-up claimed once rooms had a
    // document is; older solo follow-ups continued the ordinary session.
    followUp: v.optional(
      v.object({
        ritualId: v.id('rituals'),
        decisionId: v.optional(v.id('decisions')),
        separateSession: v.optional(v.boolean()),
      }),
    ),
    // The people whose queued messages this turn carries.
    requestedByParticipantIds: v.optional(v.array(v.id('participants'))),
    editsEnabled: v.optional(v.boolean()),
    // Set while the agent waits on an open question card. The turn stays running.
    waitingOnHandId: v.optional(v.id('hands')),
    // The person who stopped the turn, so the agent's next prompt can say so.
    stoppedByParticipantId: v.optional(v.id('participants')),
    // Set on a turn that answers an @mention in a comment thread. It runs
    // alone, takes no steer, and its final text becomes a reply in the thread.
    threadId: v.optional(v.id('threads')),
    // The document rev the turn's claim showed it. Saved beside its session
    // when the turn finishes, never before, so a failed turn advances nothing.
    documentRev: v.optional(v.number()),
    // Set on the turn that acts as scribe for a scribe run. Like a review, it
    // runs on a fresh session that is never saved, with file edits off, and
    // takes no steer; it changes the document only through its draft.
    scribeRunId: v.optional(v.id('scribeRuns')),
  })
    .index('by_room', ['roomId'])
    .index('by_ritual', ['ritualId'])
    .index('by_participant', ['participantId'])
    .index('by_participant_status', ['participantId', 'status'])
    .index('by_room_status', ['roomId', 'status']),

  // A turn's streamed text, one row per turn. Kept apart from the turn so the
  // runner's twice-a-second writes only reach the query for active turns.
  turnStreams: defineTable({
    turnId: v.id('turns'),
    text: v.string(),
  }).index('by_turn', ['turnId']),

  // An agent's tool activity during a turn, one row per tool call: its name
  // and a one-line summary. Raw output stays on the runner's disk.
  turnItems: defineTable({
    turnId: v.id('turns'),
    callId: v.string(),
    seq: v.number(),
    name: v.string(),
    summary: v.string(),
    ok: v.optional(v.boolean()),
  }).index('by_turn_call', ['turnId', 'callId']),

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
    // Follow-ups run on these harness sessions, one per participant, never on
    // the participant's ordinary session. Each keeps the document rev its
    // session has seen.
    followUpSessions: v.optional(
      v.array(v.object({ participantId: v.id('participants'), sessionId: v.string(), documentRevSeen: v.optional(v.number()) })),
    ),
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
    // Set on a decision recorded by answering a card: one per question when
    // answered on the card, or one for the whole card, without a question id,
    // when answered by a chat message.
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
  })
    .index('by_runner_status', ['runnerId', 'status'])
    .index('by_turn', ['turnId'])
    .index('by_status_lease', ['status', 'leaseExpiresAt']),

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

  // One shared document per room. `rev` counts every block revision ever
  // written to it. The scribe lock is set while a scribe run owns the document.
  documents: defineTable({
    roomId: v.id('rooms'),
    rev: v.number(),
    // Revisions since the last checkpoint; a checkpoint is taken every 200.
    revisionsSinceCheckpoint: v.number(),
    seededAt: v.number(),
    // The template it was seeded from. Missing means Atelier's default.
    templateId: v.optional(v.id('templates')),
    scribeRunId: v.optional(v.id('scribeRuns')),
    scribeLockExpiresAt: v.optional(v.number()),
  })
    // Each room has one document, found from the room.
    .index('by_room', ['roomId']),

  // One row per block, so an edit rewrites one small row and never a shared
  // array. Deleted blocks keep their row, with `deletedAt` set.
  blocks: defineTable({
    documentId: v.id('documents'),
    roomId: v.id('rooms'),
    // A fractional-indexing key: blocks sort by it, and an insert between two
    // blocks gets a key between theirs without renumbering the rest.
    order: v.string(),
    kind: blockKind,
    text: v.string(),
    author: blockAuthor,
    // The document rev of the block's latest revision. Writers send it back
    // to detect that someone else changed the block in between.
    rev: v.number(),
    // Set when a human edits a block attributed to someone else.
    humanEditedAt: v.optional(v.number()),
    // A person's edit lease, and the change set their edits go into.
    leaseHolderParticipantId: v.optional(v.id('participants')),
    leaseExpiresAt: v.optional(v.number()),
    leaseChangeSetId: v.optional(v.id('changeSets')),
    deletedAt: v.optional(v.number()),
    // Guidance text a template seeded, cleared once the text is changed, so
    // saving a room as a template copies guidance and never room content.
    fromTemplate: v.optional(v.boolean()),
    // For a block the scribe wrote: the blocks it was drawn from.
    sourceBlockIds: v.optional(v.array(v.id('blocks'))),
  })
    // Reading the document in order.
    .index('by_document_order', ['documentId', 'order']),

  changeSets: defineTable({
    documentId: v.id('documents'),
    roomId: v.id('rooms'),
    kind: changeSetKind,
    actorParticipantId: v.optional(v.id('participants')),
    turnId: v.optional(v.id('turns')),
    scribeRunId: v.optional(v.id('scribeRuns')),
    at: v.number(),
    // The document rev of its latest revision, and how many it holds.
    lastRev: v.number(),
    revisionCount: v.number(),
  })
    // History, newest first.
    .index('by_document', ['documentId'])
    // A model turn's writes all join that turn's one change set.
    .index('by_turn', ['turnId'])
    // A scribe run commits as one change set.
    .index('by_scribe_run', ['scribeRunId']),

  // Append-only. Text lives here, never in the ledger.
  blockRevisions: defineTable({
    documentId: v.id('documents'),
    changeSetId: v.id('changeSets'),
    blockId: v.id('blocks'),
    // The document rev this revision produced.
    rev: v.number(),
    op: v.union(v.literal('insert'), v.literal('update'), v.literal('move'), v.literal('delete')),
    before: v.optional(blockState),
    after: v.optional(blockState),
  })
    // Replaying revisions after a checkpoint, in order.
    .index('by_document_rev', ['documentId', 'rev'])
    // What one change set changed.
    .index('by_change_set', ['changeSetId'])
    // One block's history.
    .index('by_block', ['blockId']),

  // A full copy of the live blocks at one rev. The blocks are separate rows,
  // so no row grows with the document.
  documentCheckpoints: defineTable({
    documentId: v.id('documents'),
    rev: v.number(),
    reason: v.union(
      v.literal('interval'),
      v.literal('before_scribe'),
      v.literal('after_scribe'),
      v.literal('before_restore'),
    ),
    blockCount: v.number(),
  })
    // Finding the nearest checkpoint at or before a rev.
    .index('by_document_rev', ['documentId', 'rev']),

  checkpointBlocks: defineTable({
    checkpointId: v.id('documentCheckpoints'),
    blockId: v.id('blocks'),
    ...blockState.fields,
  })
    // Loading one checkpoint's blocks.
    .index('by_checkpoint', ['checkpointId']),

  // A comment thread on a passage of a block. The anchor is a text-quote
  // selector (the passage, with text before and after) plus its character
  // position in the block's plain text.
  threads: defineTable({
    documentId: v.id('documents'),
    roomId: v.id('rooms'),
    blockId: v.id('blocks'),
    exact: v.string(),
    prefix: v.string(),
    suffix: v.string(),
    position: v.number(),
    state: v.union(v.literal('open'), v.literal('settled')),
    // Set when the passage was removed: the change set that removed it.
    detachedBeforeChangeSetId: v.optional(v.id('changeSets')),
  })
    // Open threads in a document, and settled ones for the Settled section.
    .index('by_document_state', ['documentId', 'state'])
    // Threads on one block, to re-anchor when its text changes.
    .index('by_block', ['blockId']),

  comments: defineTable({
    threadId: v.id('threads'),
    roomId: v.id('rooms'),
    authorParticipantId: v.id('participants'),
    body: v.string(),
    // The model participants a person's comment @mentions; each was sent a
    // thread delivery. Always empty on a model's comment, which summons no one.
    mentions: v.array(v.id('participants')),
    // The model turn that wrote it, for a model's comment.
    turnId: v.optional(v.id('turns')),
  })
    // A thread's comments in order.
    .index('by_thread', ['threadId'])
    // A model turn's comments, to apply its per-turn cap.
    .index('by_turn', ['turnId']),

  // Robert's templates: an ordered list of headings, each with optional
  // guidance text. Atelier's default is a code constant, not a row.
  templates: defineTable({
    ownerUserId: v.id('users'),
    name: v.string(),
    sections: v.array(templateSection),
  })
    // Listing the owner's templates.
    .index('by_owner', ['ownerUserId']),

  // A scribe run: the participant acting as scribe and how the run ended.
  scribeRuns: defineTable({
    documentId: v.id('documents'),
    roomId: v.id('rooms'),
    participantId: v.id('participants'),
    startedByParticipantId: v.id('participants'),
    turnId: v.optional(v.id('turns')),
    status: v.union(v.literal('running'), v.literal('committed'), v.literal('released')),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    // Why a released run ended without changing the document.
    releaseReason: v.optional(v.string()),
  })
    // A document's runs.
    .index('by_document', ['documentId']),

  // One row per operation in a scribe run's draft, so a large draft never
  // forms one oversized row. Applied in `seq` order when the run commits.
  // An op names a block already in the document by `blockId`, or one the
  // draft adds by the `seq` of its add op (`targetSeq`); likewise for the
  // block it goes after (`afterBlockId`, `afterSeq`, or `atStart`). With
  // none of those it goes at the end.
  scribeDraftOps: defineTable({
    scribeRunId: v.id('scribeRuns'),
    seq: v.number(),
    op: v.union(v.literal('keep'), v.literal('replace'), v.literal('add'), v.literal('remove'), v.literal('move')),
    blockId: v.optional(v.id('blocks')),
    targetSeq: v.optional(v.number()),
    afterBlockId: v.optional(v.id('blocks')),
    afterSeq: v.optional(v.number()),
    atStart: v.optional(v.boolean()),
    kind: v.optional(blockKind),
    text: v.optional(v.string()),
    sourceBlockIds: v.optional(v.array(v.id('blocks'))),
  })
    // A run's draft, in order.
    .index('by_run_seq', ['scribeRunId', 'seq']),

  pushTokens: defineTable({
    userSubject: v.string(),
    token: v.string(),
    platform: v.string(),
  }).index('by_user', ['userSubject']),
});
