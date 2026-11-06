import { v } from "convex/values";

import { mutation, query } from "./_generated/server";
import {
  ensureUser,
  getMembership,
  getOwner,
  getUser,
  requireMember,
  requireOwner,
} from "./lib/auth";
import { record } from "./lib/ledger";
import { agentName } from "./lib/prompt";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not signed in");
    const user = await getUser(ctx);
    if (!user) return [];
    const memberships = (
      await ctx.db
        .query("roomMembers")
        .withIndex("by_user", (q) => q.eq("userId", user._id))
        .collect()
    ).filter((m) => m.removedAt === undefined);
    const rooms = [];
    for (const m of memberships) {
      const room = await ctx.db.get(m.roomId);
      if (room && room.archivedAt === undefined)
        rooms.push({ room, role: m.role });
    }
    rooms.sort((a, b) => b.room._creationTime - a.room._creationTime);
    // Reviews are the owner's alone, so members get no count.
    return await Promise.all(
      rooms.map(async ({ room, role }) => ({
        ...room,
        role,
        readyReviews:
          role === "owner"
            ? (
                await ctx.db
                  .query("rituals")
                  .withIndex("by_room", (q) => q.eq("roomId", room._id))
                  .collect()
              ).filter((r) => r.status !== "collecting").length
            : undefined,
      }))
    );
  },
});

// Where the caller stands in a room, for routing. Never throws.
export const access = query({
  args: { roomId: v.string() },
  handler: async (
    ctx,
    { roomId }
  ): Promise<"owner" | "member" | "removed" | "none"> => {
    const id = ctx.db.normalizeId("rooms", roomId);
    if (!id) return "none";
    const found = await getMembership(ctx, id);
    if (!found) return "none";
    if (found.member.removedAt !== undefined) return "removed";
    if (found.member.role === "owner")
      return (await getOwner(ctx)) ? "owner" : "none";
    return "member";
  },
});

export const get = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const room = await ctx.db.get(roomId);
    if (!room) return null;
    await requireMember(ctx, roomId);
    const participants = await ctx.db
      .query("participants")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    return { room, participants };
  },
});

// Step 2: a room starts with the owner and a Claude Code participant.
// Codex and Pi join in step 3.
export const create = mutation({
  args: { name: v.string(), runnerId: v.id("runners"), cwd: v.string() },
  handler: async (ctx, { name, runnerId, cwd }) => {
    const owner = await requireOwner(ctx);
    const user = await ensureUser(ctx);
    const runner = await ctx.db.get(runnerId);
    if (!runner) throw new Error("Unknown runner");

    const roomId = await ctx.db.insert("rooms", {
      name: name.trim(),
      runnerId,
      cwd: cwd.trim(),
      handbook: "",
    });
    const created = await record(ctx, {
      roomId,
      type: "room.created",
      subjectId: roomId,
      payload: { name, cwd, runner: runner.name },
    });

    const humanId = await ctx.db.insert("participants", {
      roomId,
      kind: "human",
      displayName: agentName(owner.name || owner.email, "You"),
      userId: user._id,
    });
    await ctx.db.insert("roomMembers", {
      roomId,
      userId: user._id,
      role: "owner",
      participantId: humanId,
    });
    await record(ctx, {
      roomId,
      type: "participant.joined",
      subjectId: humanId,
      parentLedgerId: created,
      payload: { kind: "human" },
    });

    const claudeId = await ctx.db.insert("participants", {
      roomId,
      kind: "harness",
      harness: "claude",
      displayName: "Claude",
    });
    await record(ctx, {
      roomId,
      type: "participant.joined",
      subjectId: claudeId,
      parentLedgerId: created,
      provider: "anthropic",
      payload: { kind: "harness", harness: "claude" },
    });

    return roomId;
  },
});

export const addParticipant = mutation({
  args: {
    roomId: v.id("rooms"),
    harness: v.union(v.literal("claude"), v.literal("codex"), v.literal("pi")),
  },
  handler: async (ctx, { roomId, harness }) => {
    await requireOwner(ctx);
    const room = await ctx.db.get(roomId);
    if (!room) throw new Error("Unknown room");
    const existing = await ctx.db
      .query("participants")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const found = existing.find((p) => p.harness === harness);
    if (found) return found._id;
    const runner = await ctx.db.get(room.runnerId);
    if (!runner?.harnesses.some((h) => h.id === harness))
      throw new Error("Harness unavailable on this runner");
    const id = await ctx.db.insert("participants", {
      roomId,
      kind: "harness",
      harness,
      displayName: { claude: "Claude", codex: "Codex", pi: "Pi" }[harness],
    });
    await record(ctx, {
      roomId,
      type: "participant.joined",
      subjectId: id,
      payload: { kind: "harness", harness },
    });
    return id;
  },
});

// The owner's "agents may edit files in this folder" switch. Running turns
// get the new value as a settings command. Codex and Pi fix their
// permissions when a turn starts, so turning edits off also interrupts those
// that started with edits on; one that started with edits off never had them.
export const setEditsEnabled = mutation({
  args: { roomId: v.id("rooms"), on: v.boolean() },
  handler: async (ctx, { roomId, on }) => {
    await requireOwner(ctx);
    const { participant: owner } = await requireMember(ctx, roomId);
    const room = await ctx.db.get(roomId);
    if (!room) throw new Error("Unknown room");
    if ((room.editsEnabled === true) === on) return;
    await ctx.db.patch(roomId, { editsEnabled: on });
    await record(ctx, {
      roomId,
      type: "room.edits_changed",
      actorParticipantId: owner._id,
      subjectId: roomId,
      payload: { editsEnabled: on },
    });

    const running = (
      await ctx.db
        .query("turns")
        .withIndex("by_room", (q) => q.eq("roomId", roomId))
        .collect()
    ).filter((t) => t.status === "running" && !t.ritualId);
    for (const turn of running) {
      await ctx.db.insert("commands", {
        runnerId: room.runnerId,
        type: "settings",
        turnId: turn._id,
        status: "pending",
        payload: { editsEnabled: on },
      });
      const agent = await ctx.db.get(turn.participantId);
      if (
        !on &&
        turn.editsEnabled === true &&
        (agent?.harness === "codex" || agent?.harness === "pi")
      ) {
        await ctx.db.insert("commands", {
          runnerId: room.runnerId,
          type: "interrupt",
          turnId: turn._id,
          status: "pending",
          payload: { reason: "File edits were turned off" },
        });
      }
    }
  },
});
