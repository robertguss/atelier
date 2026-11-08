import { register as registerWorkflow } from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import type { FunctionArgs } from "convex/server";
import {
  assert,
  beforeEach,
  afterEach,
  expect,
  vi,
  it,
  describe,
} from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { MODEL_LIMITS } from "../convex/documentTools";
import {
  insertBlock,
  openChangeSet,
  orderBetween,
} from "../convex/lib/document";
import schema from "../convex/schema";
import { defined, stringContaining, stringMatching } from "./support";
import type { Caller } from "./support";

const modules = import.meta.glob("../convex/**/*.ts");

const SECRET = "test-secret";
const HARNESSES = [
  { id: "claude" as const, version: "test" },
  { id: "codex" as const, version: "test" },
  { id: "pi" as const, version: "test" },
];

type T = TestConvex<typeof schema>;

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
  const runnerId = await t.mutation(api.runners.heartbeat, {
    harnesses: HARNESSES,
    machine: "test",
    name: "test",
    secret: SECRET,
  });
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
  const [happened, ideas] = doc.blocks;
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
    robert: find("Robert"),
    roomId,
    runnerId,
    t,
  };
};

// Sends the agent a message and runs its turn as far as the runner has started it.
const runningTurn = async (
  t: T,
  caller: Caller,
  roomId: Id<"rooms">,
  participantId: Id<"participants">,
  body = "Go on"
) => {
  const turnId = defined(
    await caller.mutation(api.messages.send, {
      body,
      roomId,
      toParticipantId: participantId,
    })
  );
  const awaited10 = await t.run(
    async (ctx) => await ctx.db.query("commands").collect()
  );
  const command = defined(
    awaited10.find((c) => c.turnId === turnId && c.type === "run_turn")
  );
  const job = await t.mutation(api.runner.claim, {
    commandId: command._id,
    secret: SECRET,
  });
  await t.mutation(api.runner.start, {
    harnessVersion: "test",
    secret: SECRET,
    turnId,
  });
  return { commandId: command._id, job: defined(job), turnId };
};

const tools = (t: T, turnId: Id<"turns">) => {
  const s = { secret: SECRET, turnId };
  return {
    add: async (
      text: string,
      place: { afterBlockId?: string; endOfSectionId?: string } = {}
    ) =>
      await t.mutation(api.documentTools.addBlockForTurn, {
        ...s,
        ...place,
        kind: "paragraph",
        text,
      }),
    addAs: async (
      args: Omit<
        FunctionArgs<typeof api.documentTools.addBlockForTurn>,
        "secret" | "turnId"
      >
    ) => await t.mutation(api.documentTools.addBlockForTurn, { ...s, ...args }),
    comment: async (blockId: string, quote: string, body: string) =>
      await t.mutation(api.documentTools.commentForTurn, {
        ...s,
        blockId,
        body,
        quote,
      }),
    read: async () => await t.query(api.documentTools.readDocumentForTurn, s),
    readThread: async (threadId: string) =>
      await t.query(api.documentTools.readThreadForTurn, { ...s, threadId }),
    remove: async (blockId: string, baseRev: number) =>
      await t.mutation(api.documentTools.deleteBlockForTurn, {
        ...s,
        baseRev,
        blockId,
      }),
    update: async (blockId: string, baseRev: number, text: string) =>
      await t.mutation(api.documentTools.updateBlockForTurn, {
        ...s,
        baseRev,
        blockId,
        text,
      }),
    write: async (
      args: Omit<
        FunctionArgs<typeof api.documentTools.updateBlockForTurn>,
        "secret" | "turnId"
      >
    ) =>
      await t.mutation(api.documentTools.updateBlockForTurn, { ...s, ...args }),
  };
};

const block = async (t: T, rawId: string) =>
  await t.run(async (ctx) => {
    const blockId = ctx.db.normalizeId("blocks", rawId);
    assert(blockId, "the id names a block");
    const found = await ctx.db.get(blockId);
    assert(found, "the block exists");
    return found;
  });

