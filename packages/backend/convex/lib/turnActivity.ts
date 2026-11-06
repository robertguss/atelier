import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// A turn's streamed text and tool calls. The runner writes both while a turn
// runs, so the agent pane reads them for active turns from a small live query
// and for finished turns from the history query, which then stays put while
// an agent streams.

export async function streamedText(ctx: QueryCtx, turn: Doc<"turns">) {
  const row = await ctx.db
    .query("turnStreams")
    .withIndex("by_turn", (q) => q.eq("turnId", turn._id))
    .unique();
  return row?.text ?? turn.partialText ?? "";
}

export async function setStreamedText(
  ctx: MutationCtx,
  turnId: Id<"turns">,
  text: string
) {
  const row = await ctx.db
    .query("turnStreams")
    .withIndex("by_turn", (q) => q.eq("turnId", turnId))
    .unique();
  if (!row) {
    await ctx.db.insert("turnStreams", { turnId, text });
  } else if (row.text !== text) {
    await ctx.db.patch(row._id, { text });
  }
}

export async function toolItems(ctx: QueryCtx, turnId: Id<"turns">) {
  return (
    await ctx.db
      .query("turnItems")
      .withIndex("by_turn_call", (q) => q.eq("turnId", turnId))
      .collect()
  )
    .sort((a, b) => a.seq - b.seq)
    .map((i) => ({ name: i.name, ok: i.ok ?? null, summary: i.summary }));
}

// Queued and running turns in a room, oldest first.
export async function activeRoomTurns(ctx: QueryCtx, roomId: Id<"rooms">) {
  const withStatus = async (status: "queued" | "running") =>
    ctx.db
      .query("turns")
      .withIndex("by_room_status", (q) =>
        q.eq("roomId", roomId).eq("status", status)
      )
      .collect();
  return [
    ...(await withStatus("queued")),
    ...(await withStatus("running")),
  ].sort((a, b) => a._creationTime - b._creationTime);
}
