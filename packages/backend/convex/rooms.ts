import { v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query } from "./_generated/server";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import {
  ensureUser,
  getMembership,
  getOwner,
  getUser,
  requireMember,
  requireOwner,
} from "./lib/auth";
import { DEFAULT_TEMPLATE, ownTemplate, seedDocument } from "./lib/document";
import { record } from "./lib/ledger";
import { agentName } from "./lib/prompt";

// Reviews in the room that have finished collecting.
const readyReviewCount = async (ctx: QueryCtx, roomId: Id<"rooms">) => {
  const rituals = await ctx.db
    .query("rituals")
    .withIndex("by_room", (q) => q.eq("roomId", roomId))
    .collect();
  return rituals.filter((r) => r.status !== "collecting").length;
};

export const list = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Not signed in");
    }
    const user = await getUser(ctx);
    if (!user) {
      return [];
    }
    const userMemberships = await ctx.db
      .query("roomMembers")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const memberships = userMemberships.filter(
      (m) => m.removedAt === undefined
    );
    const memberRooms = await Promise.all(
      memberships.map(async (m) => await ctx.db.get(m.roomId))
    );
    const rooms = [];
    for (const [i, m] of memberships.entries()) {
      const room = memberRooms[i];
      if (room && room.archivedAt === undefined) {
        rooms.push({ role: m.role, room });
      }
    }
    rooms.sort((a, b) => b.room._creationTime - a.room._creationTime);
    // Reviews are the owner's alone, so members get no count.
    return await Promise.all(
      rooms.map(async ({ room, role }) => ({
        ...room,
        readyReviews:
          role === "owner" ? await readyReviewCount(ctx, room._id) : undefined,
        role,
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
    if (!id) {
      return "none";
    }
    const found = await getMembership(ctx, id);
    if (!found) {
      return "none";
    }
    if (found.member.removedAt !== undefined) {
      return "removed";
    }
    if (found.member.role === "owner") {
      return (await getOwner(ctx)) ? "owner" : "none";
    }
    return "member";
  },
});

export const get = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    const room = await ctx.db.get(roomId);
    if (!room) {
      return null;
    }
    await requireMember(ctx, roomId);
    const participants = await ctx.db
      .query("participants")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    return { participants, room };
  },
});

// Step 2: a room starts with the owner and a Claude Code participant.
// Codex and Pi join in step 3. Its document is seeded from the chosen
// template, or Atelier's default when none is chosen.
export const create = mutation({
  args: {
    cwd: v.string(),
    name: v.string(),
    runnerId: v.id("runners"),
    templateId: v.optional(v.id("templates")),
  },
  handler: async (ctx, { name, runnerId, cwd, templateId }) => {
    const owner = await requireOwner(ctx);
    const user = await ensureUser(ctx);
    const runner = await ctx.db.get(runnerId);
    if (!runner) {
      throw new Error("Unknown runner");
    }
    const template = templateId ? await ownTemplate(ctx, templateId) : null;

    const roomId = await ctx.db.insert("rooms", {
      cwd: cwd.trim(),
      handbook: "",
      name: name.trim(),
      runnerId,
    });
    const created = await record(ctx, {
      payload: { cwd, name, runner: runner.name },
      roomId,
      subjectId: roomId,
      type: "room.created",
    });

    const humanId = await ctx.db.insert("participants", {
      displayName: agentName(
        owner.name !== undefined && owner.name !== ""
          ? owner.name
          : owner.email,
        "You"
      ),
      kind: "human",
      roomId,
      userId: user._id,
    });
    await ctx.db.insert("roomMembers", {
      participantId: humanId,
      role: "owner",
      roomId,
      userId: user._id,
    });
    await record(ctx, {
      parentLedgerId: created,
      payload: { kind: "human" },
      roomId,
      subjectId: humanId,
      type: "participant.joined",
    });

    const claudeId = await ctx.db.insert("participants", {
      displayName: "Claude",
      harness: "claude",
      kind: "harness",
      roomId,
    });
    await record(ctx, {
      parentLedgerId: created,
      payload: { harness: "claude", kind: "harness" },
      provider: "anthropic",
      roomId,
      subjectId: claudeId,
      type: "participant.joined",
    });

    await seedDocument(
      ctx,
      roomId,
      template?.sections ?? DEFAULT_TEMPLATE,
      template?._id
    );
    return roomId;
  },
});

export const addParticipant = mutation({
  args: {
    harness: v.union(v.literal("claude"), v.literal("codex"), v.literal("pi")),
    roomId: v.id("rooms"),
  },
  handler: async (ctx, { roomId, harness }) => {
    await requireOwner(ctx);
    const room = await ctx.db.get(roomId);
    if (!room) {
      throw new Error("Unknown room");
    }
    const existing = await ctx.db
      .query("participants")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const found = existing.find((p) => p.harness === harness);
    if (found) {
      return found._id;
    }
    const runner = await ctx.db.get(room.runnerId);
    if (runner?.harnesses.some((h) => h.id === harness) !== true) {
      throw new Error("Harness unavailable on this runner");
    }
    const id = await ctx.db.insert("participants", {
      displayName: { claude: "Claude", codex: "Codex", pi: "Pi" }[harness],
      harness,
      kind: "harness",
      roomId,
    });
    await record(ctx, {
      payload: { harness, kind: "harness" },
      roomId,
      subjectId: id,
      type: "participant.joined",
    });
    return id;
  },
});

// Tells one running turn about the new edit switch, and interrupts a Codex or
// Pi turn that started with edits on when they are turned off.
const sendEditsChange = async (
  ctx: MutationCtx,
  room: Doc<"rooms">,
  turn: Doc<"turns">,
  on: boolean
) => {
  await ctx.db.insert("commands", {
    payload: { editsEnabled: on },
    runnerId: room.runnerId,
    status: "pending",
    turnId: turn._id,
    type: "settings",
  });
  const agent = await ctx.db.get(turn.participantId);
  if (
    !on &&
    turn.editsEnabled === true &&
    (agent?.harness === "codex" || agent?.harness === "pi")
  ) {
    await ctx.db.insert("commands", {
      payload: { reason: "File edits were turned off" },
      runnerId: room.runnerId,
      status: "pending",
      turnId: turn._id,
      type: "interrupt",
    });
  }
};

// The owner's "agents may edit files in this folder" switch. Running turns
// get the new value as a settings command. Codex and Pi fix their
// permissions when a turn starts, so turning edits off also interrupts those
// that started with edits on; one that started with edits off never had them.
// Reviews and scribe turns never edit files, so they get no settings change.
export const setEditsEnabled = mutation({
  args: { on: v.boolean(), roomId: v.id("rooms") },
  handler: async (ctx, { roomId, on }) => {
    await requireOwner(ctx);
    const { participant: owner } = await requireMember(ctx, roomId);
    const room = await ctx.db.get(roomId);
    if (!room) {
      throw new Error("Unknown room");
    }
    if ((room.editsEnabled === true) === on) {
      return;
    }
    await ctx.db.patch(roomId, { editsEnabled: on });
    await record(ctx, {
      actorParticipantId: owner._id,
      payload: { editsEnabled: on },
      roomId,
      subjectId: roomId,
      type: "room.edits_changed",
    });

    const turns = await ctx.db
      .query("turns")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const running = turns.filter(
      (t) => t.status === "running" && !t.ritualId && !t.scribeRunId
    );
    for (const turn of running) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- commands are inserted in turn order, settings before interrupt, and the runner claims pending commands in that order
      await sendEditsChange(ctx, room, turn, on);
    }
  },
});
