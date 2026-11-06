import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// A turn's streamed text and tool calls. The runner writes both while a turn
// runs, so the agent pane reads them for active turns from a small live query
// and for finished turns from the history query, which then stays put while
// an agent streams.

export const streamedText = async (ctx: QueryCtx, turn: Doc<"turns">) => {
  const row = await ctx.db
    .query("turnStreams")
    .withIndex("by_turn", (q) => q.eq("turnId", turn._id))
    .unique();
  return row?.text ?? turn.partialText ?? "";
};

export const setStreamedText = async (
  ctx: MutationCtx,
  turnId: Id<"turns">,
  text: string
) => {
  const row = await ctx.db
    .query("turnStreams")
    .withIndex("by_turn", (q) => q.eq("turnId", turnId))
    .unique();
  if (!row) {
    await ctx.db.insert("turnStreams", { text, turnId });
  } else if (row.text !== text) {
    await ctx.db.patch(row._id, { text });
  }
};

export const toolItems = async (ctx: QueryCtx, turnId: Id<"turns">) => {
  const items = await ctx.db
    .query("turnItems")
    .withIndex("by_turn_call", (q) => q.eq("turnId", turnId))
    .collect();
  return items
    .toSorted((a, b) => a.seq - b.seq)
    .map((i) => ({ name: i.name, ok: i.ok ?? null, summary: i.summary }));
};

// Queued and running turns in a room, oldest first.
export const activeRoomTurns = async (ctx: QueryCtx, roomId: Id<"rooms">) => {
  const withStatus = async (status: "queued" | "running") =>
    await ctx.db
      .query("turns")
      .withIndex("by_room_status", (q) =>
        q.eq("roomId", roomId).eq("status", status)
      )
      .collect();
  const queued = await withStatus("queued");
  const running = await withStatus("running");
  return [...queued, ...running].toSorted(
    (a, b) => a._creationTime - b._creationTime
  );
};
