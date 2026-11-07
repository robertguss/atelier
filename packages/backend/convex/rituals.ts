import { WorkflowManager, start } from "@convex-dev/workflow";
import { v } from "convex/values";

import { components, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { mutation, query, internalMutation } from "./_generated/server";
import type { MutationCtx } from "./_generated/server";
import { requireMember, requireOwner } from "./lib/auth";
import { record } from "./lib/ledger";

const workflow = new WorkflowManager(components.workflow);
export const collect = workflow
  .define({
    args: { ritualId: v.id("rituals"), turnIds: v.array(v.id("turns")) },
    returns: v.null(),
  })
  .handler(async (step, { ritualId, turnIds }): Promise<null> => {
    for (const id of turnIds) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- each wait is a journaled workflow step; waiting in parallel would change the step journal that workflows already in flight replay against
      await step.awaitEvent({ name: id });
    }
    await step.runMutation(internal.rituals.reveal, { ritualId });
    await step.runAction(
      internal.push.send,
      { ritualId },
      { retry: { base: 2, initialBackoffMs: 1000, maxAttempts: 3 } }
    );
    return null;
  });
export const reveal = internalMutation({
  args: { ritualId: v.id("rituals") },
  handler: async (ctx, { ritualId }): Promise<boolean> => {
    const ritual = await ctx.db.get(ritualId);
    if (!ritual || ritual.status !== "collecting") {
      return true;
    }
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_ritual", (q) => q.eq("ritualId", ritualId))
      .collect();
    if (
      turns.length !== ritual.participantIds.length ||
      turns.some((t) => ["queued", "running"].includes(t.status))
    ) {
      return false;
    }
    await ctx.db.patch(ritualId, {
      pushStatus: "queued",
      revealedAt: Date.now(),
      status: "revealed",
    });
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_ritual", (q) => q.eq("ritualId", ritualId))
      .collect();
    await Promise.all(
      messages.map(async (message) => {
        await ctx.db.patch(message._id, { visibility: "room" });
      })
    );
    await record(ctx, {
      roomId: ritual.roomId,
      subjectId: ritualId,
      type: "ritual.revealed",
    });
    return true;
  },
});
// One participant's review turn, its run command and its ledger row.
const queueReviewTurn = async (
  ctx: MutationCtx,
  room: Doc<"rooms">,
  ritualId: Id<"rituals">,
  participantId: Id<"participants">,
  { parentLedgerId, prompt }: { parentLedgerId: Id<"ledger">; prompt: string }
) => {
  const turnId = await ctx.db.insert("turns", {
    participantId,
    prompt,
    ritualId,
    roomId: room._id,
    status: "queued",
  });
  await ctx.db.insert("commands", {
    runnerId: room.runnerId,
    status: "pending",
    turnId,
    type: "run_turn",
  });
  await record(ctx, {
    actorParticipantId: participantId,
    parentLedgerId,
    roomId: room._id,
    subjectId: turnId,
    type: "turn.queued",
  });
  return turnId;
};

