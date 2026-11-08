import { register as registerWorkflow } from "@convex-dev/workflow/test";
/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import type { TestConvex } from "convex-test";
import { beforeEach, afterEach, expect, vi, it, describe } from "vitest";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import {
  deleteBlock,
  insertBlock,
  liveBlocks,
  openChangeSet,
  orderBetween,
  patchBlock,
  takeCheckpoint,
  versionAt,
} from "../convex/lib/document";
import schema from "../convex/schema";
import { closeTo, defined } from "./support";
import type { Caller } from "./support";

const modules = import.meta.glob("../convex/**/*.ts");

const DAY = 24 * 60 * 60 * 1000;
const FIRST_PAGE = { cursor: null, numItems: 50 };
// Each transaction runs at its own commit time, which can be a few ticks ahead of the frozen test clock.
const about = (ms: number) => closeTo(ms, -2);

type Test = TestConvex<typeof schema>;

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

// The live blocks as a version reports them.
const current = async (t: Test, documentId: Id<"documents">) =>
  await t.run(async (ctx) => {
    const blocks = await liveBlocks(ctx, documentId);
    return blocks.map((b) => ({
      author: b.author,
      blockId: b._id,
      kind: b.kind,
      order: b.order,
      text: b.text,
    }));
  });

const latestChangeSet = async (owner: Caller, roomId: Id<"rooms">) => {
  const { page } = (await owner.query(api.history.list, {
    paginationOpts: { cursor: null, numItems: 1 },
    roomId,
  })) as { page: { _id: Id<"changeSets"> }[] };
  return defined(page[0])._id;
};

// `count` revisions by a model in one change set: mostly text updates, with
// regular inserts, moves and deletes, so a rebuild has every kind to replay.
const churn = async (
  t: Test,
  documentId: Id<"documents">,
  claudeId: Id<"participants">,
  count: number,
  label: string
) => {
  await t.run(async (ctx) => {
    const changeSetId = await openChangeSet(ctx, documentId, {
      actorParticipantId: claudeId,
      kind: "model_turn",
    });
    for (let i = 0; i < count; i += 1) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
      const blocks = await liveBlocks(ctx, documentId);
      const target = defined(blocks[i % blocks.length]);
      if (i % 5 === 0 || blocks.length < 4) {
        const next = blocks[(i % blocks.length) + 1]?.order ?? null;
        // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
        await insertBlock(ctx, changeSetId, {
          author: { kind: "participant", participantId: claudeId },
          kind: "paragraph",
          order: orderBetween(target.order, next),
          text: `${label} added ${i}`,
        });
      } else if (i % 11 === 0) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
        await deleteBlock(ctx, changeSetId, target._id);
      } else if (i % 7 === 0) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
        await patchBlock(ctx, changeSetId, target._id, {
          order: orderBetween(null, defined(blocks[0]).order),
        });
      } else {
        // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
        await patchBlock(ctx, changeSetId, target._id, {
          text: `${label} text ${i}`,
        });
      }
    }
  });
};

// Orders [blockId, op] pairs by block id.
const byBlock = (a: string[], b: string[]) =>
  (a[0] ?? "").localeCompare(b[0] ?? "");

