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
    const { dana, owner, roomId } = await setup();
    const blockId = await dana.mutation(api.blocks.add, {
      endOfSectionId: defined(
        defined(await owner.query(api.documents.get, { roomId })).blocks[0]
      )._id,
      kind: "paragraph",
      roomId,
      text: "My note",
    });
    await dana.mutation(api.blocks.save, { blockId, text: "My note, revised" });
    const block = defined(
      defined(
        await owner.query(api.documents.get, {
          roomId,
        })
      ).blocks.find((b) => b._id === blockId)
    );
    expect(block.humanEditedAt).toBeUndefined();
  });

  it("while Robert edits a block, the teammate cannot start editing, save, move or remove it, and is told Robert is editing it", async () => {
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
            blockId: ideas._id,
            text: "Mine now",
          }),
        async () =>
          await dana.mutation(api.blocks.move, {
            blockId: ideas._id,
            direction: "up",
          }),
        async () =>
          await dana.mutation(api.blocks.remove, { blockId: ideas._id }),
      ])
    ).resolves.toStrictEqual([editing, editing, editing, editing]);
    await expect(texts(owner, roomId)).resolves.toStrictEqual([
      "What's happened",
      "Ideas & notes",
      "Open questions",
    ]);
  });

  it("a renewed lease holds past two minutes from its start, and lapses two minutes after the last renewal", async () => {
    const { t, owner, dana, ideas } = await setup();
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
    vi.advanceTimersByTime(90_000);
    await owner.mutation(api.blocks.renew, { blockId: ideas._id });
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
    await expect(
      owner.mutation(api.blocks.renew, { blockId: ideas._id })
    ).rejects.toThrow("Your edit lock on this block has lapsed");
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
    await dana.mutation(api.blocks.save, { blockId: ideas._id, text: "Ideas" });
    vi.advanceTimersByTime(30_000);
    await dana.mutation(api.blocks.renew, { blockId: ideas._id });
    await dana.mutation(api.blocks.save, {
      blockId: ideas._id,
      text: "Ideas and notes",
    });
    await dana.mutation(api.blocks.stopEdit, { blockId: ideas._id });

    const awaited6 = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 10 },
      roomId,
    });
    const first = awaited6.page;
    expect(first.map((c) => [c.kind, c.revisionCount])).toStrictEqual([
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
    await dana.mutation(api.blocks.save, { blockId: ideas._id, text: "Notes" });
    const awaited5 = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 10 },
      roomId,
    });
    const second = awaited5.page;
    expect(second.map((c) => [c.kind, c.revisionCount])).toStrictEqual([
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
          await dana.mutation(api.blocks.renew, { blockId: happened._id }),
        async () =>
          await dana.mutation(api.blocks.save, {
            blockId: happened._id,
            text: "Changed",
          }),
        async () =>
          await owner.mutation(api.blocks.add, {
            afterBlockId: ideas._id,
            kind: "paragraph",
            roomId,
            text: "New",
          }),
        async () =>
          await owner.mutation(api.blocks.move, {
            blockId: ideas._id,
            direction: "down",
          }),
        async () =>
          await owner.mutation(api.blocks.remove, { blockId: ideas._id }),
      ])
    ).resolves.toStrictEqual(Array.from({ length: 6 }, () => working));
    await expect(texts(owner, roomId)).resolves.toStrictEqual([
      "What's happened",
      "Ideas & notes",
      "Open questions",
    ]);

    vi.advanceTimersByTime(10 * MINUTE + 1);
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
  });

  it("a person adds a block after a block or at the end of a section, as its author, and the add and later saves form one change set", async () => {
    const {
      t,
      owner,
      dana,
      roomId,
      robert,
      danaParticipant,
      claude,
      documentId,
      happened,
      ideas,
    } = await setup();
    await claudeParagraph(
      t,
      documentId,
      claude._id,
      happened,
      "Claude finding"
    );

    const endOfSection = await dana.mutation(api.blocks.add, {
      endOfSectionId: happened._id,
      kind: "listItem",
      roomId,
      text: "",
    });
    await dana.mutation(api.blocks.save, {
      blockId: endOfSection,
      text: "Dana item",
    });
    const afterHeading = await owner.mutation(api.blocks.add, {
      afterBlockId: ideas._id,
      kind: "paragraph",
      roomId,
      text: "Robert idea",
    });
    const lastSection = await owner.mutation(api.blocks.add, {
      endOfSectionId: defined(
        defined(
          await owner.query(api.documents.get, {
            roomId,
          })
        ).blocks.at(-1)
      )._id,
      kind: "heading",
      roomId,
      text: "Decisions",
    });

    const { blocks } = defined(
      await owner.query(api.documents.get, { roomId })
    );
    expect(blocks.map((b) => [b.kind, b.text])).toStrictEqual([
      ["heading", "What's happened"],
      ["paragraph", "Claude finding"],
      ["listItem", "Dana item"],
      ["heading", "Ideas & notes"],
      ["paragraph", "Robert idea"],
      ["heading", "Open questions"],
      ["heading", "Decisions"],
    ]);
    const byId = new Map(blocks.map((b) => [b._id, b]));
    expect(defined(byId.get(endOfSection)).author).toStrictEqual({
      kind: "participant",
      participantId: danaParticipant._id,
    });
    expect(defined(byId.get(afterHeading)).author).toStrictEqual({
      kind: "participant",
      participantId: robert._id,
    });
    // Adding a block starts editing it.
    expect(defined(byId.get(lastSection)).leaseHolderParticipantId).toBe(
      robert._id
    );

    const awaited4 = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 3 },
      roomId,
    });
    const history = awaited4.page;
    expect(
      history.map((c) => [c.kind, c.actorParticipantId, c.revisionCount])
    ).toStrictEqual([
      ["human_edit", robert._id, 1],
      ["human_edit", robert._id, 1],
      ["human_edit", danaParticipant._id, 2],
    ]);
  });

  it("a person moves a block up and down past its neighbours and removes it", async () => {
    const { owner, dana, roomId, happened, questions } = await setup();
    const seen: string[][] = [];
    const move = async (blockId: Id<"blocks">, direction: "down" | "up") => {
      await dana.mutation(api.blocks.move, { blockId, direction });
      seen.push(await texts(owner, roomId));
    };
    await move(questions._id, "up");
    await move(questions._id, "up");
    // The first block cannot move further up.
    await move(questions._id, "up");
    await move(happened._id, "down");
    await owner.mutation(api.blocks.remove, { blockId: happened._id });
    seen.push(await texts(owner, roomId));
    await expect(
      owner.mutation(api.blocks.startEdit, { blockId: happened._id })
    ).rejects.toThrow("This block has been removed");

    const awaited3 = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 4 },
      roomId,
    });
    const history = awaited3.page;
    const ops = [];
    for (const changeSet of history) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each step depends on the one before it
      const awaited2 = await owner.query(api.history.diff, {
        changeSetId: changeSet._id,
      });
      ops.push(awaited2.map((r) => r.op));
    }
    expect({ ops, seen }).toStrictEqual({
      ops: [["delete"], ["move"], ["move"], ["move"]],
      seen: [
        ["What's happened", "Open questions", "Ideas & notes"],
        ["Open questions", "What's happened", "Ideas & notes"],
        ["Open questions", "What's happened", "Ideas & notes"],
        ["Open questions", "Ideas & notes", "What's happened"],
        ["Open questions", "Ideas & notes"],
      ],
    });
  });

  it("a person cannot save or add a block longer than a model may write, or add past the document's block limit", async () => {
    const s = await setup();
    const long = "x".repeat(4001);
    await s.owner.mutation(api.blocks.startEdit, { blockId: s.ideas._id });
    await expect(
      s.owner.mutation(api.blocks.save, { blockId: s.ideas._id, text: long })
    ).rejects.toThrow("at most 4000 characters");
    await s.owner.mutation(api.blocks.save, {
      blockId: s.ideas._id,
      text: "x".repeat(4000),
    });
    await expect(
      s.owner.mutation(api.blocks.add, {
        kind: "paragraph",
        roomId: s.roomId,
        text: long,
      })
    ).rejects.toThrow("at most 4000 characters");

    await s.t.run(async (ctx) => {
      const awaited = await ctx.db.query("blocks").collect();
      const live = awaited.length;
      for (let i = live; i < 600; i += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- rows are written one at a time, in order
        await ctx.db.insert("blocks", {
          author: { kind: "participant", participantId: s.robert._id },
          documentId: s.documentId,
          kind: "paragraph",
          order: `b${String(i).padStart(4, "0")}`,
          rev: 0,
          roomId: s.roomId,
          text: "filler",
        });
      }
    });
    await expect(
      s.owner.mutation(api.blocks.add, {
        kind: "paragraph",
        roomId: s.roomId,
        text: "one too many",
      })
    ).rejects.toThrow("at most 600 blocks");
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