export const begin = mutation({
  args: {
    participantIds: v.array(v.id("participants")),
    request: v.string(),
    roomId: v.id("rooms"),
  },
  handler: async (ctx, { roomId, request, participantIds }) => {
    const owner = await requireOwner(ctx);
    const room = await ctx.db.get(roomId);
    if (
      !room ||
      room.archivedAt !== undefined ||
      request.length > 50_000 ||
      !request.trim() ||
      !participantIds.length ||
      new Set(participantIds).size !== participantIds.length
    ) {
      throw new Error("Choose participants and enter a request");
    }
    const participants = await Promise.all(
      participantIds.map(async (id) => await ctx.db.get(id))
    );
    if (
      participants.some(
        (p) => !p || p.roomId !== roomId || p.kind !== "harness"
      )
    ) {
      throw new Error("Invalid participant");
    }
    const { participant: human } = await requireMember(ctx, roomId);
    const ritualId = await ctx.db.insert("rituals", {
      ownerSubject: owner.subject,
      participantIds,
      request: request.trim(),
      roomId,
      status: "collecting",
      type: "independent_review",
    });
    const parentLedgerId = await record(ctx, {
      actorParticipantId: human._id,
      roomId,
      subjectId: ritualId,
      type: "ritual.started",
    });
    const decisions = await ctx.db
      .query("decisions")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .order("desc")
      .take(10);
    const prompt = `Independent read-only review. Write your own answer. Do not seek other participants' answers.\nRoom: ${room.name}\nHandbook:\n${room.handbook}\nRecent decisions:\n${decisions.map((d) => `${d.choice}: ${d.rationale ?? ""}`).join("\n")}\nRequest:\n${request.trim()}`;
    const turnIds = [];
    for (const participantId of participantIds) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- turns, commands and ledger rows are written in participant order, which the runner's claims and the ledger show
      const turnId = await queueReviewTurn(ctx, room, ritualId, participantId, {
        parentLedgerId,
        prompt,
      });
      turnIds.push(turnId);
    }
    const workflowId = await start(ctx, internal.rituals.collect, {
      ritualId,
      turnIds,
    });
    await ctx.db.patch(ritualId, { workflowId });
    return ritualId;
  },
});
export const list = query({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => {
    await requireOwner(ctx);
    const rituals = await ctx.db
      .query("rituals")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .order("desc")
      .collect();
    return rituals.map((r) => ({
      _id: r._id,
      request: r.request,
      status: r.status,
    }));
  },
});
export const get = query({
  args: { ritualId: v.id("rituals") },
  handler: async (ctx, { ritualId }) => {
    await requireOwner(ctx);
    const ritual = await ctx.db.get(ritualId);
    if (!ritual) {
      return null;
    }
    const participants = await ctx.db
      .query("participants")
      .withIndex("by_room", (q) => q.eq("roomId", ritual.roomId))
      .collect();
    const turns = await ctx.db
      .query("turns")
      .withIndex("by_ritual", (q) => q.eq("ritualId", ritualId))
      .collect();
    const cruxes = await ctx.db
      .query("cruxes")
      .withIndex("by_ritual", (q) => q.eq("ritualId", ritualId))
      .collect();
    const roomDecisions = await ctx.db
      .query("decisions")
      .withIndex("by_room", (q) => q.eq("roomId", ritual.roomId))
      .collect();
    const decisions = roomDecisions.filter((d) => d.ritualId === ritualId);
    return {
      _id: ritualId,
      cruxes,
      decisions,
      pushStatus: ritual.pushStatus,
      request: ritual.request,
      roomId: ritual.roomId,
      status: ritual.status,
      takeaways: await ctx.db
        .query("takeaways")
        .withIndex("by_ritual", (q) => q.eq("ritualId", ritualId))
        .collect(),
      turns: turns.map((t) => ({
        _id: t._id,
        name:
          participants.find((p) => p._id === t.participantId)?.displayName ??
          "Participant",
        participantId: t.participantId,
        status: t.status,
        ...(ritual.status === "collecting"
          ? {}
          : { answer: t.finalText, error: t.error }),
      })),
    };
  },
});
export const recordCrux = mutation({
  args: {
    options: v.array(v.string()),
    ritualId: v.id("rituals"),
    statement: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const ritual = await ctx.db.get(args.ritualId);
    if (!ritual || ritual.status !== "revealed" || !args.statement.trim()) {
      throw new Error("A revealed review and crux are required");
    }
    const { participant: human } = await requireMember(ctx, ritual.roomId);
    const id = await ctx.db.insert("cruxes", {
      ...args,
      authorParticipantId: human._id,
      roomId: ritual.roomId,
    });
    await record(ctx, {
      actorParticipantId: human._id,
      roomId: ritual.roomId,
      subjectId: id,
      type: "crux.recorded",
    });
    return id;
  },
});
export const decide = mutation({
  args: {
    choice: v.string(),
    rationale: v.string(),
    ritualId: v.id("rituals"),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const ritual = await ctx.db.get(args.ritualId);
    if (!ritual || ritual.status !== "revealed" || !args.choice.trim()) {
      throw new Error("A revealed review and decision are required");
    }
    const cruxes = await ctx.db
      .query("cruxes")
      .withIndex("by_ritual", (q) => q.eq("ritualId", args.ritualId))
      .collect();
    if (!cruxes.length) {
      throw new Error("Record a crux first");
    }
    const { participant: human } = await requireMember(ctx, ritual.roomId);
    const id = await ctx.db.insert("decisions", {
      ...args,
      roomId: ritual.roomId,
    });
    await ctx.db.patch(ritual._id, { status: "decided" });
    await record(ctx, {
      actorParticipantId: human._id,
      roomId: ritual.roomId,
      subjectId: id,
      type: "decision.recorded",
    });
  },
});

export const saveTakeaway = mutation({
  args: { body: v.string(), ritualId: v.id("rituals") },
  handler: async (ctx, { ritualId, body }) => {
    await requireOwner(ctx);
    const ritual = await ctx.db.get(ritualId);
    if (!ritual || ritual.status === "collecting") {
      throw new Error("Wait until the review finishes");
    }
    const text = body.trim();
    if (!text || text.length > 10_000) {
      throw new Error("Enter a takeaway of at most 10,000 characters");
    }
    const { participant: human } = await requireMember(ctx, ritual.roomId);
    const id = await ctx.db.insert("takeaways", {
      authorParticipantId: human._id,
      body: text,
      ritualId,
    });
    await record(ctx, {
      actorParticipantId: human._id,
      roomId: ritual.roomId,
      subjectId: id,
      type: "takeaway.recorded",
    });
    return id;
  },
});