describe("document history", () => {
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

  it("history lists change sets newest first, page by page, with actor, kind and time", async () => {
    const { owner, dana, roomId, robert, danaParticipant, ideas, questions } =
      await setup();
    const seededAt = Date.now();
    vi.advanceTimersByTime(1000);
    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
    await dana.mutation(api.blocks.save, { blockId: ideas._id, text: "Ideas" });
    vi.advanceTimersByTime(1000);
    await owner.mutation(api.blocks.remove, { blockId: questions._id });

    const first = await owner.query(api.history.list, {
      paginationOpts: { cursor: null, numItems: 2 },
      roomId,
    });
    expect({
      isDone: first.isDone,
      page: first.page.map((c) => [c.kind, c.actorParticipantId, c.at]),
    }).toStrictEqual({
      isDone: false,
      page: [
        ["human_edit", robert._id, about(seededAt + 2000)],
        ["human_edit", danaParticipant._id, about(seededAt + 1000)],
      ],
    });
    const second = await dana.query(api.history.list, {
      paginationOpts: { cursor: first.continueCursor, numItems: 2 },
      roomId,
    });
    expect(
      second.page.map((c) => [c.kind, c.actorParticipantId, c.at])
    ).toStrictEqual([["template_seed", robert._id, about(seededAt)]]);
  });

  it("a change set's diff lists its revisions in order with the text before and after", async () => {
    const { owner, roomId, ideas } = await setup();
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
    await owner.mutation(api.blocks.save, {
      blockId: ideas._id,
      text: "Ideas",
    });
    await owner.mutation(api.blocks.save, {
      blockId: ideas._id,
      text: "Ideas!",
    });
    const diff = await owner.query(api.history.diff, {
      changeSetId: await latestChangeSet(owner, roomId),
    });
    expect(
      diff.map((r) => [r.blockId, r.op, r.before?.text, r.after?.text])
    ).toStrictEqual([
      [ideas._id, "update", "Ideas & notes", "Ideas"],
      [ideas._id, "update", "Ideas", "Ideas!"],
    ]);
  });

  it("a version 450 revisions back, past two checkpoints, is rebuilt exactly as the document was then", async () => {
    const { t, owner, roomId, claude, documentId } = await setup();
    const seedId = await latestChangeSet(owner, roomId);
    const seeded = await current(t, documentId);

    // Revisions 4 to 250; the first checkpoint is taken at 200.
    await churn(t, documentId, claude._id, 147, "early");
    await churn(t, documentId, claude._id, 100, "middle");
    const chosen = await latestChangeSet(owner, roomId);
    const then = await current(t, documentId);

    // Revisions 251 to 700, with checkpoints at 400 and 600.
    await churn(t, documentId, claude._id, 150, "later");
    await churn(t, documentId, claude._id, 300, "latest");
    await t.run(async (ctx) => {
      expect(defined(await ctx.db.get(documentId)).rev).toBe(700);
      const awaited6 = await ctx.db.query("documentCheckpoints").collect();
      expect(awaited6.map((c) => c.rev)).toStrictEqual([200, 400, 600]);
    });
    await expect(current(t, documentId)).resolves.not.toStrictEqual(then);

    const version = await owner.query(api.history.version, {
      changeSetId: chosen,
    });
    expect(version.rev).toBe(250);
    expect(version.blocks).toStrictEqual(then);
    const awaited5 = await owner.query(api.history.version, {
      changeSetId: seedId,
    });
    expect(awaited5.blocks).toStrictEqual(seeded);
    const awaited4 = await owner.query(api.history.version, {
      changeSetId: await latestChangeSet(owner, roomId),
    });
    expect(awaited4.blocks).toStrictEqual(await current(t, documentId));
  });

  it("Robert restores yesterday's version: today's state is saved first, block ids are kept, and history shows one restore by Robert", async () => {
    const {
      t,
      owner,
      dana,
      roomId,
      robert,
      danaParticipant,
      documentId,
      happened,
      ideas,
      questions,
    } = await setup();
    const plan = await owner.mutation(api.blocks.add, {
      endOfSectionId: happened._id,
      kind: "paragraph",
      roomId,
      text: "Yesterday's plan",
    });
    await owner.mutation(api.blocks.stopEdit, { blockId: plan });
    const note = await dana.mutation(api.blocks.add, {
      endOfSectionId: ideas._id,
      kind: "listItem",
      roomId,
      text: "Dana's note",
    });
    await dana.mutation(api.blocks.stopEdit, { blockId: note });
    const yesterdayId = await latestChangeSet(owner, roomId);
    const yesterday = await current(t, documentId);

    vi.advanceTimersByTime(DAY);
    await dana.mutation(api.blocks.startEdit, { blockId: plan });
    await dana.mutation(api.blocks.save, {
      blockId: plan,
      text: "Today's plan",
    });
    await dana.mutation(api.blocks.stopEdit, { blockId: plan });
    await owner.mutation(api.blocks.remove, { blockId: note });
    const added = await owner.mutation(api.blocks.add, {
      endOfSectionId: questions._id,
      kind: "paragraph",
      roomId,
      text: "Added today",
    });
    await owner.mutation(api.blocks.stopEdit, { blockId: added });
    await dana.mutation(api.blocks.move, {
      blockId: questions._id,
      direction: "up",
    });
    const todayId = await latestChangeSet(owner, roomId);
    const today = await current(t, documentId);

    const restoredAt = Date.now();
    await owner.mutation(api.history.restore, { changeSetId: yesterdayId });

    const { blocks } = defined(
      await owner.query(api.documents.get, { roomId })
    );
    expect({
      // A re-created block keeps its author.
      author: defined(blocks.find((b) => b._id === note)).author,
      current: await current(t, documentId),
      ids: blocks.map((b) => b._id),
    }).toStrictEqual({
      author: { kind: "participant", participantId: danaParticipant._id },
      current: yesterday,
      ids: [happened._id, plan, ideas._id, note, questions._id],
    });

    // Today's state was saved as a checkpoint first, and its version still rebuilds.
    await t.run(async (ctx) => {
      const checkpoints = await ctx.db.query("documentCheckpoints").collect();
      expect(checkpoints.map((c) => [c.reason, c.blockCount])).toStrictEqual([
        ["before_restore", today.length],
      ]);
      const rows = await ctx.db
        .query("checkpointBlocks")
        .withIndex("by_checkpoint", (q) =>
          q.eq("checkpointId", defined(checkpoints[0])._id)
        )
        .collect();
      rows.sort((a, b) => (a.order < b.order ? -1 : 1));
      expect(
        rows.map((r) => ({
          author: r.author,
          blockId: r.blockId,
          kind: r.kind,
          order: r.order,
          text: r.text,
        }))
      ).toStrictEqual(today);
    });
    const awaited3 = await owner.query(api.history.version, {
      changeSetId: todayId,
    });
    expect(awaited3.blocks).toStrictEqual(today);

    const awaited2 = await owner.query(api.history.list, {
      paginationOpts: FIRST_PAGE,
      roomId,
    });
    const history = awaited2.page;
    const [restore] = history;
    expect({
      first: [
        defined(restore).kind,
        defined(restore).actorParticipantId,
        defined(restore).at,
      ],
      restores: history.filter((c) => c.kind === "restore").length,
    }).toStrictEqual({
      first: ["restore", robert._id, about(restoredAt)],
      restores: 1,
    });
    const diff = await owner.query(api.history.diff, {
      changeSetId: defined(restore)._id,
    });
    expect(
      diff.map((r): string[] => [r.blockId, r.op]).toSorted(byBlock)
    ).toStrictEqual(
      [
        [added, "delete"],
        [note, "insert"],
        [plan, "update"],
        [questions._id, "move"],
      ].toSorted(byBlock)
    );

    await t.run(async (ctx) => {
      const ledger = await ctx.db.query("ledger").collect();
      const restored = ledger.filter((e) => e.type === "document.restored");
      expect({
        leaksText: JSON.stringify(ledger).includes("Yesterday's plan"),
        restored: restored.map((e): unknown[] => [
          e.actorParticipantId,
          e.subjectId,
          e.payload,
        ]),
      }).toStrictEqual({
        leaksText: false,
        restored: [
          [
            robert._id,
            defined(restore)._id,
            {
              changeSetId: defined(restore)._id,
              documentId,
              restoredChangeSetId: yesterdayId,
            },
          ],
        ],
      });
    });
  });

  it("restoring a version sets the human-edited mark on a model's block whose text it changes", async () => {
    const { t, owner, roomId, claude, documentId, happened } = await setup();
    const blockId = await t.run(async (ctx) => {
      const changeSetId = await openChangeSet(ctx, documentId, {
        actorParticipantId: claude._id,
        kind: "model_turn",
      });
      return await insertBlock(ctx, changeSetId, {
        author: { kind: "participant", participantId: claude._id },
        kind: "paragraph",
        order: orderBetween(happened.order, null),
        text: "First finding",
      });
    });
    const firstId = await latestChangeSet(owner, roomId);
    await t.run(async (ctx) => {
      const changeSetId = await openChangeSet(ctx, documentId, {
        actorParticipantId: claude._id,
        kind: "model_turn",
      });
      await patchBlock(ctx, changeSetId, blockId, { text: "Revised finding" });
    });

    const restoredAt = Date.now();
    await owner.mutation(api.history.restore, { changeSetId: firstId });
    const block = defined(
      defined(
        await owner.query(api.documents.get, {
          roomId,
        })
      ).blocks.find((b) => b._id === blockId)
    );
    expect([block.text, block.author, block.humanEditedAt]).toStrictEqual([
      "First finding",
      { kind: "participant", participantId: claude._id },
      about(restoredAt),
    ]);
  });

  it("ticking a to-do is recorded as an update, survives a checkpoint, and restoring the version before unticks it", async () => {
    const { t, owner, roomId, claude, documentId, happened } = await setup();
    const todoId = await t.run(async (ctx) => {
      const changeSetId = await openChangeSet(ctx, documentId, {
        actorParticipantId: claude._id,
        kind: "model_turn",
      });
      return await insertBlock(ctx, changeSetId, {
        author: { kind: "participant", participantId: claude._id },
        kind: "todo",
        order: orderBetween(happened.order, null),
        text: "Ship it",
      });
    });
    const beforeTick = await latestChangeSet(owner, roomId);
    await t.run(async (ctx) => {
      const changeSetId = await openChangeSet(ctx, documentId, {
        actorParticipantId: claude._id,
        kind: "model_turn",
      });
      await patchBlock(ctx, changeSetId, todoId, { checked: true });
      await takeCheckpoint(ctx, documentId, "interval");
    });
    const tickId = await latestChangeSet(owner, roomId);

    const diff = await owner.query(api.history.diff, { changeSetId: tickId });
    expect(
      diff.map((r) => [r.op, r.before?.checked, r.after?.checked])
    ).toStrictEqual([["update", undefined, true]]);
    // Rebuilt from the checkpoint taken after the tick.
    const ticked = await t.run(async (ctx) => {
      const document = defined(await ctx.db.get(documentId));
      const blocks = await versionAt(ctx, documentId, document.rev);
      return blocks.find((b) => b.blockId === todoId)?.checked;
    });
    expect(ticked).toBeTruthy();

    await owner.mutation(api.history.restore, { changeSetId: beforeTick });
    const restored = defined(
      defined(await owner.query(api.documents.get, { roomId })).blocks.find(
        (b) => b._id === todoId
      )
    );
    expect([restored.kind, restored.checked]).toStrictEqual([
      "todo",
      undefined,
    ]);
  });

  it("restore is refused while anyone has typed under an edit lease, naming them, and while the scribe is working", async () => {
    const { t, owner, dana, roomId, claude, documentId, ideas } = await setup();
    const seedId = await latestChangeSet(owner, roomId);
    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
    await dana.mutation(api.blocks.save, { blockId: ideas._id, text: "Ideas" });
    await expect(
      owner.mutation(api.history.restore, { changeSetId: seedId })
    ).rejects.toThrow("Dana is editing a block");
    await dana.mutation(api.blocks.stopEdit, { blockId: ideas._id });

    await t.run(async (ctx) => {
      const scribeRunId = await ctx.db.insert("scribeRuns", {
        documentId,
        participantId: claude._id,
        roomId,
        startedAt: Date.now(),
        startedByParticipantId: claude._id,
        status: "running",
      });
      await ctx.db.patch(documentId, {
        scribeLockExpiresAt: Date.now() + 60_000,
        scribeRunId,
      });
    });
    await expect(
      dana.mutation(api.history.restore, { changeSetId: seedId })
    ).rejects.toThrow("The scribe is working on the document");

    await t.run(async (ctx) => {
      await expect(
        ctx.db.query("documentCheckpoints").collect()
      ).resolves.toStrictEqual([]);
      const awaited = await ctx.db.query("changeSets").collect();
      expect(awaited.filter((c) => c.kind === "restore")).toStrictEqual([]);
    });
    expect(
      defined(await owner.query(api.documents.get, { roomId })).blocks.map(
        (b) => b.text
      )
    ).toContain("Ideas");
  });

  it("a lease nobody has typed under does not block a restore", async () => {
    const { owner, dana, roomId, ideas } = await setup();
    const seedId = await latestChangeSet(owner, roomId);
    await owner.mutation(api.blocks.startEdit, { blockId: ideas._id });
    await owner.mutation(api.blocks.save, {
      blockId: ideas._id,
      text: "Ideas",
    });
    await owner.mutation(api.blocks.stopEdit, { blockId: ideas._id });
    await dana.mutation(api.blocks.startEdit, { blockId: ideas._id });
    await owner.mutation(api.history.restore, { changeSetId: seedId });
    expect(
      defined(await owner.query(api.documents.get, { roomId })).blocks.map(
        (b) => b.text
      )
    ).toStrictEqual(["What's happened", "Ideas & notes", "Open questions"]);
  });

  it("someone outside the room cannot read its history", async () => {
    const { t, owner, roomId } = await setup();
    const eve = t.withIdentity({
      email: "eve@example.com",
      name: "Eve",
      subject: "eve",
    });
    const changeSetId = await latestChangeSet(owner, roomId);
    await expect(
      eve.query(api.history.list, { paginationOpts: FIRST_PAGE, roomId })
    ).rejects.toThrow("Not a member of this room");
    await expect(
      eve.query(api.history.version, { changeSetId })
    ).rejects.toThrow("Not a member of this room");
    await expect(eve.query(api.history.diff, { changeSetId })).rejects.toThrow(
      "Not a member of this room"
    );
    await expect(
      eve.mutation(api.history.restore, { changeSetId })
    ).rejects.toThrow("Not a member of this room");
  });
});
