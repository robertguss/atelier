import { register as registerWorkflow } from "@convex-dev/workflow/test";
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
/// <reference types="vite/client" />
import type { FunctionArgs } from "convex/server";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { api, internal } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  insertBlock,
  liveBlocks,
  openChangeSet,
  orderBetween,
} from "../convex/lib/document";
import schema from "../convex/schema";
import { defined, rejectionsOf, stringMatching } from "./support";
import type { Caller } from "./support";

const modules = import.meta.glob("../convex/**/*.ts");

const SECRET = "test-secret";
const MINUTE = 60_000;
const HARNESSES = [
  { id: "claude" as const, version: "test" },
  { id: "codex" as const, version: "test" },
  { id: "pi" as const, version: "test" },
];

type T = TestConvex<typeof schema>;

const heartbeat = async (t: T) =>
  await t.mutation(api.runners.heartbeat, {
    harnesses: HARNESSES,
    machine: "test",
    name: "test",
    secret: SECRET,
  });

const setup = async () => {
  const t = convexTest(schema, modules);
  registerWorkflow(t);
  const owner = t.withIdentity({
    email: "owner@example.com",
    name: "Robert",
    subject: "owner",
  });
  const dana = t.withIdentity({
    email: "dana@example.com",
    name: "Dana",
    subject: "dana",
  });
  const runnerId = await heartbeat(t);
  const roomId = await owner.mutation(api.rooms.create, {
    cwd: "/tmp/planning",
    name: "Planning",
    runnerId,
  });
  await owner.mutation(api.rooms.addParticipant, {
    harness: "codex",
    roomId,
  });
  await owner.mutation(api.rooms.addParticipant, { harness: "pi", roomId });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => await Promise.resolve(Response.json([{ id: "user_1" }])))
  );
  const invite = await owner.action(api.invites.create, {
    email: "dana@example.com",
    roomId,
  });
  await dana.mutation(api.invites.accept, {
    token: defined(invite.url.split("/invite/")[1]),
  });
  vi.unstubAllGlobals();
  const { participants } = defined(
    await owner.query(api.rooms.get, { roomId })
  );
  const find = (name: string) =>
    defined(participants.find((p) => p.displayName === name));
  const doc = defined(await owner.query(api.documents.get, { roomId }));
  const [happened, ideas, questions] = doc.blocks;
  return {
    claude: find("Claude"),
    codex: find("Codex"),
    dana,
    danaP: find("Dana"),
    documentId: doc.documentId,
    happened: defined(happened),
    ideas: defined(ideas),
    owner,
    pi: find("Pi"),
    questions: defined(questions),
    robert: find("Robert"),
    roomId,
    runnerId,
    t,
  };
};

// A paragraph by `participantId` at the end of the document, as its own model turn's change set.
const paragraph = async (
  t: T,
  documentId: Id<"documents">,
  participantId: Id<"participants">,
  text: string
) =>
  await t.run(async (ctx) => {
    const blocks = await liveBlocks(ctx, documentId);
    const changeSetId = await openChangeSet(ctx, documentId, {
      actorParticipantId: participantId,
      kind: "model_turn",
    });
    return await insertBlock(ctx, changeSetId, {
      author: { kind: "participant", participantId },
      kind: "paragraph",
      order: orderBetween(blocks.at(-1)?.order ?? null, null),
      text,
    });
  });

// Many paragraphs by one author at the end of the document, in one change set.
const paragraphs = async (
  t: T,
  documentId: Id<"documents">,
  participantId: Id<"participants">,
  texts: string[]
) =>
  await t.run(async (ctx) => {
    const awaited14 = await liveBlocks(ctx, documentId);
    let last = awaited14.at(-1)?.order ?? null;
    const changeSetId = await openChangeSet(ctx, documentId, {
      actorParticipantId: participantId,
      kind: "model_turn",
    });
    const ids = [];
    for (const text of texts) {
      last = orderBetween(last, null);
      ids.push(
        // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
        await insertBlock(ctx, changeSetId, {
          author: { kind: "participant", participantId },
          kind: "paragraph",
          order: last,
          text,
        })
      );
    }
    return ids;
  });

const runTurnCommand = async (t: T, turnId: Id<"turns">) => {
  const commands = await t.run(
    async (ctx) =>
      await ctx.db
        .query("commands")
        .withIndex("by_turn", (q) => q.eq("turnId", turnId))
        .collect()
  );
  return defined(commands.find((c) => c.type === "run_turn"));
};

// Calls in the scribe; with `start`, claims and starts its turn as the runner would.
const beginScribe = async (
  t: T,
  caller: Caller,
  roomId: Id<"rooms">,
  participantId: Id<"participants">,
  { start = true } = {}
) => {
  const scribeRunId = defined(
    await caller.mutation(api.scribe.begin, {
      participantId,
      roomId,
    })
  ) as Id<"scribeRuns">;
  const turnId = defined(
    defined(await t.run(async (ctx) => await ctx.db.get(scribeRunId))).turnId
  );
  const command = await runTurnCommand(t, turnId);
  let job = null;
  if (start) {
    job = await t.mutation(api.runner.claim, {
      commandId: command._id,
      secret: SECRET,
    });
    await t.mutation(api.runner.start, {
      harnessVersion: "test",
      secret: SECRET,
      turnId,
    });
  }
  return { commandId: command._id, job, scribeRunId, turnId };
};

