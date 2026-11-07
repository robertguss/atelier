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
  openChangeSet,
  orderBetween,
  patchBlock,
} from "../convex/lib/document";
import schema from "../convex/schema";
import { defined } from "./support";

const modules = import.meta.glob("../convex/**/*.ts");

const DEFAULT_HEADINGS = ["What's happened", "Ideas & notes", "Open questions"];

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
  const eve = t.withIdentity({
    email: "eve@example.com",
    name: "Eve",
    subject: "eve",
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
  return { claude, dana, danaParticipant, eve, owner, robert, roomId, t };
};

// Removes a room's document and its history, as for a room created before documents existed.
const dropDocument = async (t: TestConvex<typeof schema>) => {
  await t.run(async (ctx) => {
    await Promise.all(
      (["blockRevisions", "blocks", "changeSets", "documents"] as const).map(
        async (table) => {
          const rows = await ctx.db.query(table).collect();
          await Promise.all(
            rows.map(async (row) => {
              await ctx.db.delete(row._id);
            })
          );
        }
      )
    );
    const ledger = await ctx.db.query("ledger").collect();
    await Promise.all(
      ledger
        .filter((e) => e.type === "document.changed")
        .map(async (row) => {
          await ctx.db.delete(row._id);
        })
    );
  });
};

describe("room document", () => {
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

  it("creating a room with no template seeds the three default headings, attributed to Robert, in one template seeding change set", async () => {
    const { t, owner, roomId, robert } = await setup();
    const doc = defined(await owner.query(api.documents.get, { roomId }));
    expect(doc.blocks.map((b) => [b.kind, b.text, b.author])).toStrictEqual(
      DEFAULT_HEADINGS.map((text) => [
        "heading",
        text,
        { kind: "participant", participantId: robert._id },
      ])
    );
    expect(doc.rev).toBe(3);

    await t.run(async (ctx) => {
      const changeSets = await ctx.db.query("changeSets").collect();
      expect(
        changeSets.map((c) => [c.kind, c.actorParticipantId, c.revisionCount])
      ).toStrictEqual([["template_seed", robert._id, 3]]);
      const revisions = await ctx.db.query("blockRevisions").collect();
      expect(
        revisions.map((r) => [r.op, r.changeSetId, r.rev, r.after?.text])
      ).toStrictEqual(
        DEFAULT_HEADINGS.map((text, i) => [
          "insert",
          defined(changeSets[0])._id,
          i + 1,
          text,
        ])
      );
      const awaited5 = await ctx.db.query("documents").collect();
      const document = defined(awaited5[0]);
      expect(document.roomId).toBe(roomId);
      expect(document.templateId).toBeUndefined();
    });
  });

  it("the seeding ledger row carries ids and no block text", async () => {
    const { t, roomId, robert } = await setup();
    await t.run(async (ctx) => {
      const ledger = await ctx.db.query("ledger").collect();
      const changed = ledger.filter((e) => e.type === "document.changed");
      const awaited4 = await ctx.db.query("changeSets").collect();
      const changeSet = defined(awaited4[0]);
      const awaited3 = await ctx.db.query("documents").collect();
      const document = defined(awaited3[0]);
      expect(
        changed.map((e): unknown[] => [
          e.roomId,
          e.actorParticipantId,
          e.subjectId,
          e.payload,
        ])
      ).toStrictEqual([
        [
          roomId,
          robert._id,
          changeSet._id,
          {
            changeSetId: changeSet._id,
            documentId: document._id,
            kind: "template_seed",
          },
        ],
      ]);
      for (const heading of DEFAULT_HEADINGS) {
        expect(JSON.stringify(ledger)).not.toContain(heading);
      }
    });
  });

  it("documents.ensure seeds the default once for an older room with no document, and a second call changes nothing", async () => {
    const { t, owner, dana, roomId, robert } = await setup();
    await dropDocument(t);
    await expect(
      owner.query(api.documents.get, { roomId })
    ).resolves.toBeNull();

    // The teammate opens the room first; the seeded headings are still Robert's.
    const documentId = await dana.mutation(api.documents.ensure, { roomId });
    const doc = defined(await dana.query(api.documents.get, { roomId }));
    expect(doc.documentId).toBe(documentId);
    expect(doc.blocks.map((b) => [b.text, b.author])).toStrictEqual(
      DEFAULT_HEADINGS.map((text) => [
        text,
        { kind: "participant", participantId: robert._id },
      ])
    );

    await expect(
      owner.mutation(api.documents.ensure, { roomId })
    ).resolves.toBe(documentId);
    await expect(
      owner.query(api.documents.get, { roomId })
    ).resolves.toStrictEqual(doc);
    await t.run(async (ctx) => {
      await expect(ctx.db.query("documents").collect()).resolves.toHaveLength(
        1
      );
      await expect(ctx.db.query("changeSets").collect()).resolves.toHaveLength(
        1
      );
      await expect(
        ctx.db.query("blockRevisions").collect()
      ).resolves.toHaveLength(3);
      const awaited2 = await ctx.db.query("ledger").collect();
      expect(
        awaited2.filter((e) => e.type === "document.changed")
      ).toHaveLength(1);
    });
  });

  it("both members read the document, while a non-member and a removed member are refused", async () => {
    const { owner, dana, eve, roomId } = await setup();
    const forOwner = await owner.query(api.documents.get, { roomId });
    await expect(
      dana.query(api.documents.get, { roomId })
    ).resolves.toStrictEqual(forOwner);
    await expect(eve.query(api.documents.get, { roomId })).rejects.toThrow(
      "Not a member of this room"
    );
    await expect(
      eve.mutation(api.documents.ensure, { roomId })
    ).rejects.toThrow("Not a member of this room");

    const { members } = await owner.query(api.members.list, { roomId });
    await owner.mutation(api.members.remove, {
      memberId: defined(members.find((m) => m.role === "member"))._id,
    });
    await expect(dana.query(api.documents.get, { roomId })).rejects.toThrow(
      "no longer a member"
    );
    await expect(
      dana.mutation(api.documents.ensure, { roomId })
    ).rejects.toThrow("no longer a member");
  });

  it("documents.get shows each block's lease holder and its number of open threads", async () => {
    const { t, owner, roomId, danaParticipant } = await setup();
    const [first, second] = defined(
      await owner.query(api.documents.get, { roomId })
    ).blocks;
    await t.run(async (ctx) => {
      await ctx.db.patch(defined(first)._id, {
        leaseExpiresAt: Date.now() + 120_000,
        leaseHolderParticipantId: danaParticipant._id,
      });
      const awaited = await ctx.db.query("documents").collect();
      const document = defined(awaited[0]);
      const thread = {
        documentId: document._id,
        exact: "happened",
        position: 7,
        prefix: "What's ",
        roomId,
        suffix: "",
      };
      await ctx.db.insert("threads", {
        ...thread,
        blockId: defined(first)._id,
        state: "open",
      });
      await ctx.db.insert("threads", {
        ...thread,
        blockId: defined(first)._id,
        state: "open",
      });
      await ctx.db.insert("threads", {
        ...thread,
        blockId: defined(second)._id,
        state: "settled",
      });
    });
    const { blocks } = defined(
      await owner.query(api.documents.get, { roomId })
    );
    expect(
      blocks.map((b) => [b.leaseHolderParticipantId, b.openThreads])
    ).toStrictEqual([
      [danaParticipant._id, 2],
      [undefined, 0],
      [undefined, 0],
    ]);
  });

  it("the 200th revision takes a checkpoint that holds every live block, and none is taken before it", async () => {
    const { t, owner, roomId, danaParticipant } = await setup();
    const seeded = defined(await owner.query(api.documents.get, { roomId }));
    const { documentId } = seeded;
    const [first, second, third] = seeded.blocks;

    // Seeding wrote revisions 1 to 3. Revisions 4 and 5 add a paragraph and remove a heading.
    let paragraphId: Id<"blocks">;
    await t.run(async (ctx) => {
      const changeSetId = await openChangeSet(ctx, documentId, {
        actorParticipantId: danaParticipant._id,
        kind: "human_edit",
      });
      paragraphId = await insertBlock(ctx, changeSetId, {
        author: { kind: "participant", participantId: danaParticipant._id },
        kind: "paragraph",
        order: orderBetween(defined(first).order, defined(second).order),
        text: "draft 0",
      });
      await deleteBlock(ctx, changeSetId, defined(third)._id);
      for (let i = 1; i <= 194; i += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- revisions are numbered in the order they are written
        await patchBlock(ctx, changeSetId, paragraphId, { text: `draft ${i}` });
      }
    });
    await t.run(async (ctx) => {
      expect(defined(await ctx.db.get(documentId)).rev).toBe(199);
      await expect(
        ctx.db.query("documentCheckpoints").collect()
      ).resolves.toStrictEqual([]);
    });

    await t.run(async (ctx) => {
      const changeSetId = await openChangeSet(ctx, documentId, {
        actorParticipantId: danaParticipant._id,
        kind: "human_edit",
      });
      await patchBlock(ctx, changeSetId, paragraphId, { text: "final text" });
    });
    await t.run(async (ctx) => {
      const document = defined(await ctx.db.get(documentId));
      expect([document.rev, document.revisionsSinceCheckpoint]).toStrictEqual([
        200, 0,
      ]);
      const checkpoints = await ctx.db.query("documentCheckpoints").collect();
      expect(
        checkpoints.map((c) => [c.documentId, c.rev, c.reason, c.blockCount])
      ).toStrictEqual([[documentId, 200, "interval", 3]]);
      const rows = await ctx.db
        .query("checkpointBlocks")
        .withIndex("by_checkpoint", (q) =>
          q.eq("checkpointId", defined(checkpoints[0])._id)
        )
        .collect();
      rows.sort((a, b) => (a.order < b.order ? -1 : 1));
      expect(rows.map((r) => [r.blockId, r.kind, r.text])).toStrictEqual([
        [defined(first)._id, "heading", "What's happened"],
        [paragraphId, "paragraph", "final text"],
        [defined(second)._id, "heading", "Ideas & notes"],
      ]);
    });
    expect(
      defined(await owner.query(api.documents.get, { roomId })).blocks.map(
        (b) => b.text
      )
    ).toStrictEqual(["What's happened", "final text", "Ideas & notes"]);
  });
});
