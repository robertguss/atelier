import { register as registerWorkflow } from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { ConvexError } from "convex/values";
import {
  afterEach,
  assert,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { api } from "../convex/_generated/api";
import type { Doc, Id } from "../convex/_generated/dataModel";
import {
  insertBlock,
  openChangeSet,
  orderBetween,
} from "../convex/lib/document";
import schema from "../convex/schema";
import { closeTo, defined } from "./support";
import type { Caller } from "./support";

const modules = import.meta.glob("../convex/**/*.ts");

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
  const claude = defined(participants.find((p) => p.harness === "claude"));
  const doc = defined(await owner.query(api.documents.get, { roomId }));
  const [happened, ideas, questions] = doc.blocks;
  return {
    claude,
    dana,
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
type Setup = Awaited<ReturnType<typeof setup>>;

// A block written straight after `after`, by a person in their own edit or
// by a model in its turn.
const write = async (
  s: Setup,
  author: Id<"participants">,
  after: { order: string },
  text: string,
  kind: Doc<"blocks">["kind"] = "paragraph"
) =>
  await s.t.run(async (ctx) => {
    const changeSetId = await openChangeSet(ctx, s.documentId, {
      actorParticipantId: author,
      kind: author === s.claude._id ? "model_turn" : "human_edit",
    });
    const next = await ctx.db
      .query("blocks")
      .withIndex("by_document_order", (q) =>
        q.eq("documentId", s.documentId).gt("order", after.order)
      )
      .first();
    return await insertBlock(ctx, changeSetId, {
      author: { kind: "participant", participantId: author },
      kind,
      order: orderBetween(after.order, next?.order ?? null),
      text,
    });
  });

const blocksOf = async (s: Setup) =>
  defined(await s.owner.query(api.documents.get, { roomId: s.roomId })).blocks;

const blockOf = async (s: Setup, blockId: Id<"blocks">) => {
  const blocks = await blocksOf(s);
  return defined(blocks.find((b) => b._id === blockId));
};

const revOf = async (s: Setup, blockId: Id<"blocks">) => {
  const { rev } = await blockOf(s, blockId);
  return rev;
};

const texts = async (s: Setup) => {
  const blocks = await blocksOf(s);
  return blocks.map((b) => b.text);
};

const threadOf = async (s: Setup, threadId: Id<"threads">) =>
  defined(await s.t.run(async (ctx) => await ctx.db.get(threadId)));

const comment = async (
  caller: Caller,
  blockId: Id<"blocks">,
  text: string,
  passage: string
) => {
  const start = text.indexOf(passage);
  return (await caller.mutation(api.threads.create, {
    blockId,
    body: "Is this right?",
    end: start + passage.length,
    start,
  })) as Id<"threads">;
};

const changeSets = async (s: Setup) => {
  const { page } = await s.owner.query(api.history.list, {
    paginationOpts: { cursor: null, numItems: 20 },
    roomId: s.roomId,
  });
  return page;
};

const refusalOf = async (call: Promise<unknown>) => {
  const refusal = await call.catch((error: unknown) => error);
  assert(refusal instanceof ConvexError, "the write was refused as stale");
  return refusal.data as unknown;
};

const STALE = "This block changed since you last saw it";

describe("structural block edits", () => {
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

  it("pressing Enter before a commented sentence splits the block in one change set, and the comment follows its sentence into the new block", async () => {
    const s = await setup();
    const text =
      "Ship the beta on Friday. Then gather feedback from the first ten teams.";
    const blockId = await write(s, s.robert._id, s.happened, text);
    const threadId = await comment(
      s.dana,
      blockId,
      text,
      "Then gather feedback from the first ten teams."
    );
    const before = await changeSets(s);

    const split = await s.owner.mutation(api.blockOps.split, {
      baseRev: await revOf(s, blockId),
      blockId,
      headText: "Ship the beta on Friday. ",
      tailKind: "paragraph",
      tailText: "Then gather feedback from the first ten teams.",
    });

    await expect(texts(s)).resolves.toStrictEqual([
      "What's happened",
      "Ship the beta on Friday. ",
      "Then gather feedback from the first ten teams.",
      "Ideas & notes",
      "Open questions",
    ]);
    const head = await blockOf(s, blockId);
    const tail = await blockOf(s, split.tailId);
    expect([head.rev, tail.rev]).toStrictEqual([split.rev, split.tailRev]);
    expect(tail.leaseHolderParticipantId).toBe(s.robert._id);
    const thread = await threadOf(s, threadId);
    expect([
      thread.blockId,
      thread.exact,
      thread.position,
      thread.detachedBeforeChangeSetId,
    ]).toStrictEqual([
      split.tailId,
      "Then gather feedback from the first ten teams.",
      0,
      undefined,
    ]);
    const after = await changeSets(s);
    expect([
      after.length - before.length,
      after[0]?.kind,
      after[0]?.revisionCount,
    ]).toStrictEqual([1, "human_edit", 2]);
  });

  it("a split through the middle of a commented phrase keeps the thread on the first block, on the part of the phrase it kept", async () => {
    const s = await setup();
    const text = "The quick brown fox jumps over the lazy dog.";
    const blockId = await write(s, s.robert._id, s.happened, text);
    const threadId = await comment(s.dana, blockId, text, "brown fox jumps");

    await s.owner.mutation(api.blockOps.split, {
      baseRev: await revOf(s, blockId),
      blockId,
      headText: "The quick brown fox ",
      tailKind: "paragraph",
      tailText: "jumps over the lazy dog.",
    });

    const thread = await threadOf(s, threadId);
    expect([thread.blockId, thread.exact, thread.position]).toStrictEqual([
      blockId,
      "brown fox ",
      10,
    ]);
  });

  it("a comment on a short sentence after a long passage follows it into the new block", async () => {
    const s = await setup();
    const head = "We compared three venues on price and travel time. ".repeat(
      6
    );
    const text = `${head}Book the hall.`;
    const blockId = await write(s, s.robert._id, s.happened, text);
    const threadId = await comment(s.dana, blockId, text, "Book the hall");

    const { tailId } = await s.owner.mutation(api.blockOps.split, {
      baseRev: await revOf(s, blockId),
      blockId,
      headText: head,
      tailKind: "paragraph",
      tailText: "Book the hall.",
    });

    const thread = await threadOf(s, threadId);
    expect([
      thread.blockId,
      thread.position,
      thread.detachedBeforeChangeSetId,
    ]).toStrictEqual([tailId, 0, undefined]);
  });

  it("merging a block into the one above joins their text in one change set, deletes it and carries its comment along", async () => {
    const s = await setup();
    const previousId = await write(
      s,
      s.robert._id,
      s.happened,
      "Ship the beta on Friday. "
    );
    const previous = await blockOf(s, previousId);
    const blockId = await write(
      s,
      s.robert._id,
      previous,
      "Then gather feedback from the first ten teams."
    );
    const threadId = await comment(
      s.dana,
      blockId,
      "Then gather feedback from the first ten teams.",
      "first ten teams"
    );
    const before = await changeSets(s);

    const { rev } = await s.owner.mutation(api.blockOps.merge, {
      baseRev: await revOf(s, blockId),
      blockId,
      previousBaseRev: previous.rev,
    });

    await expect(texts(s)).resolves.toStrictEqual([
      "What's happened",
      "Ship the beta on Friday. Then gather feedback from the first ten teams.",
      "Ideas & notes",
      "Open questions",
    ]);
    await expect(revOf(s, previousId)).resolves.toBe(rev);
    const thread = await threadOf(s, threadId);
    expect([
      thread.blockId,
      thread.exact,
      thread.position,
      thread.detachedBeforeChangeSetId,
    ]).toStrictEqual([previousId, "first ten teams", 55, undefined]);
    const after = await changeSets(s);
    expect([
      after.length - before.length,
      after[0]?.kind,
      after[0]?.revisionCount,
    ]).toStrictEqual([1, "human_edit", 2]);
  });

  it("merging two code blocks joins them on a new line", async () => {
    const s = await setup();
    const previousId = await write(
      s,
      s.robert._id,
      s.happened,
      "const a = 1;",
      "code"
    );
    const previous = await blockOf(s, previousId);
    const blockId = await write(
      s,
      s.robert._id,
      previous,
      "const b = 2;",
      "code"
    );
    await s.owner.mutation(api.blockOps.merge, {
      baseRev: await revOf(s, blockId),
      blockId,
      previousBaseRev: previous.rev,
    });
    const { text } = await blockOf(s, previousId);
    expect(text).toBe("const a = 1;\nconst b = 2;");
  });

  it("a merge into a block the teammate holds is refused naming her, and one past 4,000 characters is refused, both leaving the blocks as they were", async () => {
    const s = await setup();
    const previousId = await write(
      s,
      s.robert._id,
      s.happened,
      "a".repeat(3000)
    );
    const previous = await blockOf(s, previousId);
    const blockId = await write(s, s.robert._id, previous, "b".repeat(1500));
    const merge = async () =>
      await s.owner.mutation(api.blockOps.merge, {
        baseRev: await revOf(s, blockId),
        blockId,
        previousBaseRev: previous.rev,
      });

    await s.dana.mutation(api.blocks.startEdit, { blockId: previousId });
    await expect(merge()).rejects.toThrow("Dana is editing this block");
    await s.dana.mutation(api.blocks.stopEdit, { blockId: previousId });
    await expect(merge()).rejects.toThrow(
      "A block holds at most 4000 characters; this one has 4500."
    );
    const after = await texts(s);
    expect(after.slice(1, 3)).toStrictEqual([
      "a".repeat(3000),
      "b".repeat(1500),
    ]);
  });

  it("changing a model's paragraph into code stores the new text as one revision and marks the block as edited by a person", async () => {
    const s = await setup();
    const blockId = await write(s, s.claude._id, s.happened, "`x = 1`");
    const editedAt = Date.now();

    const { rev } = await s.owner.mutation(api.blockOps.setKind, {
      baseRev: await revOf(s, blockId),
      blockId,
      kind: "code",
      text: "x = 1",
    });

    const block = await blockOf(s, blockId);
    expect([block.kind, block.text, block.rev, block.author]).toStrictEqual([
      "code",
      "x = 1",
      rev,
      { kind: "participant", participantId: s.claude._id },
    ]);
    expect(block.humanEditedAt).toStrictEqual(closeTo(editedAt, -2));
    const [latest] = await changeSets(s);
    const diff = await s.owner.query(api.history.diff, {
      changeSetId: defined(latest)._id,
    });
    expect(
      diff.map((r) => [r.op, r.before?.kind, r.after?.kind, r.after?.text])
    ).toStrictEqual([["update", "paragraph", "code", "x = 1"]]);
  });

  it("changing a ticked to-do into a paragraph drops the tick", async () => {
    const s = await setup();
    const blockId = await write(
      s,
      s.claude._id,
      s.happened,
      "Call Ana",
      "todo"
    );
    await s.owner.mutation(api.blockOps.toggleChecked, {
      baseRev: await revOf(s, blockId),
      blockId,
      checked: true,
    });

    await s.owner.mutation(api.blockOps.setKind, {
      baseRev: await revOf(s, blockId),
      blockId,
      kind: "paragraph",
      text: "Call Ana",
    });

    const block = await blockOf(s, blockId);
    expect([block.kind, block.checked]).toStrictEqual(["paragraph", undefined]);
  });

  it("ticking a model's to-do needs no lease, records an update and marks the block as edited by a person; a stale tick is refused with the block's checked state", async () => {
    const s = await setup();
    const blockId = await write(
      s,
      s.claude._id,
      s.happened,
      "Book the venue",
      "todo"
    );
    const baseRev = await revOf(s, blockId);
    const tickedAt = Date.now();

    const { rev } = await s.owner.mutation(api.blockOps.toggleChecked, {
      baseRev,
      blockId,
      checked: true,
    });

    const block = await blockOf(s, blockId);
    expect([
      block.checked,
      block.rev,
      block.humanEditedAt,
      block.leaseHolderParticipantId,
    ]).toStrictEqual([true, rev, closeTo(tickedAt, -2), undefined]);
    const [latest] = await changeSets(s);
    const diff = await s.owner.query(api.history.diff, {
      changeSetId: defined(latest)._id,
    });
    expect(
      diff.map((r) => [r.op, r.before?.checked, r.after?.checked])
    ).toStrictEqual([["update", undefined, true]]);

    await expect(
      refusalOf(
        s.dana.mutation(api.blockOps.toggleChecked, {
          baseRev,
          blockId,
          checked: false,
        })
      )
    ).resolves.toStrictEqual({
      checked: true,
      message: STALE,
      rev,
      text: "Book the venue",
    });
  });

  it("a to-do the teammate is editing cannot be ticked", async () => {
    const s = await setup();
    const blockId = await write(
      s,
      s.robert._id,
      s.happened,
      "Book the venue",
      "todo"
    );
    await s.dana.mutation(api.blocks.startEdit, { blockId });
    await expect(
      s.owner.mutation(api.blockOps.toggleChecked, {
        baseRev: await revOf(s, blockId),
        blockId,
        checked: true,
      })
    ).rejects.toThrow("Dana is editing this block");
    const { checked } = await blockOf(s, blockId);
    expect(checked).toBeUndefined();
  });

  it("moves a block to the top and after another block, but not a block the teammate holds", async () => {
    const s = await setup();
    await s.owner.mutation(api.blockOps.moveTo, {
      afterBlockId: null,
      baseRev: s.questions.rev,
      blockId: s.questions._id,
    });
    await expect(texts(s)).resolves.toStrictEqual([
      "Open questions",
      "What's happened",
      "Ideas & notes",
    ]);
    await s.owner.mutation(api.blockOps.moveTo, {
      afterBlockId: s.ideas._id,
      baseRev: s.happened.rev,
      blockId: s.happened._id,
    });
    await expect(texts(s)).resolves.toStrictEqual([
      "Open questions",
      "Ideas & notes",
      "What's happened",
    ]);

    await s.dana.mutation(api.blocks.startEdit, { blockId: s.ideas._id });
    await expect(
      s.owner.mutation(api.blockOps.moveTo, {
        afterBlockId: null,
        baseRev: s.ideas.rev,
        blockId: s.ideas._id,
      })
    ).rejects.toThrow("Dana is editing this block");
  });

  it("inserting three blocks is refused whole at 598 blocks, naming the count, and at 596 adds all three with the lease on the last", async () => {
    const s = await setup();
    const fill = async (count: number) => {
      await s.t.run(async (ctx) => {
        const rows = await ctx.db.query("blocks").collect();
        for (let i = rows.length; i < count; i += 1) {
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
    };
    const insert = async () =>
      await s.owner.mutation(api.blockOps.insertMany, {
        afterBlockId: s.happened._id,
        blocks: [
          { kind: "paragraph", text: "One" },
          { kind: "todo", text: "Two" },
          { kind: "paragraph", text: "Three" },
        ],
        roomId: s.roomId,
      });

    await fill(598);
    await expect(insert()).rejects.toThrow(
      "This would add 3 blocks to a document of 598, and a document holds at most 600 blocks."
    );
    await expect(blocksOf(s)).resolves.toHaveLength(598);

    await s.t.run(async (ctx) => {
      const fillers = await ctx.db
        .query("blocks")
        .filter((q) => q.eq(q.field("text"), "filler"))
        .take(2);
      await Promise.all(
        fillers.map(async (b) => {
          await ctx.db.delete(b._id);
        })
      );
    });
    const inserted = await insert();
    const after = await texts(s);
    expect(after.slice(0, 5)).toStrictEqual([
      "What's happened",
      "One",
      "Two",
      "Three",
      "Ideas & notes",
    ]);
    const last = await blockOf(s, defined(inserted.blocks[2]).blockId);
    expect([last.text, last.rev, last.leaseHolderParticipantId]).toStrictEqual([
      "Three",
      defined(inserted.blocks[2]).rev,
      s.robert._id,
    ]);
  });

  it("pasting blocks inside a block keeps the head there, ends the last pasted block with the old tail and its comment, in one change set; a stale paste changes nothing", async () => {
    const s = await setup();
    const text = "Agenda: budget, then hiring plans.";
    const blockId = await write(s, s.robert._id, s.happened, text);
    const threadId = await comment(s.dana, blockId, text, "hiring plans");
    const baseRev = await revOf(s, blockId);
    const before = await changeSets(s);
    const paste = async (rev: number) =>
      await s.owner.mutation(api.blockOps.insertMany, {
        afterBlockId: blockId,
        blocks: [
          { kind: "listItem", text: "Budget review" },
          { kind: "listItem", text: "Roadmap, then " },
        ],
        roomId: s.roomId,
        source: {
          baseRev: rev,
          headText: "Agenda: budget, then ",
          tailText: "hiring plans.",
        },
      });

    await expect(refusalOf(paste(baseRev - 1))).resolves.toStrictEqual({
      message: STALE,
      rev: baseRev,
      text,
    });
    await expect(changeSets(s)).resolves.toHaveLength(before.length);

    const pasted = await paste(baseRev);
    await expect(texts(s)).resolves.toStrictEqual([
      "What's happened",
      "Agenda: budget, then ",
      "Budget review",
      "Roadmap, then hiring plans.",
      "Ideas & notes",
      "Open questions",
    ]);
    const sourceRev = await revOf(s, blockId);
    const thread = await threadOf(s, threadId);
    expect([
      sourceRev,
      thread.blockId,
      thread.exact,
      thread.position,
    ]).toStrictEqual([
      pasted.rev,
      defined(pasted.blocks[1]).blockId,
      "hiring plans",
      14,
    ]);
    const after = await changeSets(s);
    expect([
      after.length - before.length,
      after[0]?.kind,
      after[0]?.revisionCount,
    ]).toStrictEqual([1, "human_edit", 3]);
  });

  it("every structural edit based on an old rev is refused with the block's current text", async () => {
    const s = await setup();
    const blockId = await write(s, s.robert._id, s.happened, "Plan");
    const stale = (await revOf(s, blockId)) - 1;
    const previous = await blockOf(s, s.happened._id);
    const calls = [
      async () =>
        await s.owner.mutation(api.blockOps.split, {
          baseRev: stale,
          blockId,
          headText: "Pl",
          tailKind: "paragraph",
          tailText: "an",
        }),
      async () =>
        await s.owner.mutation(api.blockOps.merge, {
          baseRev: stale,
          blockId,
          previousBaseRev: previous.rev,
        }),
      async () =>
        await s.owner.mutation(api.blockOps.setKind, {
          baseRev: stale,
          blockId,
          kind: "quote",
          text: "Plan",
        }),
      async () =>
        await s.owner.mutation(api.blockOps.toggleChecked, {
          baseRev: stale,
          blockId,
          checked: true,
        }),
      async () =>
        await s.owner.mutation(api.blockOps.moveTo, {
          afterBlockId: null,
          baseRev: stale,
          blockId,
        }),
    ];
    for (const call of calls) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each refusal is checked against the unchanged block
      await expect(refusalOf(call())).resolves.toMatchObject({
        message: STALE,
        text: "Plan",
      });
    }
    await expect(texts(s)).resolves.toStrictEqual([
      "What's happened",
      "Plan",
      "Ideas & notes",
      "Open questions",
    ]);
  });
});