type DraftOp = FunctionArgs<typeof api.documentTools.scribeDraftForTurn>["op"];

const draft = async (t: T, turnId: Id<"turns">, op: DraftOp) =>
  await t.mutation(api.documentTools.scribeDraftForTurn, {
    op,
    secret: SECRET,
    turnId,
  });

// The report of a draft operation the server accepted.
const reportOf = (result: Awaited<ReturnType<typeof draft>>) => {
  assert(result.ok, "the draft operation was accepted");
  return result.report;
};

const finish = async (
  t: T,
  turnId: Id<"turns">,
  commandId: Id<"commands">,
  sessionId?: string
) => {
  await t.mutation(api.runner.finish, {
    commandId,
    finalText: "Tidied the document.",
    secret: SECRET,
    transcriptRef: "/tmp/t.ndjson",
    turnId,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
};

// Ordinary turn running for a participant, started from a person's message.
const ordinaryTurn = async (
  t: T,
  caller: Caller,
  roomId: Id<"rooms">,
  participantId: Id<"participants">
) => {
  const turnId = defined(
    await caller.mutation(api.messages.send, {
      body: "Go on",
      roomId,
      toParticipantId: participantId,
    })
  );
  const command = await runTurnCommand(t, turnId);
  await t.mutation(api.runner.claim, {
    commandId: command._id,
    secret: SECRET,
  });
  await t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: SECRET,
    turnId,
  });
  return { commandId: command._id, turnId };
};

const state = (b: {
  order: string;
  kind: string;
  text: string;
  author: unknown;
}) => ({ author: b.author, kind: b.kind, order: b.order, text: b.text });

const currentDocument = async (t: T, documentId: Id<"documents">) =>
  await t.run(async (ctx) => {
    const blocks = await liveBlocks(ctx, documentId);
    return blocks.map((b) => ({ blockId: b._id, ...state(b) }));
  });

const checkpointBlocks = async (
  t: T,
  documentId: Id<"documents">,
  reason: Doc<"documentCheckpoints">["reason"]
) =>
  await t.run(async (ctx) => {
    const awaited13 = await ctx.db
      .query("documentCheckpoints")
      .withIndex("by_document_rev", (q) => q.eq("documentId", documentId))
      .collect();
    const checkpoint = awaited13.findLast((c) => c.reason === reason);
    if (!checkpoint) {
      return null;
    }
    const rows = await ctx.db
      .query("checkpointBlocks")
      .withIndex("by_checkpoint", (q) => q.eq("checkpointId", checkpoint._id))
      .collect();
    return rows
      .map((r) => ({ blockId: r.blockId, ...state(r) }))
      .toSorted((a, b) => (a.order < b.order ? -1 : 1));
  });

const document = async (t: T, documentId: Id<"documents">) =>
  defined(await t.run(async (ctx) => await ctx.db.get(documentId)));

const runOf = async (t: T, scribeRunId: Id<"scribeRuns">) =>
  defined(await t.run(async (ctx) => await ctx.db.get(scribeRunId)));

const draftRows = async (t: T, scribeRunId: Id<"scribeRuns">) => {
  const rows = await t.run(
    async (ctx) => await ctx.db.query("scribeDraftOps").collect()
  );
  return rows.filter((o) => o.scribeRunId === scribeRunId);
};

const scribeChangeSets = async (t: T, documentId: Id<"documents">) => {
  const changeSets = await t.run(
    async (ctx) => await ctx.db.query("changeSets").collect()
  );
  return changeSets.filter(
    (c) => c.documentId === documentId && c.kind === "scribe_run"
  );
};

// A run with a draft that rewrites, removes and adds, so a release that kept
// any of it would show.
const runWithDraft = async (s: Awaited<ReturnType<typeof setup>>) => {
  const a = await paragraph(
    s.t,
    s.documentId,
    s.codex._id,
    "Codex: the cache warms on boot."
  );
  const b = await paragraph(
    s.t,
    s.documentId,
    s.pi._id,
    "Pi: boot warms the cache."
  );
  const run = await beginScribe(s.t, s.dana, s.roomId, s.claude._id);
  await expect(
    draft(s.t, run.turnId, {
      blockId: a,
      op: "replace",
      sourceBlockIds: [b],
      text: "The cache warms on boot.",
    })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    draft(s.t, run.turnId, { blockId: b, op: "remove" })
  ).resolves.toMatchObject({ ok: true });
  await expect(
    draft(s.t, run.turnId, {
      afterBlockId: "start",
      kind: "heading",
      op: "add",
      sourceBlockIds: [],
      text: "Summary",
    })
  ).resolves.toMatchObject({ ok: true });
  return { ...run, a, b };
};

const expectReleased = async (
  t: T,
  documentId: Id<"documents">,
  scribeRunId: Id<"scribeRuns">
) => {
  const doc = await document(t, documentId);
  const run = await runOf(t, scribeRunId);
  expect({
    changeSets: await scribeChangeSets(t, documentId),
    current: await currentDocument(t, documentId),
    draft: await draftRows(t, scribeRunId),
    lock: [doc.scribeRunId, doc.scribeLockExpiresAt],
    status: run.status,
  }).toStrictEqual({
    changeSets: [],
    current: await checkpointBlocks(t, documentId, "before_scribe"),
    draft: [],
    lock: [undefined, undefined],
    status: "released",
  });
};