const editBlock = async (
  caller: Caller,
  blockId: Id<"blocks">,
  text: string
) => {
  await caller.mutation(api.blocks.startEdit, { blockId });
  await caller.mutation(api.blocks.save, { blockId, text });
  await caller.mutation(api.blocks.stopEdit, { blockId });
};

const addedBlock = (result: {
  ok: boolean;
  blockId?: Id<"blocks">;
  rev?: number;
}) => {
  assert(result.ok, "the block was added");
  return { blockId: defined(result.blockId), rev: defined(result.rev) };
};

describe("document tools for models", () => {
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

  it("a model adds, updates and deletes its own blocks as one change set, under its own name, without taking a lease", async () => {
    const { t, owner, roomId, documentId, happened, ideas, claude } =
      await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const tool = tools(t, turnId);

    const first = addedBlock(
      await tool.add("The cache is warmed on boot.", {
        endOfSectionId: happened._id,
      })
    );
    const second = addedBlock(
      await tool.add("A second finding.", { afterBlockId: first.blockId })
    );
    const order = defined(
      await owner.query(api.documents.get, {
        roomId,
      })
    ).blocks.map((b) => b._id);
    expect({
      afterHeading: order.indexOf(first.blockId) - order.indexOf(happened._id),
      beforeIdeas: order.indexOf(second.blockId) < order.indexOf(ideas._id),
      secondAfterFirst:
        order.indexOf(second.blockId) - order.indexOf(first.blockId),
    }).toStrictEqual({
      afterHeading: 1,
      beforeIdeas: true,
      secondAfterFirst: 1,
    });

    const updated = await tool.update(
      first.blockId,
      first.rev,
      "The cache is warmed on boot, slowly."
    );
    const removed = await tool.remove(second.blockId, second.rev);
    expect({ removed, updatedOk: updated.ok }).toStrictEqual({
      removed: { ok: true },
      updatedOk: true,
    });

    const written = await block(t, first.blockId);
    const awaited9 = await block(t, second.blockId);
    expect({
      author: written.author,
      lease: written.leaseHolderParticipantId,
      removed: awaited9.deletedAt !== undefined,
      text: written.text,
    }).toStrictEqual({
      author: { kind: "participant", participantId: claude._id },
      lease: undefined,
      removed: true,
      text: "The cache is warmed on boot, slowly.",
    });
    await t.run(async (ctx) => {
      const awaited8 = await ctx.db.query("changeSets").collect();
      const changeSets = awaited8.filter(
        (c) => c.documentId === documentId && c.kind === "model_turn"
      );
      expect({ count: changeSets.length, only: changeSets[0] }).toMatchObject({
        count: 1,
        only: { actorParticipantId: claude._id, revisionCount: 4, turnId },
      });
      const awaited7 = await ctx.db.query("ledger").collect();
      const changed = awaited7.filter(
        (e) =>
          e.type === "document.changed" &&
          e.subjectId === defined(changeSets[0])._id
      );
      expect({
        leaksText: JSON.stringify(changed).includes("cache"),
        rows: changed.length,
      }).toStrictEqual({ leaksText: false, rows: 1 });
    });
  });

  it("Claude cannot edit a block Codex wrote, and can comment on its passage instead", async () => {
    const { t, owner, roomId, claude, codex } = await setup();
    const codexTurn = await runningTurn(t, owner, roomId, codex._id);
    const codexBlock = addedBlock(
      await tools(t, codexTurn.turnId).add("Ship the pricing page on Friday.")
    );

    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const tool = tools(t, turnId);
    const refused = await tool.update(
      codexBlock.blockId,
      codexBlock.rev,
      "Ship it on Monday."
    );
    const removal = await tool.remove(codexBlock.blockId, codexBlock.rev);
    const awaited6 = await block(t, codexBlock.blockId);
    const message = refused.ok ? "" : refused.message;
    expect({
      message: [/Codex/u.test(message), /comment/iu.test(message)],
      refused,
      removal,
      text: awaited6.text,
    }).toMatchObject({
      message: [true, true],
      refused: { ok: false, reason: "not_your_block" },
      removal: { ok: false, reason: "not_your_block" },
      text: "Ship the pricing page on Friday.",
    });

    const commented = await tool.comment(
      codexBlock.blockId,
      "on Friday",
      "Friday clashes with the freeze. @Pi what do you think?"
    );
    assert(commented.ok, "the comment was posted");
    const { threadId } = commented;
    const { open } = await owner.query(api.threads.list, { roomId });
    const awaited5 = await t.run(
      async (ctx) => await ctx.db.query("messages").collect()
    );
    expect({
      comments: defined(open[0]).comments.map((c) => [
        c.authorParticipantId,
        c.body,
        c.mentions,
      ]),
      // A model's comment summons no one.
      deliveries: awaited5.filter((m) => m.threadId).length,
      thread: {
        _id: defined(open[0])._id,
        blockId: defined(open[0]).blockId,
        exact: defined(open[0]).exact,
      },
      threads: open.length,
    }).toStrictEqual({
      comments: [
        [
          claude._id,
          "Friday clashes with the freeze. @Pi what do you think?",
          [],
        ],
      ],
      deliveries: 0,
      thread: {
        _id: threadId,
        blockId: codexBlock.blockId,
        exact: "on Friday",
      },
      threads: 1,
    });
  });

  it("a comment whose quote appears twice in the block is refused, so the model can quote a longer passage", async () => {
    const { t, owner, roomId, documentId, claude, codex } = await setup();
    const blockId = await t.run(async (ctx) => {
      const changeSetId = await openChangeSet(ctx, documentId, {
        actorParticipantId: codex._id,
        kind: "model_turn",
      });
      return await insertBlock(ctx, changeSetId, {
        author: { kind: "participant", participantId: codex._id },
        kind: "paragraph",
        order: "a0V",
        text: "We ship it Friday. Then, we ship it Monday.",
      });
    });
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    await expect(
      tools(t, turnId).comment(blockId, "ship it", "Which one?")
    ).resolves.toMatchObject({ ok: false, reason: "quote_ambiguous" });
    await expect(
      tools(t, turnId).comment(blockId, "ship it Monday", "Why wait?")
    ).resolves.toMatchObject({ ok: true });
  });

  it("a comment whose quote is not in the block is refused, so the model can quote it again", async () => {
    const { t, owner, roomId, happened, claude } = await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    await expect(
      tools(t, turnId).comment(happened._id, "not there", "Hm")
    ).resolves.toMatchObject({ ok: false, reason: "quote_not_found" });
    const awaited4 = await owner.query(api.threads.list, { roomId });
    expect(awaited4.open).toHaveLength(0);
  });

  it("an update with a stale base rev is refused and returns the current text and who changed it", async () => {
    const { t, owner, dana, roomId, claude } = await setup();
    const first = await runningTurn(t, owner, roomId, claude._id);
    const added = addedBlock(
      await tools(t, first.turnId).add("Use the smaller plan.")
    );
    await t.mutation(api.runner.finish, {
      commandId: first.commandId,
      finalText: "ok",
      secret: SECRET,
      sessionId: "s",
      transcriptRef: "/t",
      turnId: first.turnId,
    });
    await editBlock(
      dana,
      added.blockId,
      "Use the smaller plan, but keep annual billing."
    );

    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const refused = await tools(t, turnId).update(
      added.blockId,
      added.rev,
      "Use the bigger plan."
    );
    const current = await block(t, added.blockId);
    expect(refused).toMatchObject({
      current: {
        changedBy: "Dana",
        rev: current.rev,
        text: "Use the smaller plan, but keep annual billing.",
      },
      ok: false,
      reason: "stale",
    });
    expect(current.text).toBe("Use the smaller plan, but keep annual billing.");

    // With the current rev the model can build on the teammate's fix; the block stays its own.
    await expect(
      tools(t, turnId).update(
        added.blockId,
        current.rev,
        "Use the smaller plan, but keep annual billing. Revisit in March."
      )
    ).resolves.toMatchObject({ ok: true });
    const awaited3 = await block(t, added.blockId);
    expect(awaited3.author).toStrictEqual({
      kind: "participant",
      participantId: claude._id,
    });
  });

  it("a model cannot delete a block the teammate edited, even with a fresh base rev", async () => {
    const { t, owner, dana, roomId, claude } = await setup();
    const first = await runningTurn(t, owner, roomId, claude._id);
    const added = addedBlock(
      await tools(t, first.turnId).add("Draft finding.")
    );
    await t.mutation(api.runner.finish, {
      commandId: first.commandId,
      finalText: "ok",
      secret: SECRET,
      sessionId: "s",
      transcriptRef: "/t",
      turnId: first.turnId,
    });
    await editBlock(dana, added.blockId, "Draft finding, corrected by Dana.");

    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const awaited2 = await block(t, added.blockId);
    const refused = await tools(t, turnId).remove(added.blockId, awaited2.rev);
    expect(refused).toMatchObject({ ok: false, reason: "human_edited" });
    expect(refused).toMatchObject({ message: stringMatching(/comment/iu) });
    const awaited = await block(t, added.blockId);
    expect(awaited.deletedAt).toBeUndefined();
  });

  it("a write to a block someone is editing is refused and names the editor", async () => {
    const { t, owner, dana, roomId, claude } = await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const added = addedBlock(await tools(t, turnId).add("Open question."));
    await dana.mutation(api.blocks.startEdit, { blockId: added.blockId });

    const refused = await tools(t, turnId).update(
      added.blockId,
      added.rev,
      "Answered."
    );
    expect(refused).toMatchObject({
      message: stringContaining("Dana is editing this block"),
      ok: false,
      reason: "being_edited",
    });
    await expect(
      tools(t, turnId).remove(added.blockId, added.rev)
    ).resolves.toMatchObject({ ok: false, reason: "being_edited" });
    const read = await tools(t, turnId).read();
    assert(read.ok, "the document was read");
    expect(read.blocks.find((b) => b.id === added.blockId)).toMatchObject({
      editingBy: "Dana",
    });

    // Once her lease lapses, the model's write goes through.
    vi.advanceTimersByTime(3 * 60_000);
    await expect(
      tools(t, turnId).update(added.blockId, added.rev, "Answered.")
    ).resolves.toMatchObject({ ok: true });
  });

  it("while the scribe works, block writes are refused with a notice and comments still work", async () => {
    const { t, owner, roomId, documentId, happened, claude, robert } =
      await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    await t.run(async (ctx) => {
      const scribeRunId = await ctx.db.insert("scribeRuns", {
        documentId,
        participantId: claude._id,
        roomId,
        startedAt: Date.now(),
        startedByParticipantId: robert._id,
        status: "running",
      });
      await ctx.db.patch(documentId, {
        scribeLockExpiresAt: Date.now() + 35 * 60_000,
        scribeRunId,
      });
    });
    const refused = await tools(t, turnId).add("A finding.");
    expect(refused).toMatchObject({
      message: stringMatching(/scribe is working/u),
      ok: false,
      reason: "scribe_working",
    });
    await expect(
      tools(t, turnId).comment(happened._id, "happened", "A note")
    ).resolves.toMatchObject({ ok: true });
  });

  it("the 21st block write and the 11th comment in one turn are refused with the cap message", async () => {
    const { t, owner, roomId, happened, claude, codex } = await setup();
    expect(MODEL_LIMITS).toStrictEqual({
      blockChars: 4000,
      blockWritesPerTurn: 20,
      commentsPerTurn: 10,
      documentBlocks: 600,
    });
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const tool = tools(t, turnId);
    for (let i = 0; i < 20; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
      await expect(tool.add(`Finding ${i}`)).resolves.toMatchObject({
        ok: true,
      });
    }
    const refused = await tool.add("Finding 21");
    expect(refused).toMatchObject({
      message: stringContaining("20 block writes"),
      ok: false,
      reason: "cap_reached",
    });

    for (let i = 0; i < 10; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
      await expect(
        tool.comment(happened._id, "happened", `Note ${i}`)
      ).resolves.toMatchObject({ ok: true });
    }
    await expect(
      tool.comment(happened._id, "happened", "Note 11")
    ).resolves.toMatchObject({
      message: stringContaining("10 comments"),
      ok: false,
      reason: "cap_reached",
    });

    // Another turn has its own allowance.
    const next = await runningTurn(t, owner, roomId, codex._id, "Next");
    await expect(
      tools(t, next.turnId).add("Finding 22")
    ).resolves.toMatchObject({
      ok: true,
    });
  });

  it("a block over 4,000 characters and a block past the document's 600 are refused", async () => {
    const { t, owner, roomId, documentId, claude } = await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    await expect(tools(t, turnId).add("x".repeat(4001))).resolves.toMatchObject(
      {
        ok: false,
        reason: "too_long",
      }
    );
    await expect(tools(t, turnId).add("x".repeat(4000))).resolves.toMatchObject(
      {
        ok: true,
      }
    );

    await t.run(async (ctx) => {
      const changeSetId = await openChangeSet(ctx, documentId, {
        kind: "human_edit",
      });
      const blocks = await ctx.db.query("blocks").collect();
      let order = defined(
        blocks
          .map((b) => b.order)
          .toSorted()
          .at(-1)
      );
      for (let i = blocks.length; i < 600; i += 1) {
        order = orderBetween(order, null);
        // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
        await insertBlock(ctx, changeSetId, {
          author: { kind: "participant", participantId: claude._id },
          kind: "paragraph",
          order,
          text: `filler ${i}`,
        });
      }
    });
    await expect(tools(t, turnId).add("One too many")).resolves.toMatchObject({
      ok: false,
      reason: "document_full",
    });
  });

  it("a write from a turn that is no longer running, or was never claimed, is refused", async () => {
    const { t, owner, roomId, claude, codex } = await setup();
    const { turnId, commandId } = await runningTurn(
      t,
      owner,
      roomId,
      claude._id
    );
    const added = addedBlock(await tools(t, turnId).add("Before the end."));
    await t.mutation(api.runner.finish, {
      commandId,
      finalText: "ok",
      secret: SECRET,
      sessionId: "s",
      transcriptRef: "/t",
      turnId,
    });
    await expect(tools(t, turnId).add("After the end.")).resolves.toMatchObject(
      {
        ok: false,
        reason: "turn_ended",
      }
    );
    await expect(
      tools(t, turnId).update(added.blockId, added.rev, "After the end.")
    ).resolves.toMatchObject({ ok: false, reason: "turn_ended" });
    await expect(tools(t, turnId).read()).resolves.toMatchObject({
      ok: false,
      reason: "turn_ended",
    });

    const queued = defined(
      await owner.mutation(api.messages.send, {
        body: "Wait",
        roomId,
        toParticipantId: codex._id,
      })
    );
    await expect(tools(t, queued).add("Too early.")).resolves.toMatchObject({
      ok: false,
      reason: "turn_ended",
    });
    await expect(
      t.mutation(api.documentTools.addBlockForTurn, {
        kind: "paragraph",
        secret: "wrong",
        text: "x",
        turnId,
      })
    ).rejects.toThrow("Bad runner secret");
  });

  it("a block from another room, or an id that is not a block, is not found", async () => {
    const { t, owner, runnerId, roomId, claude } = await setup();
    const otherRoom = await owner.mutation(api.rooms.create, {
      cwd: "/tmp/elsewhere",
      name: "Elsewhere",
      runnerId,
    });
    const foreign = defined(
      defined(
        await owner.query(api.documents.get, {
          roomId: otherRoom,
        })
      ).blocks[0]
    );
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    await expect(
      tools(t, turnId).update(foreign._id, foreign.rev, "Mine now")
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
    await expect(
      tools(t, turnId).comment(foreign._id, foreign.text, "Hi")
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
    await expect(
      tools(t, turnId).add("Here", { afterBlockId: "not-an-id" })
    ).resolves.toMatchObject({ ok: false, reason: "not_found" });
  });

  it("reading the document returns every block with its id, author and rev, and its threads", async () => {
    const { t, owner, dana, roomId, happened, claude } = await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const added = addedBlock(await tools(t, turnId).add("My finding."));
    const threadId = await dana.mutation(api.threads.create, {
      blockId: happened._id,
      body: "Settle this later",
      end: 4,
      start: 0,
    });
    await owner.mutation(api.threads.settle, { threadId });

    const read = await tools(t, turnId).read();
    assert(read.ok, "the document was read");
    const { blocks, threads } = read;
    expect(blocks.find((b) => b.id === happened._id)).toMatchObject({
      author: "Robert",
      kind: "heading",
      text: "What's happened",
      yours: false,
    });
    expect(blocks.find((b) => b.id === added.blockId)).toMatchObject({
      author: "Claude",
      rev: added.rev,
      text: "My finding.",
      yours: true,
    });
    expect(threads).toStrictEqual([
      expect.objectContaining({
        blockId: happened._id,
        comments: 1,
        id: threadId,
        passage: "What",
        state: "settled",
      }),
    ]);

    const thread = await tools(t, turnId).readThread(threadId);
    expect(thread).toMatchObject({
      comments: [{ author: "Dana", body: "Settle this later" }],
      ok: true,
      passage: "What",
      state: "settled",
    });
  });

  it("a model adds each new kind, and read_document and the next digest show its tick and number", async () => {
    const { t, owner, roomId, claude, codex } = await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const tool = tools(t, turnId);
    const add = async (
      kind: "todo" | "numberedItem" | "quote" | "code" | "divider",
      text: string,
      checked?: boolean
    ) =>
      addedBlock(
        await tool.addAs({
          kind,
          text,
          ...(checked === undefined ? {} : { checked }),
        })
      ).blockId;
    const todo = await add("todo", "Book the venue", true);
    const first = await add("numberedItem", "Draft");
    const second = await add("numberedItem", "Review");
    const quote = await add("quote", "Ship small.");
    const divider = await add("divider", "");
    const code = await add("code", "const x = 1;\n  return x;");

    const read = await tool.read();
    assert(read.ok, "the document was read");
    const shown = (id: Id<"blocks">) => {
      const b = defined(read.blocks.find((row) => row.id === id));
      return { checked: b.checked, kind: b.kind, number: b.number };
    };
    expect(
      [todo, first, second, quote, divider, code].map(shown)
    ).toStrictEqual([
      { checked: true, kind: "todo", number: undefined },
      { checked: undefined, kind: "numberedItem", number: 1 },
      { checked: undefined, kind: "numberedItem", number: 2 },
      { checked: undefined, kind: "quote", number: undefined },
      { checked: undefined, kind: "divider", number: undefined },
      { checked: undefined, kind: "code", number: undefined },
    ]);

    const { job } = await runningTurn(t, owner, roomId, codex._id);
    const { prompt } = job.turn;
    expect(prompt).toContain(
      `[${todo}] todo (checked) by Claude\n  Book the venue`
    );
    expect(prompt).toContain(`[${first}] numberedItem #1 by Claude`);
    expect(prompt).toContain(`[${second}] numberedItem #2 by Claude`);
    expect(prompt).toContain(
      `[${divider}] divider by Claude\n[${code}] code by Claude\n  const x = 1;\n    return x;`
    );
  });

  it("a divider with text, a tick on a paragraph, empty code and an update with nothing to change are refused", async () => {
    const { t, owner, roomId, claude } = await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const tool = tools(t, turnId);
    const own = addedBlock(await tool.add("A note."));
    expect([
      await tool.addAs({ kind: "divider", text: "x" }),
      await tool.addAs({ checked: true, kind: "paragraph", text: "A note." }),
      await tool.addAs({ kind: "code", text: "" }),
      await tool.write({ baseRev: own.rev, blockId: own.blockId }),
      await tool.write({
        baseRev: own.rev,
        blockId: own.blockId,
        checked: true,
      }),
    ]).toMatchObject([
      { ok: false, reason: "bad_request" },
      { ok: false, reason: "bad_request" },
      { ok: false, reason: "empty" },
      { ok: false, reason: "bad_request" },
      { ok: false, reason: "bad_request" },
    ]);
  });

  it("a model ticks its own to-do without sending text, and its old rev is then stale with the tick", async () => {
    const { t, owner, roomId, claude } = await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const tool = tools(t, turnId);
    const added = addedBlock(
      await tool.addAs({ kind: "todo", text: "Write the brief" })
    );
    const ticked = await tool.write({
      baseRev: added.rev,
      blockId: added.blockId,
      checked: true,
    });
    assert(ticked.ok, "the tick was written");
    const written = await block(t, added.blockId);
    expect({
      checked: written.checked,
      rev: ticked.rev > added.rev,
      text: written.text,
    }).toStrictEqual({ checked: true, rev: true, text: "Write the brief" });

    await expect(
      tool.write({ baseRev: added.rev, blockId: added.blockId, checked: false })
    ).resolves.toMatchObject({
      current: { checked: true, rev: ticked.rev },
      ok: false,
      reason: "stale",
    });
  });

  it("after a person ticks a model's to-do, the model's update with its old rev is stale with the tick, and another model cannot tick it", async () => {
    const { t, owner, roomId, claude, codex, dana } = await setup();
    const { turnId } = await runningTurn(t, owner, roomId, claude._id);
    const added = addedBlock(
      await tools(t, turnId).addAs({ kind: "todo", text: "Book the venue" })
    );
    await dana.mutation(api.blockOps.toggleChecked, {
      baseRev: added.rev,
      blockId: added.blockId,
      checked: true,
    });

    await expect(
      tools(t, turnId).update(added.blockId, added.rev, "Book the hall")
    ).resolves.toMatchObject({
      current: { changedBy: "Dana", checked: true, text: "Book the venue" },
      ok: false,
      reason: "stale",
    });

    const codexTurn = await runningTurn(t, owner, roomId, codex._id);
    const current = await block(t, added.blockId);
    await expect(
      tools(t, codexTurn.turnId).write({
        baseRev: current.rev,
        blockId: added.blockId,
        checked: false,
      })
    ).resolves.toMatchObject({ ok: false, reason: "not_your_block" });
  });

  it("a phrase from team chat never reaches a digest, a tool result or a claim payload", async () => {
    const { t, owner, dana, roomId, happened, claude } = await setup();
    await owner.mutation(api.team.post, {
      body: "TEAM-ONLY-PHRASE: between us, drop the pricing page",
      roomId,
    });
    await dana.mutation(api.team.post, {
      body: "agreed, TEAM-ONLY-PHRASE",
      roomId,
    });

    const { turnId, job } = await runningTurn(
      t,
      owner,
      roomId,
      claude._id,
      "Write down what we agreed"
    );
    const tool = tools(t, turnId);
    const added = addedBlock(await tool.add("We agreed to ship on Friday."));
    const commented = await tool.comment(happened._id, "happened", "Noted.");
    assert(commented.ok, "the comment was posted");
    const results = [
      job,
      added,
      commented,
      await tool.update(
        added.blockId,
        added.rev,
        "We agreed to ship on Friday, after review."
      ),
      await tool.read(),
      await tool.readThread(commented.threadId),
    ];
    expect(JSON.stringify(results)).not.toContain("TEAM-ONLY-PHRASE");
    expect(job.type === "run_turn" && job.turn.prompt).toContain(
      "<room_document"
    );
    await t.run(async (ctx) => {
      for (const table of [
        "blocks",
        "blockRevisions",
        "comments",
        "turns",
      ] as const) {
        expect(
          // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
          JSON.stringify(await ctx.db.query(table).collect())
        ).not.toContain("TEAM-ONLY-PHRASE");
      }
    });
  });
});
