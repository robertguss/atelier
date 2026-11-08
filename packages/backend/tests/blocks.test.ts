import { register as registerWorkflow } from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { ConvexError } from "convex/values";
import {
  beforeEach,
  afterEach,
  assert,
  expect,
  vi,
  it,
  describe,
} from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  insertBlock,
  openChangeSet,
  orderBetween,
} from "../convex/lib/document";
import schema from "../convex/schema";
import { closeTo, defined, rejectionsOf } from "./support";
import type { Caller } from "./support";

const modules = import.meta.glob("../convex/**/*.ts");

const MINUTE = 60_000;
// Each transaction runs at its own commit time, which can be a few ticks ahead of the frozen test clock.
const about = (ms: number) => closeTo(ms, -2);

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
    harnesses: [{ id: "claude", version: "test" }],
    machine: "test",
    name: "test",
    secret: "test-secret",
  });
  const roomId = await owner.mutation(api.rooms.create, {
    cwd: "/tmp/planning",
    name: "Planning",
    runnerId,
  });
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
  const robert = defined(participants.find((p) => p.displayName === "Robert"));
  const danaParticipant = defined(
    participants.find((p) => p.displayName === "Dana")
  );
  const claude = defined(participants.find((p) => p.harness === "claude"));
  const doc = defined(await owner.query(api.documents.get, { roomId }));
  const [happened, ideas, questions] = doc.blocks;
  return {
    claude,
    dana,
    danaParticipant,
    documentId: doc.documentId,
    happened: defined(happened),
    ideas: defined(ideas),
    owner,
    questions: defined(questions),
    robert,
    roomId,
    t,
  };
};

// A paragraph Claude wrote in its own turn, right after a heading.
const claudeParagraph = async (
  t: TestConvex<typeof schema>,
  documentId: Id<"documents">,
  claudeId: Id<"participants">,
  after: { order: string },
  text: string
) =>
  await t.run(async (ctx) => {
    const changeSetId = await openChangeSet(ctx, documentId, {
      actorParticipantId: claudeId,
      kind: "model_turn",
    });
    const awaited8 = await ctx.db
      .query("blocks")
      .withIndex("by_document_order", (q) =>
        q.eq("documentId", documentId).gt("order", after.order)
      )
      .first();
    const next = awaited8?.order ?? null;
    return await insertBlock(ctx, changeSetId, {
      author: { kind: "participant", participantId: claudeId },
      kind: "paragraph",
      order: orderBetween(after.order, next),
      text,
    });
  });

const revOf = async (t: TestConvex<typeof schema>, blockId: Id<"blocks">) =>
  defined(await t.run(async (ctx) => await ctx.db.get(blockId))).rev;

const texts = async (owner: Caller, roomId: Id<"rooms">) => {
  const doc = defined(await owner.query(api.documents.get, { roomId }));
  return doc.blocks.map((b) => b.text);
};

const setScribeLock = async (
  t: TestConvex<typeof schema>,
  documentId: Id<"documents">,
  roomId: Id<"rooms">,
  participantId: Id<"participants">,
  expiresAt: number
) => {
  await t.run(async (ctx) => {
    const scribeRunId = await ctx.db.insert("scribeRuns", {
      documentId,
      participantId,
      roomId,
      startedAt: Date.now(),
      startedByParticipantId: participantId,
      status: "running",
    });
    await ctx.db.patch(documentId, {
      scribeLockExpiresAt: expiresAt,
      scribeRunId,
    });
  });
};