// A 4,000-character block, distinct by its number and tag.
const text = (i: number, tag: string) => `${tag} ${i} `.padEnd(4000, "x");

describe("scribe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ATELIER_OWNER_EMAILS = "owner@example.com";
    process.env.ATELIER_RUNNER_SECRET = SECRET;
    process.env.CLERK_SECRET_KEY = "sk_test";
    process.env.ATELIER_WEB_URL = "https://atelier.example.com/";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("a scribe run merges two blocks and deletes a commented passage: one change set by the scribe, both authors credited, the thread kept open with a link to the version before", async () => {
    const s = await setup();
    const { t, owner, dana, roomId, documentId } = s;
    const codexNote = await paragraph(
      t,
      documentId,
      s.codex._id,
      "Use Postgres for the queue."
    );
    const piNote = await paragraph(
      t,
      documentId,
      s.pi._id,
      "Postgres is fine for the queue at our size."
    );
    const stale = await paragraph(
      t,
      documentId,
      s.robert._id,
      "Ask Sam about the Friday freeze."
    );
    const before = await currentDocument(t, documentId);

    // Threads on the block that gets merged away and on the passage that gets deleted.
    const onPi = await owner.mutation(api.threads.create, {
      blockId: piNote,
      body: "Agreed.",
      end: "Postgres is fine".length,
      start: 0,
    });
    const onStale = await owner.mutation(api.threads.create, {
      blockId: stale,
      body: "Did anyone?",
      end: "Ask Sam".length,
      start: 0,
    });

    const run = await beginScribe(t, dana, roomId, s.claude._id);
    const checkpointBefore = await checkpointBlocks(
      t,
      documentId,
      "before_scribe"
    );
    const merged = await draft(t, run.turnId, {
      blockId: codexNote,
      op: "replace",
      sourceBlockIds: [piNote],
      text: "Postgres is fine for the queue at our size (Codex, Pi).",
    });
    const mergedAway = await draft(t, run.turnId, {
      blockId: piNote,
      op: "remove",
    });
    const removed = await draft(t, run.turnId, {
      blockId: stale,
      op: "remove",
    });
    expect({
      checkpointBefore,
      detaching: reportOf(removed).threads.detaching,
      merged: merged.ok,
      moving: reportOf(mergedAway).threads.moving,
      removedUndrawn: reportOf(removed).removedUndrawn,
    }).toStrictEqual({
      checkpointBefore: before,
      detaching: [{ blockId: stale, passage: "Ask Sam", threadId: onStale }],
      merged: true,
      moving: [
        { passage: "Postgres is fine", threadId: onPi, toBlockId: codexNote },
      ],
      removedUndrawn: [stale],
    });
    await finish(t, run.turnId, run.commandId);

    const after = await currentDocument(t, documentId);
    const mergedBlock = defined(
      await t.run(async (ctx) => await ctx.db.get(codexNote))
    );
    const [changeSet, ...others] = await scribeChangeSets(t, documentId);
    const history = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 10 },
      roomId,
    });
    const threads = await t.run(
      async (ctx) => await ctx.db.query("threads").collect()
    );
    const piThread = defined(
      threads.find((th) => th.exact === "Postgres is fine")
    );
    const staleThread = defined(threads.find((th) => th.exact === "Ask Sam"));
    const original = await owner.query(api.history.versionBefore, {
      changeSetId: defined(changeSet)._id,
    });
    const doc = await document(t, documentId);
    const runAfter = await runOf(t, run.scribeRunId);
    const ledger = await t.run(
      async (ctx) => await ctx.db.query("ledger").collect()
    );
    const checkpointAfter = await checkpointBlocks(
      t,
      documentId,
      "after_scribe"
    );
    expect({
      checkpointAfter,
      draft: await draftRows(t, run.scribeRunId),
      lockFields: ["scribeRunId", "scribeLockExpiresAt"].filter(
        (field) => field in doc
      ),
      mergedAwayStillThere: [piNote, stale].map((id) =>
        after.some((b) => b.blockId === id)
      ),
      originalText: original.blocks.find((b) => b.blockId === stale)?.text,
      others,
      piDetached: piThread.detachedBeforeChangeSetId,
      runStatus: runAfter.status,
      started: ledger
        .filter((e) => e.type === "document.scribe_started")
        .map((e) => ({
          actorParticipantId: e.actorParticipantId,
          payload: e.payload as unknown,
          subjectId: e.subjectId,
        })),
    }).toStrictEqual({
      checkpointAfter: after,
      draft: [],
      lockFields: [],
      mergedAwayStillThere: [false, false],
      originalText: "Ask Sam about the Friday freeze.",
      others: [],
      piDetached: undefined,
      runStatus: "committed",
      started: [
        {
          actorParticipantId: s.danaP._id,
          payload: {
            documentId,
            participantId: s.claude._id,
            scribeRunId: run.scribeRunId,
            turnId: run.turnId,
          },
          subjectId: run.scribeRunId,
        },
      ],
    });
    expect({
      changeSet,
      history: history.page[0],
      mergedBlock,
      piThread,
      staleThread,
    }).toMatchObject({
      changeSet: {
        actorParticipantId: s.claude._id,
        revisionCount: 3,
        scribeRunId: run.scribeRunId,
      },
      history: {
        _id: defined(changeSet)._id,
        actorParticipantId: s.claude._id,
        kind: "scribe_run",
        scribeParticipantId: s.claude._id,
        scribeStartedByParticipantId: s.danaP._id,
      },
      mergedBlock: {
        author: {
          credits: [s.codex._id, s.pi._id],
          kind: "scribe",
          participantId: s.claude._id,
        },
        sourceBlockIds: [codexNote, piNote],
        text: "Postgres is fine for the queue at our size (Codex, Pi).",
      },
      piThread: { blockId: codexNote, state: "open" },
      staleThread: {
        blockId: stale,
        detachedBeforeChangeSetId: defined(changeSet)._id,
        state: "open",
      },
    });
  });

  it("the scribe turn is claimed with the scribe document mode, the full document with block ids, no session, edits off and the scribe instructions", async () => {
    const s = await setup();
    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: true,
      roomId: s.roomId,
    });
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.claude._id, {
        documentRevSeen: 1,
        harnessSessionId: "ordinary-session",
      });
    });
    const note = await paragraph(
      s.t,
      s.documentId,
      s.codex._id,
      "Use Postgres for the queue."
    );
    const { job, turnId } = await beginScribe(
      s.t,
      s.dana,
      s.roomId,
      s.claude._id
    );
    assert(job?.type === "run_turn", "the scribe turn was claimed");
    const { prompt } = job.turn;
    const stored = defined(
      await s.t.run(async (ctx) => await ctx.db.get(turnId))
    );
    expect({
      claim: {
        documentMode: job.documentMode,
        participant: { id: job.participant.id },
        room: { editsEnabled: job.room.editsEnabled },
        type: job.type,
      },
      editsEnabled: stored.editsEnabled,
      sessionId: job.participant.sessionId,
      shown: [
        "<room_document",
        `[${note}]`,
        "Dana has called you in as the scribe",
        "does not mention is kept exactly as it is",
        "sourceBlockIds",
        "keep each view and say whose it is",
        "Do not drop open questions",
        "File edits: off.",
      ].map((fragment) => prompt.includes(fragment)),
    }).toStrictEqual({
      claim: {
        documentMode: "scribe",
        participant: { id: s.claude._id },
        room: { editsEnabled: false },
        type: "run_turn",
      },
      editsEnabled: false,
      sessionId: undefined,
      shown: Array.from({ length: 8 }, () => true),
    });
  });

  it("a scribe turn cannot use the ordinary write tools, and only the scribe turn can use the draft tools", async () => {
    const s = await setup();
    const note = await paragraph(
      s.t,
      s.documentId,
      s.claude._id,
      "Claude wrote this."
    );
    const codexTurn = await ordinaryTurn(s.t, s.owner, s.roomId, s.codex._id);
    const run = await beginScribe(s.t, s.dana, s.roomId, s.claude._id);
    const refused = await s.t.mutation(api.documentTools.updateBlockForTurn, {
      baseRev: 1,
      blockId: note,
      secret: SECRET,
      text: "Changed",
      turnId: run.turnId,
    });
    expect(refused).toMatchObject({
      message: stringMatching(/draft tools/u),
      ok: false,
      reason: "read_only",
    });
    await expect(
      s.t.mutation(api.documentTools.addBlockForTurn, {
        kind: "paragraph",
        secret: SECRET,
        text: "More",
        turnId: run.turnId,
      })
    ).resolves.toMatchObject({ ok: false, reason: "read_only" });
    await expect(
      draft(s.t, codexTurn.turnId, { blockId: note, op: "keep" })
    ).resolves.toMatchObject({ ok: false, reason: "not_scribe" });
    const read = await s.t.query(api.documentTools.readDocumentForTurn, {
      secret: SECRET,
      turnId: run.turnId,
    });
    expect(read).toMatchObject({ ok: true, scribe: true, writable: false });
  });

  it("while the scribe works, the teammate's edit and a Codex update_block are refused with the scribe notice", async () => {
    const s = await setup();
    const codexTurn = await ordinaryTurn(s.t, s.owner, s.roomId, s.codex._id);
    const added = await s.t.mutation(api.documentTools.addBlockForTurn, {
      kind: "paragraph",
      secret: SECRET,
      text: "Ship on Friday.",
      turnId: codexTurn.turnId,
    });
    assert(added.ok, "the block was added");
    await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    await expect(
      s.dana.mutation(api.blocks.startEdit, { blockId: s.happened._id })
    ).rejects.toThrow("The scribe is working on the document");
    const refused = await s.t.mutation(api.documentTools.updateBlockForTurn, {
      baseRev: added.rev,
      blockId: added.blockId,
      secret: SECRET,
      text: "Ship on Monday.",
      turnId: codexTurn.turnId,
    });
    expect(refused).toMatchObject({
      message: stringMatching(/scribe is working/u),
      ok: false,
      reason: "scribe_working",
    });
  });

  it("calling in the scribe while the teammate edits a block is refused, naming her", async () => {
    const s = await setup();
    await s.dana.mutation(api.blocks.startEdit, { blockId: s.ideas._id });
    await expect(
      s.owner.mutation(api.scribe.begin, {
        participantId: s.claude._id,
        roomId: s.roomId,
      })
    ).rejects.toThrow("Dana is editing a block");
    const awaited11 = await document(s.t, s.documentId);
    expect(awaited11.scribeRunId).toBeUndefined();
    await expect(
      s.t.run(async (ctx) => await ctx.db.query("scribeRuns").collect())
    ).resolves.toStrictEqual([]);
  });

  it("calling in the scribe is refused while that model is answering, and allowed once its turn ends", async () => {
    const s = await setup();
    const busy = await ordinaryTurn(s.t, s.owner, s.roomId, s.claude._id);
    await expect(
      s.owner.mutation(api.scribe.begin, {
        participantId: s.claude._id,
        roomId: s.roomId,
      })
    ).rejects.toThrow("Claude is still answering");
    await expect(
      s.t.run(async (ctx) => await ctx.db.query("scribeRuns").collect())
    ).resolves.toStrictEqual([]);
    await finish(s.t, busy.turnId, busy.commandId);
    await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    await expect(
      s.t.run(async (ctx) => await ctx.db.query("scribeRuns").collect())
    ).resolves.toHaveLength(1);
  });

  it("calling in the scribe with the runner offline, or while a run is working, is refused", async () => {
    const s = await setup();
    vi.advanceTimersByTime(46_000);
    await expect(
      s.owner.mutation(api.scribe.begin, {
        participantId: s.claude._id,
        roomId: s.roomId,
      })
    ).rejects.toThrow(/runner .* is offline/u);
    await heartbeat(s.t);
    await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    await expect(
      s.dana.mutation(api.scribe.begin, {
        participantId: s.codex._id,
        roomId: s.roomId,
      })
    ).rejects.toThrow("The scribe is working on the document");
    await expect(
      s.t.run(async (ctx) => await ctx.db.query("scribeRuns").collect())
    ).resolves.toHaveLength(1);
  });

  it("a failed scribe turn leaves the document as the checkpoint before the run, with the lock cleared", async () => {
    const s = await setup();
    const run = await runWithDraft(s);
    await s.t.mutation(api.runner.fail, {
      commandId: run.commandId,
      error: "Model overloaded",
      secret: SECRET,
      turnId: run.turnId,
    });
    await expectReleased(s.t, s.documentId, run.scribeRunId);
    await expect(runOf(s.t, run.scribeRunId)).resolves.toMatchObject({
      releaseReason: "Model overloaded",
    });
  });

  it("stopping the scribe leaves the document as the checkpoint before the run, with the lock cleared", async () => {
    const s = await setup();
    expect.hasAssertions();
    const run = await runWithDraft(s);
    await s.owner.mutation(api.messages.cancel, { turnId: run.turnId });
    await expectReleased(s.t, s.documentId, run.scribeRunId);
    // A finish the runner sends after the stop changes nothing.
    await finish(s.t, run.turnId, run.commandId).catch(() => {});
    await expectReleased(s.t, s.documentId, run.scribeRunId);
  });

  it("a runner restart during the scribe turn leaves the document as the checkpoint before the run, with the lock cleared", async () => {
    const s = await setup();
    expect.hasAssertions();
    const run = await runWithDraft(s);
    await s.t.mutation(api.runner.recover, {
      runnerId: s.runnerId,
      secret: SECRET,
    });
    await expectReleased(s.t, s.documentId, run.scribeRunId);
  });

  it("the lease cron reclaiming a silent scribe turn leaves the document as the checkpoint before the run, with the lock cleared", async () => {
    const s = await setup();
    const run = await runWithDraft(s);
    vi.advanceTimersByTime(6 * MINUTE);
    await s.t.mutation(internal.runner.reclaimExpiredLeases, {});
    expect(
      defined(await s.t.run(async (ctx) => await ctx.db.get(run.turnId))).status
    ).toBe("interrupted");
    await expectReleased(s.t, s.documentId, run.scribeRunId);
  });

  it("the lock expiring under a running scribe turn fails the turn and leaves the document as the checkpoint before the run", async () => {
    const s = await setup();
    const run = await runWithDraft(s);
    const awaited10 = await document(s.t, s.documentId);
    expect(awaited10.scribeLockExpiresAt).toStrictEqual(
      expect.closeTo(Date.now() + 35 * MINUTE, -2)
    );
    vi.advanceTimersByTime(35 * MINUTE + 1000);
    await s.t.finishInProgressScheduledFunctions();
    expect(
      defined(await s.t.run(async (ctx) => await ctx.db.get(run.turnId))).status
    ).toBe("failed");
    expect(
      defined(await s.t.run(async (ctx) => await ctx.db.get(run.commandId)))
        .status
    ).toBe("failed");
    await expectReleased(s.t, s.documentId, run.scribeRunId);
  });

  it("a scribe command the runner never claims is ended by the lock expiry, leaving the document as it was and the lock cleared", async () => {
    const s = await setup();
    const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id, {
      start: false,
    });
    vi.advanceTimersByTime(35 * MINUTE + 1000);
    await s.t.finishInProgressScheduledFunctions();
    expect(
      defined(await s.t.run(async (ctx) => await ctx.db.get(run.commandId)))
        .status
    ).toBe("failed");
    expect(
      defined(await s.t.run(async (ctx) => await ctx.db.get(run.turnId))).status
    ).toBe("failed");
    await expectReleased(s.t, s.documentId, run.scribeRunId);
    // A runner that comes back later cannot start it.
    await heartbeat(s.t);
    await expect(
      s.t.mutation(api.runner.claim, {
        commandId: run.commandId,
        secret: SECRET,
      })
    ).resolves.toBeNull();
  });

  it("a finish that arrives after the lock expiry released the run commits nothing", async () => {
    const s = await setup();
    expect.hasAssertions();
    const run = await runWithDraft(s);
    vi.advanceTimersByTime(35 * MINUTE + 1000);
    await s.t.finishInProgressScheduledFunctions();
    await finish(s.t, run.turnId, run.commandId);
    await expectReleased(s.t, s.documentId, run.scribeRunId);
  });

  it("a comment posted during the run re-attaches to the block that absorbs its passage", async () => {
    const s = await setup();
    const a = await paragraph(
      s.t,
      s.documentId,
      s.codex._id,
      "Cache warming takes ten minutes."
    );
    const b = await paragraph(
      s.t,
      s.documentId,
      s.pi._id,
      "We could warm the cache lazily."
    );
    const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    await draft(s.t, run.turnId, {
      blockId: a,
      op: "replace",
      sourceBlockIds: [b],
      text: "Cache warming takes ten minutes. We could warm the cache lazily.",
    });
    await draft(s.t, run.turnId, { blockId: b, op: "remove" });
    // Dana comments mid-run on the block the draft removes.
    const posted = await s.dana.mutation(api.threads.create, {
      blockId: b,
      body: "How much faster?",
      end: "We could warm the cache lazily".length,
      start: "We could ".length,
    });
    await finish(s.t, run.turnId, run.commandId);
    const thread = defined(
      await s.t.run(async (ctx) => await ctx.db.get(posted))
    );
    expect(thread).toMatchObject({
      blockId: a,
      exact: "warm the cache lazily",
      state: "open",
    });
    expect(thread.detachedBeforeChangeSetId).toBeUndefined();
  });

  it("between runs a model's update_block on a scribe block is refused with comment instead, including from the model that acted as scribe", async () => {
    const s = await setup();
    const a = await paragraph(
      s.t,
      s.documentId,
      s.claude._id,
      "Claude: first note."
    );
    const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    await draft(s.t, run.turnId, {
      blockId: a,
      op: "replace",
      text: "Consolidated note.",
    });
    await finish(s.t, run.turnId, run.commandId);
    const block = defined(await s.t.run(async (ctx) => await ctx.db.get(a)));
    expect(block.author).toStrictEqual({
      credits: [s.claude._id],
      kind: "scribe",
      participantId: s.claude._id,
    });
    for (const model of [s.claude, s.codex]) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
      await heartbeat(s.t);
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
      const { turnId } = await ordinaryTurn(s.t, s.owner, s.roomId, model._id);
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
      const refused = await s.t.mutation(api.documentTools.updateBlockForTurn, {
        baseRev: block.rev,
        blockId: a,
        secret: SECRET,
        text: "Reverted.",
        turnId,
      });
      expect(refused).toMatchObject({
        message: stringMatching(/comment on it instead/u),
        ok: false,
        reason: "not_your_block",
      });
    }
  });

  it("a draft that mentions 5 of 300 blocks keeps the other 295 unchanged", async () => {
    const s = await setup();
    const ids = await paragraphs(
      s.t,
      s.documentId,
      s.codex._id,
      Array.from({ length: 297 }, (_, i) => `Note ${i}`)
    );
    const awaited9 = await currentDocument(s.t, s.documentId);
    const before = new Map(awaited9.map((b) => [b.blockId, b]));
    const awaited8 = await s.t.run(
      async (ctx) => await liveBlocks(ctx, s.documentId)
    );
    const revs = new Map(awaited8.map((b) => [b._id, b.rev]));
    const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    await draft(s.t, run.turnId, {
      blockId: defined(ids[10]),
      op: "replace",
      sourceBlockIds: [defined(ids[11])],
      text: "Note 10, merged with note 11.",
    });
    await draft(s.t, run.turnId, { blockId: defined(ids[11]), op: "remove" });
    await draft(s.t, run.turnId, {
      afterBlockId: s.happened._id,
      blockId: defined(ids[200]),
      op: "move",
    });
    await draft(s.t, run.turnId, { blockId: defined(ids[5]), op: "keep" });
    const last = await draft(s.t, run.turnId, {
      blockId: defined(ids[296]),
      op: "remove",
    });
    expect(reportOf(last)).toMatchObject({
      added: 0,
      blocks: 300,
      finalBlocks: 298,
      moved: 1,
      removed: 2,
      replaced: 1,
      untouched: { count: 295 },
    });
    await finish(s.t, run.turnId, run.commandId);

    const mentioned = new Set<string>([
      defined(ids[10]),
      defined(ids[11]),
      defined(ids[200]),
      defined(ids[5]),
      defined(ids[296]),
    ]);
    const after = await s.t.run(
      async (ctx) => await liveBlocks(ctx, s.documentId)
    );
    const untouched = after.filter((b) => !mentioned.has(b._id));
    const order = after.map((b) => b._id);
    const [changeSet] = await scribeChangeSets(s.t, s.documentId);
    expect({
      movedAfterHeading:
        order.indexOf(defined(ids[200])) - order.indexOf(s.happened._id),
      revisions: defined(changeSet).revisionCount,
      startedWith: before.size,
      untouched: untouched.map((b) => [state(b), b.rev]),
      untouchedCount: untouched.length,
    }).toStrictEqual({
      movedAfterHeading: 1,
      revisions: 4,
      startedWith: 300,
      untouched: untouched.map((b) => [
        state(defined(before.get(b._id))),
        revs.get(b._id),
      ]),
      untouchedCount: 295,
    });
    expect(after.find((b) => b._id === ids[5])).toMatchObject(
      state(defined(before.get(defined(ids[5]))))
    );
  });

  it("a later draft operation on the same block supersedes the earlier one", async () => {
    const s = await setup();
    const a = await paragraph(s.t, s.documentId, s.codex._id, "Original.");
    const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    await draft(s.t, run.turnId, {
      blockId: a,
      op: "replace",
      text: "First try.",
    });
    await draft(s.t, run.turnId, {
      blockId: a,
      op: "replace",
      text: "Second try.",
    });
    const added = await draft(s.t, run.turnId, {
      afterBlockId: a,
      kind: "paragraph",
      op: "add",
      sourceBlockIds: [a],
      text: "New block.",
    });
    assert(added.ok, "the draft add was accepted");
    const newBlock = defined(added.draftId);
    expect(newBlock).toMatch(/^new-\d+$/u);
    await draft(s.t, run.turnId, {
      afterBlockId: newBlock,
      kind: "paragraph",
      op: "add",
      sourceBlockIds: [],
      text: "After the new block.",
    });
    await draft(s.t, run.turnId, {
      blockId: newBlock,
      op: "replace",
      text: "New block, reworded.",
    });
    const missing = await draft(s.t, run.turnId, {
      blockId: "new-999",
      op: "remove",
    });
    expect(missing).toMatchObject({ ok: false, reason: "not_found" });
    await finish(s.t, run.turnId, run.commandId);
    const awaited7 = await currentDocument(s.t, s.documentId);
    const texts = awaited7.map((b) => b.text);
    expect(texts.slice(-3)).toStrictEqual([
      "Second try.",
      "New block, reworded.",
      "After the new block.",
    ]);
    const awaited6 = await s.t.run(
      async (ctx) => await liveBlocks(ctx, s.documentId)
    );
    const reworded = defined(
      awaited6.find((b) => b.text === "New block, reworded.")
    );
    expect(reworded).toMatchObject({
      author: {
        credits: [s.codex._id],
        kind: "scribe",
        participantId: s.claude._id,
      },
      sourceBlockIds: [a],
    });
  });

  it("the scribe turn never saves a session id on the participant", async () => {
    const s = await setup();
    await s.t.run(async (ctx) => {
      await ctx.db.patch(s.claude._id, {
        documentRevSeen: 3,
        harnessSessionId: "ordinary-session",
      });
    });
    const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    await s.t.mutation(api.runner.sessionStarted, {
      secret: SECRET,
      sessionId: "scribe-session",
      turnId: run.turnId,
    });
    await finish(s.t, run.turnId, run.commandId, "scribe-session");
    await expect(
      s.t.run(async (ctx) => await ctx.db.get(s.claude._id))
    ).resolves.toMatchObject({
      documentRevSeen: 3,
      harnessSessionId: "ordinary-session",
    });
  });

  it("a steer-now message to the scribe model during the run stays queued and runs as its own turn after the run ends", async () => {
    const s = await setup();
    const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    const sent = await s.dana.mutation(api.messages.send, {
      body: "WAIT-FOR-SCRIBE",
      roomId: s.roomId,
      steer: true,
      toParticipantId: s.claude._id,
    });
    const awaited5 = await s.t.run(
      async (ctx) => await ctx.db.query("messages").collect()
    );
    const message = defined(awaited5.find((m) => m.body === "WAIT-FOR-SCRIBE"));
    const steered = await s.dana.mutation(api.agent.steer, {
      messageId: message._id,
    });
    const awaited4 = await s.t.run(
      async (ctx) => await ctx.db.query("commands").collect()
    );
    expect({
      delivery: message.delivery,
      sent,
      steerCommands: awaited4.filter((c) => c.type === "steer"),
      steered,
    }).toStrictEqual({
      delivery: "queued",
      sent: null,
      steerCommands: [],
      steered: { status: "queued" },
    });

    await finish(s.t, run.turnId, run.commandId);
    const awaited3 = await s.t.run(
      async (ctx) => await ctx.db.query("turns").collect()
    );
    const turns = awaited3.filter((t) => t.participantId === s.claude._id);
    const next = defined(turns.find((t) => t._id !== run.turnId));
    const delivered = defined(
      await s.t.run(async (ctx) => await ctx.db.get(message._id))
    );
    expect({
      delivered: {
        deliveredTurnId: delivered.deliveredTurnId,
        delivery: delivered.delivery,
      },
      next: {
        carriesMessage: next.prompt.includes("WAIT-FOR-SCRIBE"),
        carriesScribeInstructions: next.prompt.includes(
          "scribe for the room document"
        ),
        scribeRunId: next.scribeRunId,
        status: next.status,
      },
      turns: turns.length,
    }).toStrictEqual({
      delivered: { deliveredTurnId: next._id, delivery: "delivered" },
      next: {
        carriesMessage: true,
        carriesScribeInstructions: false,
        scribeRunId: undefined,
        status: "queued",
      },
      turns: 2,
    });
  });

  it("turning the edit switch on during a run sends the scribe turn no settings change", async () => {
    const s = await setup();
    const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    const codexTurn = await ordinaryTurn(s.t, s.owner, s.roomId, s.codex._id);
    await s.owner.mutation(api.rooms.setEditsEnabled, {
      on: true,
      roomId: s.roomId,
    });
    const awaited2 = await s.t.run(
      async (ctx) => await ctx.db.query("commands").collect()
    );
    const settings = awaited2.filter((c) => c.type === "settings");
    const scribeTurn = defined(
      await s.t.run(async (ctx) => await ctx.db.get(run.turnId))
    );
    expect({
      editsEnabled: scribeTurn.editsEnabled,
      settings: settings.map((c) => c.turnId),
    }).toStrictEqual({ editsEnabled: false, settings: [codexTurn.turnId] });
  });

  it("a 600-block document of 4,000-character blocks checkpoints before the run, and a draft replacing every block commits", async () => {
    const s = await setup();
    await paragraphs(
      s.t,
      s.documentId,
      s.codex._id,
      Array.from({ length: 597 }, (_, i) => text(i, "Codex"))
    );
    const blocks = await s.t.run(
      async (ctx) => await liveBlocks(ctx, s.documentId)
    );
    const run = await beginScribe(s.t, s.owner, s.roomId, s.claude._id);
    const checkpointBefore = await checkpointBlocks(
      s.t,
      s.documentId,
      "before_scribe"
    );
    // The draft is written straight to its table: 600 tool calls would only slow the test.
    await s.t.run(async (ctx) => {
      for (const [seq, b] of blocks.entries()) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- rows are written one at a time, in order
        await ctx.db.insert("scribeDraftOps", {
          blockId: b._id,
          op: "replace",
          scribeRunId: run.scribeRunId,
          seq,
          text: text(seq, "Scribe"),
        });
      }
    });
    await finish(s.t, run.turnId, run.commandId);
    const after = await s.t.run(
      async (ctx) => await liveBlocks(ctx, s.documentId)
    );
    const [changeSet] = await scribeChangeSets(s.t, s.documentId);
    const checkpointAfter = await checkpointBlocks(
      s.t,
      s.documentId,
      "after_scribe"
    );
    // The commit ends with its own checkpoint, with none taken in the middle of it.
    const checkpoints = await s.t.run(
      async (ctx) => await ctx.db.query("documentCheckpoints").collect()
    );
    expect({
      allRewritten: after.every(
        (b, i) => b.text === text(i, "Scribe") && b.author.kind === "scribe"
      ),
      blocksAfter: after.length,
      blocksBefore: blocks.length,
      checkpointAfter: checkpointAfter?.length,
      checkpointBefore: checkpointBefore?.length,
      midCommitCheckpoints: checkpoints.filter(
        (c) =>
          c.reason === "interval" && c.rev > defined(changeSet).lastRev - 600
      ),
      revisions: defined(changeSet).revisionCount,
    }).toStrictEqual({
      allRewritten: true,
      blocksAfter: 600,
      blocksBefore: 600,
      checkpointAfter: 600,
      checkpointBefore: 600,
      midCommitCheckpoints: [],
      revisions: 600,
    });
  });

  it("the room's latest scribe run shows its scribe, who started it and its turn while working, then how it ended and its change set", async () => {
    const s = await setup();
    const outsider = s.t.withIdentity({
      email: "eve@example.com",
      name: "Eve",
      subject: "eve",
    });
    const none = await s.dana.query(api.scribe.latest, { roomId: s.roomId });

    const stopped = await runWithDraft(s);
    const working = await s.dana.query(api.scribe.latest, { roomId: s.roomId });
    const awaited = await runOf(s.t, stopped.scribeRunId);
    const outsiderRefusals = await rejectionsOf([
      async () => await outsider.query(api.scribe.latest, { roomId: s.roomId }),
    ]);

    await s.owner.mutation(api.messages.cancel, { turnId: stopped.turnId });
    const released = await s.dana.query(api.scribe.latest, {
      roomId: s.roomId,
    });

    const committed = await beginScribe(s.t, s.owner, s.roomId, s.pi._id);
    await draft(s.t, committed.turnId, {
      blockId: s.ideas._id,
      op: "replace",
      sourceBlockIds: [],
      text: "Ideas",
    });
    await finish(s.t, committed.turnId, committed.commandId);
    const [changeSet] = await scribeChangeSets(s.t, s.documentId);
    const ended = await s.dana.query(api.scribe.latest, { roomId: s.roomId });
    expect({
      changeSetWhileWorking: defined(working).changeSetId,
      ended,
      none,
      outsiderRefusals,
      released,
      stoppedWhileWorking: defined(working).stoppedByParticipantId,
      working,
    }).toMatchObject({
      changeSetWhileWorking: undefined,
      ended: {
        changeSetId: defined(changeSet)._id,
        participantId: s.pi._id,
        runId: committed.scribeRunId,
        startedByParticipantId: s.robert._id,
        status: "committed",
      },
      none: null,
      outsiderRefusals: ["Not a member of this room"],
      released: {
        releaseReason: "Cancelled by owner",
        runId: stopped.scribeRunId,
        status: "released",
        stoppedByParticipantId: s.robert._id,
      },
      stoppedWhileWorking: undefined,
      working: {
        participantId: s.claude._id,
        runId: stopped.scribeRunId,
        startedAt: awaited.startedAt,
        startedByParticipantId: s.danaP._id,
        status: "running",
        turnId: stopped.turnId,
      },
    });
  });
});
