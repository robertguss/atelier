import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import { requireOwner, requireRunnerSecret } from "./lib/auth";
import { harnessId } from "./schema";

export const heartbeat = mutation({
  args: {
    harnesses: v.array(v.object({ id: harnessId, version: v.string() })),
    machine: v.string(),
    name: v.string(),
    secret: v.string(),
  },
  handler: async (ctx, { secret, name, machine, harnesses }) => {
    requireRunnerSecret(secret);
    const now = Date.now();
    const existing = await ctx.db
      .query("runners")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (existing) {
      await ctx.db.patch(existing._id, {
        harnesses,
        lastHeartbeatAt: now,
        machine,
      });
      return existing._id;
    }
    const id = await ctx.db.insert("runners", {
      harnesses,
      lastHeartbeatAt: now,
      machine,
      name,
    });
    await ctx.db.insert("ledger", {
      at: now,
      payload: { machine, name },
      subjectId: id,
      type: "runner.registered",
    });
    return id;
  },
});

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.db.query("runners").collect();
  },
});
