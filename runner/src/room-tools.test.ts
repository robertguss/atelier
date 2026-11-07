import { describe, expect, it, vi } from "vitest";

import { FakeRoomConvex } from "./fake-room-convex.ts";
import type { FakeArgs } from "./fake-room-convex.ts";
import {
  callRoomTool,
  claudeRoomToolsServer,
  documentTools,
  listTools,
  scribeTools,
} from "./room-tools.ts";
import type { RoomToolResult, RoomToolsClient } from "./room-tools.ts";

// Records every query and mutation by name and answers from `replies`.
const fakeConvex = (
  replies: Record<string, (args: FakeArgs) => unknown> = {}
) => {
  const convex = new FakeRoomConvex(replies);
  const client: RoomToolsClient = convex;
  return { calls: convex.calls, client };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

// The value at `keys` inside parsed JSON, or undefined where the path breaks.
const at = (value: unknown, ...keys: string[]): unknown => {
  let current = value;
  for (const key of keys) {
    current = isRecord(current) ? current[key] : undefined;
  }
  return current;
};

const isHandler = (
  value: unknown
): value is (args: unknown, extra: unknown) => Promise<unknown> =>
  typeof value === "function";

const text = (result: { content: { text: string }[] }) =>
  result.content.map((c) => c.text).join("\n");

describe(callRoomTool, () => {
  it("read_document lists blocks with their ids, authors and revs, and the threads on them", async () => {
    const convex = fakeConvex({
      "documentTools:readDocumentForTurn": () => ({
        blocks: [
          {
            author: "Robert",
            humanEdited: false,
            id: "b-head",
            kind: "heading",
            rev: 1,
            text: "What's happened",
            yours: false,
          },
          {
            author: "Claude",
            humanEdited: true,
            id: "b-mine",
            kind: "paragraph",
            rev: 3,
            text: "We chose Postgres.\nMigrations next.",
            yours: true,
          },
        ],
        ok: true,
        rev: 12,
        threads: [
          {
            blockId: "b-mine",
            comments: 2,
            detached: false,
            id: "th-1",
            passage: "Postgres",
            state: "open",
          },
        ],
        writable: true,
      }),
    });
    const result = await callRoomTool(
      convex.client,
      "s3cret",
      "t1",
      "read_document",
      {}
    );
    expect(convex.calls).toStrictEqual([
      {
        args: { secret: "s3cret", turnId: "t1" },
        name: "documentTools:readDocumentForTurn",
      },
    ]);
    expect(result.isError).toBeUndefined();
    expect(text(result)).toBe(
      [
        "Room document at rev 12. You can add blocks, change and delete your own, and comment on any block.",
        "",
        "Blocks, in order:",
        "- block b-head | heading | by Robert | rev 1",
        "  What's happened",
        "- block b-mine | paragraph | by you | rev 3 | a person has edited it: keep their changes",
        "  We chose Postgres.",
        "  Migrations next.",
        "",
        "Comment threads:",
        "- thread th-1 | open | on block b-mine | 2 comments",
        '  "Postgres"',
      ].join("\n")
    );
  });

  it("read_thread shows the passage and every comment with its author", async () => {
    const convex = fakeConvex({
      "documentTools:readThreadForTurn": () => ({
        blockId: "b-mine",
        comments: [
          {
            at: Date.UTC(2026, 10, 7, 9, 30),
            author: "Robert",
            body: "Why not SQLite?",
          },
        ],
        detached: false,
        id: "th-1",
        ok: true,
        passage: "Postgres",
        state: "open",
      }),
    });
    const result = await callRoomTool(
      convex.client,
      "s3cret",
      "t1",
      "read_thread",
      { threadId: "th-1" }
    );
    expect(convex.calls[0]?.args).toStrictEqual({
      secret: "s3cret",
      threadId: "th-1",
      turnId: "t1",
    });
    expect(text(result)).toMatch(
      /^Thread th-1 \| open \| on block b-mine\nPassage: "Postgres"\n\nComments:\n- Robert, 2026-11-07T09:30:00.000Z:\n {2}Why not SQLite\?$/u
    );
  });

  it("each write tool sends its arguments with the secret and turn, and reports what happened", async () => {
    const convex = fakeConvex({
      "documentTools:addBlockForTurn": () => ({
        blockId: "b-new",
        ok: true,
        rev: 1,
      }),
      "documentTools:commentForTurn": () => ({
        commentId: "c-1",
        ok: true,
        threadId: "th-2",
      }),
      "documentTools:deleteBlockForTurn": () => ({ ok: true }),
      "documentTools:updateBlockForTurn": () => ({ ok: true, rev: 4 }),
    });
    const run = async (name: string, args: unknown) =>
      text(await callRoomTool(convex.client, "s3cret", "t1", name, args));

    await expect(
      run("add_block", {
        endOfSectionId: "b-head",
        kind: "listItem",
        text: "Ship Friday",
      })
    ).resolves.toBe(
      "Added block b-new at rev 1. Pass that rev as baseRev to change it later."
    );
    await expect(
      run("update_block", { baseRev: 1, blockId: "b-new", text: "Ship Monday" })
    ).resolves.toBe("Updated block b-new. It is now at rev 4.");
    await expect(
      run("delete_block", { baseRev: 4, blockId: "b-new" })
    ).resolves.toBe("Deleted block b-new.");
    await expect(
      run("comment", {
        blockId: "b-head",
        body: "Add the launch date?",
        quote: "happened",
      })
    ).resolves.toBe("Started comment thread th-2 on block b-head.");

    expect(convex.calls).toStrictEqual([
      {
        args: {
          endOfSectionId: "b-head",
          kind: "listItem",
          secret: "s3cret",
          text: "Ship Friday",
          turnId: "t1",
        },
        name: "documentTools:addBlockForTurn",
      },
      {
        args: {
          baseRev: 1,
          blockId: "b-new",
          secret: "s3cret",
          text: "Ship Monday",
          turnId: "t1",
        },
        name: "documentTools:updateBlockForTurn",
      },
      {
        args: { baseRev: 4, blockId: "b-new", secret: "s3cret", turnId: "t1" },
        name: "documentTools:deleteBlockForTurn",
      },
      {
        args: {
          blockId: "b-head",
          body: "Add the launch date?",
          quote: "happened",
          secret: "s3cret",
          turnId: "t1",
        },
        name: "documentTools:commentForTurn",
      },
    ]);
  });

  it("a refusal from Convex comes back as tool text with the current block, not as a throw", async () => {
    const convex = fakeConvex({
      "documentTools:updateBlockForTurn": () => ({
        current: { changedBy: "Robert", rev: 5, text: "Ship Monday, after QA" },
        message:
          "Robert changed this block after the version you sent (it is now rev 5).",
        ok: false,
        reason: "stale",
      }),
    });
    const result = await callRoomTool(
      convex.client,
      "s3cret",
      "t1",
      "update_block",
      { baseRev: 4, blockId: "b-1", text: "Ship Friday" }
    );
    expect(result.isError).toBeTruthy();
    expect(text(result)).toBe(
      [
        "Not done (stale): Robert changed this block after the version you sent (it is now rev 5).",
        "",
        "Current text, rev 5, last changed by Robert:",
        "Ship Monday, after QA",
      ].join("\n")
    );
  });

  it("a turnId in the arguments is ignored: the call acts as the turn it was made for", async () => {
    const convex = fakeConvex({
      "documentTools:deleteBlockForTurn": () => ({ ok: true }),
    });
    await callRoomTool(convex.client, "s3cret", "t1", "delete_block", {
      baseRev: 2,
      blockId: "b-1",
      secret: "forged",
      turnId: "t-other",
    });
    expect(convex.calls[0]?.args).toStrictEqual({
      baseRev: 2,
      blockId: "b-1",
      secret: "s3cret",
      turnId: "t1",
    });
  });

  it("bad arguments and unknown tools are explained to the model without calling Convex", async () => {
    const convex = fakeConvex();
    const missing = await callRoomTool(
      convex.client,
      "s3cret",
      "t1",
      "update_block",
      { blockId: "b-1", text: "x" }
    );
    expect(missing.isError).toBeTruthy();
    expect(text(missing)).toMatch(
      /^Those arguments don't fit update_block: .*baseRev/su
    );
    const unknown = await callRoomTool(
      convex.client,
      "s3cret",
      "t1",
      "settle_thread",
      {}
    );
    expect(text(unknown)).toBe(
      "There is no tool named settle_thread. The tools are read_document, read_thread, add_block, update_block, delete_block, comment."
    );
    expect(convex.calls).toHaveLength(0);
  });

  it("a Convex error becomes tool text and does not reach the model as a crash", async () => {
    const convex = fakeConvex({
      "documentTools:readDocumentForTurn": () => {
        throw new Error("connection lost");
      },
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      // The failure is logged for the runner's operator; the test checks what the model reads.
    });
    try {
      const result = await callRoomTool(
        convex.client,
        "s3cret",
        "t1",
        "read_document",
        {}
      );
      expect(result.isError).toBeTruthy();
      expect(text(result)).toBe(
        "read_document failed before reaching the document. Try again, or carry on without it."
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("the tool list gives every document tool a JSON schema for its arguments", () => {
    const tools = listTools();
    expect(tools.map((t) => t.name)).toStrictEqual([
      "read_document",
      "read_thread",
      "add_block",
      "update_block",
      "delete_block",
      "comment",
    ]);
    const update = tools.find((t) => t.name === "update_block");
    const add = tools.find((t) => t.name === "add_block");
    const kind = isRecord(add?.inputSchema.properties)
      ? at(add.inputSchema.properties.kind, "enum")
      : undefined;
    expect({
      kind,
      required: update?.inputSchema.required,
      schemaKey: update !== undefined && "$schema" in update.inputSchema,
      type: update?.inputSchema.type,
    }).toStrictEqual({
      kind: ["heading", "paragraph", "listItem"],
      required: ["baseRev", "blockId", "text"],
      schemaKey: false,
      type: "object",
    });
  });

  it("Claude's in-process server is named atelier, always loads, and forwards each tool by name", async () => {
    const forwarded: [string, unknown][] = [];
    const server = claudeRoomToolsServer(async (name, args) => {
      forwarded.push([name, args]);
      return await Promise.resolve<RoomToolResult>({
        content: [{ text: "ok", type: "text" }],
      });
    });
    const registered: unknown = at(server.instance, "_registeredTools");
    const comment = at(registered, "comment");
    const handler = at(comment, "handler");
    const forwardedResult = isHandler(handler)
      ? await handler({ blockId: "b-1", body: "y", quote: "x" }, {})
      : undefined;
    expect({
      alwaysLoad: at(comment, "_meta", "anthropic/alwaysLoad"),
      description: at(comment, "description"),
      forwarded,
      forwardedResult,
      names: Object.keys(isRecord(registered) ? registered : {}),
      server: [server.type, server.name],
    }).toStrictEqual({
      alwaysLoad: true,
      description: documentTools.find((t) => t.name === "comment")?.description,
      forwarded: [["comment", { blockId: "b-1", body: "y", quote: "x" }]],
      forwardedResult: { content: [{ text: "ok", type: "text" }] },
      names: documentTools.map((t) => t.name),
      server: ["sdk", "atelier"],
    });
  });

  describe("the scribe's draft tools", () => {
    const report = {
      added: 1,
      blocks: 4,
      finalBlocks: 4,
      moved: 0,
      operations: 2,
      removed: 1,
      removedUndrawn: ["b-4"],
      replaced: 1,
      threads: {
        detaching: [{ blockId: "b-4", passage: "Ask Sam", threadId: "th-2" }],
        moving: [{ passage: "Postgres", threadId: "th-1", toBlockId: "b-3" }],
      },
      untouched: { count: 2, ids: ["b-1", "b-2"] },
    };
    const scribe = () => {
      const convex = fakeConvex({
        "documentTools:scribeDraftForTurn": (args) => ({
          ok: true,
          report,
          ...(at(args.op, "op") === "add" ? { draftId: "new-2" } : {}),
        }),
      });
      const run = async (name: string, args: unknown) =>
        await callRoomTool(
          convex.client,
          "s3cret",
          "t1",
          name,
          args,
          scribeTools
        );
      return { calls: convex.calls, run };
    };

    it("each tool sends one operation, as this turn, to the draft function", async () => {
      const { calls, run } = scribe();
      await run("draft_replace", {
        blockId: "b-3",
        sourceBlockIds: ["b-4"],
        text: "Merged.",
      });
      await run("draft_add", {
        afterBlockId: "start",
        kind: "heading",
        sourceBlockIds: [],
        text: "Summary",
      });
      await run("draft_keep", { blockId: "b-1" });
      await run("draft_remove", { blockId: "b-4" });
      await run("draft_move", { afterBlockId: "new-2", blockId: "b-2" });
      expect({
        ops: calls.map((c) => c.args.op),
        sameTurn: calls.every(
          (c) =>
            c.name === "documentTools:scribeDraftForTurn" &&
            c.args.secret === "s3cret" &&
            c.args.turnId === "t1"
        ),
      }).toStrictEqual({
        ops: [
          {
            blockId: "b-3",
            op: "replace",
            sourceBlockIds: ["b-4"],
            text: "Merged.",
          },
          {
            afterBlockId: "start",
            kind: "heading",
            op: "add",
            sourceBlockIds: [],
            text: "Summary",
          },
          { blockId: "b-1", op: "keep" },
          { blockId: "b-4", op: "remove" },
          { afterBlockId: "new-2", blockId: "b-2", op: "move" },
        ],
        sameTurn: true,
      });
    });

    it("each reply reports what the whole draft would do", async () => {
      const { run } = scribe();
      const replaced = await run("draft_replace", {
        blockId: "b-3",
        sourceBlockIds: ["b-4"],
        text: "Merged.",
      });
      const added = await run("draft_add", {
        afterBlockId: "start",
        kind: "heading",
        sourceBlockIds: [],
        text: "Summary",
      });
      expect(text(replaced)).toBe(
        [
          "Block b-3 is rewritten in the draft.",
          "",
          "Draft so far: 2 operations. Of the 4 blocks in the document, 1 rewritten, 1 removed, 0 moved; 1 added. The document will have 4 blocks.",
          "Not mentioned by the draft, so kept exactly as they are: 2 blocks (b-1, b-2).",
          "Removed and drawn on by no block, so their text leaves the document (history keeps it): b-4.",
          "Comment threads that will move with their passage:",
          '- thread th-1 ("Postgres") to b-3',
          "Comment threads that will lose their passage (they stay open and link to the version before your run):",
          '- thread th-2 ("Ask Sam") on b-4',
        ].join("\n")
      );
      expect(text(added)).toMatch(/^Added new-2 to the draft\./u);
    });

    it("the scribe's set has no tool that writes the document directly", async () => {
      const { run } = scribe();
      const refused = await run("update_block", {
        baseRev: 1,
        blockId: "b-1",
        text: "x",
      });
      expect(refused.isError).toBeTruthy();
    });
  });
});