describe("block editing", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.ATELIER_OWNER_EMAILS = "owner@example.com";
    process.env.ATELIER_RUNNER_SECRET = "test-secret";
    process.env.CLERK_SECRET_KEY = "sk_test";
    process.env.ATELIER_WEB_URL = "https://atelier.example.com/";
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("the teammate fixes a sentence in Claude's block: the block keeps Claude as author, is marked human-edited, and the revision is the teammate's", async () => {
    const {
      t,
      dana,
      owner,
      roomId,
      danaParticipant,
      claude,
      documentId,
      happened,
    } = await setup();
    const blockId = await claudeParagraph(
      t,
      documentId,
      claude._id,
      happened,
      "The cache is warmed on boot, wich is slow."
    );

    await dana.mutation(api.blocks.startEdit, { blockId });
    const savedAt = Date.now();
    await dana.mutation(api.blocks.save, {
      baseRev: await revOf(t, blockId),
      blockId,
      text: "The cache is warmed on boot, which is slow.",
    });

    const block = defined(
      defined(
        await owner.query(api.documents.get, {
          roomId,
        })
      ).blocks.find((b) => b._id === blockId)
    );
    expect(block.text).toBe("The cache is warmed on boot, which is slow.");
    expect(block.author).toStrictEqual({
      kind: "participant",
      participantId: claude._id,
    });
    expect(block.humanEditedAt).toStrictEqual(about(savedAt));
    const awaited7 = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 1 },
      roomId,
    });
    const [latest] = awaited7.page;
    expect([
      defined(latest).kind,
      defined(latest).actorParticipantId,
    ]).toStrictEqual(["human_edit", danaParticipant._id]);
    const diff = await owner.query(api.history.diff, {
      changeSetId: defined(latest)._id,
    });
    expect(
      diff.map((r) => [r.blockId, r.op, r.before?.text, r.after?.text])
    ).toStrictEqual([
      [
        blockId,
        "update",
        "The cache is warmed on boot, wich is slow.",
        "The cache is warmed on boot, which is slow.",
      ],
    ]);
  });

  it("editing your own block does not mark it human-edited", async () => {
    const { dana, owner, roomId, happened } = await setup();
    const { blocks } = await dana.mutation(api.blockOps.insertMany, {
      afterBlockId: happened._id,
      blocks: [{ kind: "paragraph", text: "My note" }],
      roomId,
    });
    const { blockId, rev } = defined(blocks[0]);
    await dana.mutation(api.blocks.save, {
      baseRev: rev,
      blockId,
      text: "My note, revised",
    });
    const block = defined(
      defined(
        await owner.query(api.documents.get, {
          roomId,
        })
      ).blocks.find((b) => b._id === blockId)
    );
    expect(block.humanEditedAt).toBeUndefined();
  });

  it("while Robert edits a block, the teammate cannot start editing, save or remove it, and is told Robert is editing it", async () => {
    const { owner, dana, roomId, robert, ideas } = await setup();
    const startedAt = Date.now();
    const { expiresAt } = await owner.mutation(api.blocks.startEdit, {
      blockId: ideas._id,
    });
    expect(expiresAt).toStrictEqual(about(startedAt + 2 * MINUTE));
    const block = defined(
      defined(
        await dana.query(api.documents.get, {
          roomId,
        })
      ).blocks.find((b) => b._id === ideas._id)
    );
    expect([
      block.leaseHolderParticipantId,
      block.leaseExpiresAt,
    ]).toStrictEqual([robert._id, expiresAt]);

    const editing = "Robert is editing this block";
    await expect(
      rejectionsOf([
        async () =>
          await dana.mutation(api.blocks.startEdit, { blockId: ideas._id }),
        async () =>
          await dana.mutation(api.blocks.save, {
            baseRev: ideas.rev,
            blockId: ideas._id,
            text: "Mine now",
          }),
        async () =>
          await dana.mutation(api.blocks.remove, { blockId: ideas._id }),
      ])
    ).resolves.toStrictEqual([editing, editing, editing]);
    await expect(texts(owner, roomId)).resolves.toStrictEqual([
      "What's happened",
      "Ideas & notes",
      "Open questions",
    ]);
  });

  it("starting to edit a block you hold renews the lease past two minutes from its start, and it lapses two minutes after the last renewal", async () => {
    const { t, owner, dana, ideas } = await setup();
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
    vi.advanceTimersByTime(90_000);
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
    vi.advanceTimersByTime(90_000);
    // The cleanup scheduled when the lease was taken has run and left the renewed lease alone.
    await t.finishInProgressScheduledFunctions();
    await expect(
      dana.mutation(api.blocks.startEdit, { blockId: ideas._id })
    ).rejects.toThrow("Robert is editing this block");
    vi.advanceTimersByTime(31_000);
    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
  });

  it("after two minutes idle, Robert's save with the block's rev retakes the free lease and writes, but is refused naming the teammate once she has taken the block", async () => {
    const { t, owner, dana, roomId, robert, ideas } = await setup();
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
    vi.advanceTimersByTime(2 * MINUTE + 1);
    const savedAt = Date.now();
    const { rev } = await owner.mutation(api.blocks.save, {
      baseRev: ideas.rev,
      blockId: ideas._id,
      text: "Late",
    });
    const retaken = defined(
      defined(await owner.query(api.documents.get, { roomId })).blocks.find(
        (b) => b._id === ideas._id
      )
    );
    expect([
      retaken.text,
      retaken.rev,
      retaken.leaseHolderParticipantId,
      retaken.leaseExpiresAt,
    ]).toStrictEqual(["Late", rev, robert._id, about(savedAt + 2 * MINUTE)]);

    vi.advanceTimersByTime(2 * MINUTE + 1);
    // The scheduled cleanup clears the lapsed lease.
    await t.finishInProgressScheduledFunctions();
    const cleared = defined(
      defined(await owner.query(api.documents.get, { roomId })).blocks.find(
        (b) => b._id === ideas._id
      )
    );
    expect([
      cleared.leaseHolderParticipantId,
      cleared.leaseExpiresAt,
    ]).toStrictEqual([undefined, undefined]);

    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
    await expect(
      owner.mutation(api.blocks.save, {
        baseRev: rev,
        blockId: ideas._id,
        text: "Later",
      })
    ).rejects.toThrow("Dana is editing this block");
    await expect(texts(owner, roomId)).resolves.toStrictEqual([
      "What's happened",
      "Late",
      "Open questions",
    ]);
  });

  it("a save based on an old rev is refused with the block's current text, checked state and rev, and changes nothing", async () => {
    const { owner, dana, roomId, ideas } = await setup();
    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
    const { rev } = await dana.mutation(api.blocks.save, {
      baseRev: ideas.rev,
      blockId: ideas._id,
      text: "Dana's ideas",
    });
    await dana.mutation(api.blocks.stopEdit, { blockId: ideas._id });

    // Robert's second browser still has the block as it was before Dana's save.
    const refusal = await owner
      .mutation(api.blocks.save, {
        baseRev: ideas.rev,
        blockId: ideas._id,
        text: "Robert's ideas",
      })
      .catch((error: unknown) => error);
    assert(refusal instanceof ConvexError, "the save was refused");
    // An unticked block carries no checked state.
    expect(refusal.data).toStrictEqual({
      message: "This block changed since you last saw it",
      rev,
      text: "Dana's ideas",
    });
    const block = defined(
      defined(await owner.query(api.documents.get, { roomId })).blocks.find(
        (b) => b._id === ideas._id
      )
    );
    expect([
      block.text,
      block.rev,
      block.leaseHolderParticipantId,
    ]).toStrictEqual(["Dana's ideas", rev, undefined]);
  });

  it("starting to edit a second block releases the person's lease on the first", async () => {
    const { owner, dana, roomId, robert, ideas, questions } = await setup();
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
    await owner.mutation(api.blocks.startEdit, { blockId: questions._id });
    const { blocks } = defined(
      await owner.query(api.documents.get, { roomId })
    );
    expect(
      blocks.map((b) => [b.text, b.leaseHolderParticipantId])
    ).toStrictEqual([
      ["What's happened", undefined],
      ["Ideas & notes", undefined],
      ["Open questions", robert._id],
    ]);
    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
  });

  it("two saves by the same person within one lease form one change set, and the next lease starts another", async () => {
    const { owner, dana, roomId, ideas } = await setup();
    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
    const first = await dana.mutation(api.blocks.save, {
      baseRev: ideas.rev,
      blockId: ideas._id,
      text: "Ideas",
    });
    vi.advanceTimersByTime(30_000);
    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
    const second = await dana.mutation(api.blocks.save, {
      baseRev: first.rev,
      blockId: ideas._id,
      text: "Ideas and notes",
    });
    await dana.mutation(api.blocks.stopEdit, { blockId: ideas._id });

    const awaited6 = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 10 },
      roomId,
    });
    expect(awaited6.page.map((c) => [c.kind, c.revisionCount])).toStrictEqual([
      ["human_edit", 2],
      ["template_seed", 3],
    ]);
    const block = defined(
      defined(
        await owner.query(api.documents.get, {
          roomId,
        })
      ).blocks.find((b) => b._id === ideas._id)
    );
    expect(block.leaseHolderParticipantId).toBeUndefined();

    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
    await dana.mutation(api.blocks.save, {
      baseRev: second.rev,
      blockId: ideas._id,
      text: "Notes",
    });
    const awaited5 = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 10 },
      roomId,
    });
    expect(awaited5.page.map((c) => [c.kind, c.revisionCount])).toStrictEqual([
      ["human_edit", 1],
      ["human_edit", 2],
      ["template_seed", 3],
    ]);
  });

  it("removing the teammate releases her lease at once, so Robert can edit the block", async () => {
    const { owner, dana, roomId, ideas } = await setup();
    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
    const { members } = await owner.query(api.members.list, { roomId });
    await owner.mutation(api.members.remove, {
      memberId: defined(members.find((m) => m.role === "member"))._id,
    });

    const block = defined(
      defined(
        await owner.query(api.documents.get, {
          roomId,
        })
      ).blocks.find((b) => b._id === ideas._id)
    );
    expect([
      block.leaseHolderParticipantId,
      block.leaseExpiresAt,
    ]).toStrictEqual([undefined, undefined]);
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
    await owner.mutation(api.blocks.save, {
      baseRev: ideas.rev,
      blockId: ideas._id,
      text: "Ideas",
    });
  });

  it("every human edit is refused with a notice that the scribe is working while its lock is unexpired, and allowed once it lapses", async () => {
    const { t, owner, dana, roomId, claude, documentId, happened, ideas } =
      await setup();
    await dana.mutation(api.blocks.startEdit, { blockId: happened._id });
    await setScribeLock(
      t,
      documentId,
      roomId,
      claude._id,
      Date.now() + 10 * MINUTE
    );

    const working = "The scribe is working on the document";
    await expect(
      rejectionsOf([
        async () =>
          await owner.mutation(api.blocks.startEdit, { blockId: ideas._id }),
        async () =>
          await dana.mutation(api.blocks.save, {
            baseRev: happened.rev,
            blockId: happened._id,
            text: "Changed",
          }),
        async () =>
          await owner.mutation(api.blockOps.insertMany, {
            afterBlockId: ideas._id,
            blocks: [{ kind: "paragraph", text: "New" }],
            roomId,
          }),
        async () =>
          await owner.mutation(api.blockOps.moveTo, {
            afterBlockId: null,
            baseRev: ideas.rev,
            blockId: ideas._id,
          }),
        async () =>
          await owner.mutation(api.blocks.remove, { blockId: ideas._id }),
      ])
    ).resolves.toStrictEqual(Array.from({ length: 5 }, () => working));
    await expect(texts(owner, roomId)).resolves.toStrictEqual([
      "What's happened",
      "Ideas & notes",
      "Open questions",
    ]);

    vi.advanceTimersByTime(10 * MINUTE + 1);
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
  });

  it("a block a person inserts is theirs, and inserting it and typing in it form one change set", async () => {
    const { owner, dana, roomId, danaParticipant, happened } = await setup();
    const { blocks } = await dana.mutation(api.blockOps.insertMany, {
      afterBlockId: happened._id,
      blocks: [{ kind: "listItem", text: "" }],
      roomId,
    });
    const { blockId, rev } = defined(blocks[0]);
    await dana.mutation(api.blocks.save, {
      baseRev: rev,
      blockId,
      text: "Dana item",
    });

    const doc = defined(await owner.query(api.documents.get, { roomId }));
    const inserted = defined(doc.blocks.find((b) => b._id === blockId));
    expect([inserted.kind, inserted.text, inserted.author]).toStrictEqual([
      "listItem",
      "Dana item",
      { kind: "participant", participantId: danaParticipant._id },
    ]);
    const { page } = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 1 },
      roomId,
    });
    expect(
      page.map((c) => [c.kind, c.actorParticipantId, c.revisionCount])
    ).toStrictEqual([["human_edit", danaParticipant._id, 2]]);
  });

  it("a removed block is recorded as a delete and can no longer be edited", async () => {
    const { owner, roomId, happened } = await setup();
    await owner.mutation(api.blocks.remove, { blockId: happened._id });
    await expect(texts(owner, roomId)).resolves.toStrictEqual([
      "Ideas & notes",
      "Open questions",
    ]);
    await expect(
      owner.mutation(api.blocks.startEdit, { blockId: happened._id })
    ).rejects.toThrow("This block has been removed");
    const { page } = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 1 },
      roomId,
    });
    const diff = await owner.query(api.history.diff, {
      changeSetId: defined(page[0])._id,
    });
    expect(diff.map((r) => r.op)).toStrictEqual(["delete"]);
  });

  it("removing the last block leaves one empty paragraph of the person's, in the same change set", async () => {
    const { owner, roomId, happened, ideas, questions, robert } = await setup();
    await owner.mutation(api.blocks.remove, { blockId: happened._id });
    await owner.mutation(api.blocks.remove, { blockId: ideas._id });
    await owner.mutation(api.blocks.remove, { blockId: questions._id });

    const doc = defined(await owner.query(api.documents.get, { roomId }));
    expect(
      doc.blocks.map(({ kind, text, author }) => ({ author, kind, text }))
    ).toStrictEqual([
      {
        author: { kind: "participant", participantId: robert._id },
        kind: "paragraph",
        text: "",
      },
    ]);
    const { page } = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 1 },
      roomId,
    });
    const last = await owner.query(api.history.diff, {
      changeSetId: defined(page[0])._id,
    });
    expect(last.map((r) => r.op).toSorted()).toStrictEqual([
      "delete",
      "insert",
    ]);
  });

  it("a person cannot save or insert a block longer than a model may write", async () => {
    const s = await setup();
    const long = "x".repeat(4001);
    await s.owner.mutation(api.blocks.startEdit, { blockId: s.ideas._id });
    await expect(
      s.owner.mutation(api.blocks.save, {
        baseRev: s.ideas.rev,
        blockId: s.ideas._id,
        text: long,
      })
    ).rejects.toThrow("at most 4000 characters");
    await s.owner.mutation(api.blocks.save, {
      baseRev: s.ideas.rev,
      blockId: s.ideas._id,
      text: "x".repeat(4000),
    });
    await expect(
      s.owner.mutation(api.blockOps.insertMany, {
        afterBlockId: null,
        blocks: [{ kind: "paragraph", text: long }],
        roomId: s.roomId,
      })
    ).rejects.toThrow("at most 4000 characters");
  });

  it("someone outside the room cannot edit its blocks", async () => {
    const { t, ideas } = await setup();
    const eve = t.withIdentity({
      email: "eve@example.com",
      name: "Eve",
      subject: "eve",
    });
    await expect(
      eve.mutation(api.blocks.startEdit, { blockId: ideas._id })
    ).rejects.toThrow("Not a member of this room");
  });
});
