import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";

// Every change that matters to collaboration adds a ledger row in the same
// transaction. The ledger is append-only.
export async function record(
  ctx: MutationCtx,
  entry: Omit<Doc<"ledger">, "_id" | "_creationTime" | "at">
): Promise<Id<"ledger">> {
  return await ctx.db.insert("ledger", { ...entry, at: Date.now() });
}

export async function findLedger(
  ctx: QueryCtx,
  roomId: Id<"rooms">,
  type: string,
  subjectId: string
) {
  return await ctx.db
    .query("ledger")
    .withIndex("by_room_type", (q) =>
      q.eq("roomId", roomId).eq("type", type).eq("subjectId", subjectId)
    )
    .first();
}
