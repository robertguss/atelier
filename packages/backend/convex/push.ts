import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import {
  mutation,
  query,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import type { ActionCtx, MutationCtx } from "./_generated/server";
import { requireOwner } from "./lib/auth";

const BATCH_SIZE = 100;

// Expo's push tickets, read field by field from the parsed response.
const ticketStatus = (ticket: unknown) =>
  typeof ticket === "object" && ticket !== null && "status" in ticket
    ? ticket.status
    : undefined;

const ticketError = (ticket: unknown) => {
  const details =
    typeof ticket === "object" && ticket !== null && "details" in ticket
      ? ticket.details
      : undefined;
  return typeof details === "object" && details !== null && "error" in details
    ? details.error
    : undefined;
};

const ticketsOf = (payload: unknown): unknown[] | undefined => {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("data" in payload) ||
    !Array.isArray(payload.data)
  ) {
    return undefined;
  }
  const tickets: unknown[] = payload.data;
  return tickets;
};

export const register = mutation({
  args: { platform: v.string(), token: v.string() },
  handler: async (ctx, { token, platform }) => {
    const owner = await requireOwner(ctx);
    if (
      !/^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/u.test(token)
    ) {
      throw new Error("Invalid Expo push token");
    }
    const tokens = await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userSubject", owner.subject))
      .collect();
    if (!tokens.some((t) => t.token === token)) {
      await ctx.db.insert("pushTokens", {
        platform,
        token,
        userSubject: owner.subject,
      });
    }
  },
});
export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    const tokens = await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userSubject", owner.subject))
      .collect();
    return { registered: tokens.length > 0 };
  },
});
export const recipients = internalQuery({
  args: { ritualId: v.id("rituals") },
  handler: async (ctx, { ritualId }) => {
    const ritual = await ctx.db.get(ritualId);
    const ownerSubject = ritual?.ownerSubject;
    if (
      !ritual ||
      ritual.status === "collecting" ||
      ownerSubject === undefined ||
      ownerSubject === ""
    ) {
      return [];
    }
    return await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userSubject", ownerSubject))
      .collect();
  },
});
// Devices Expo reported as no longer registered.
const deleteTokens = async (ctx: MutationCtx, ids: Id<"pushTokens">[]) => {
  await Promise.all(
    ids.map(async (id) => {
      await ctx.db.delete(id);
    })
  );
};

export const result = internalMutation({
  args: {
    invalidTokens: v.array(v.id("pushTokens")),
    ritualId: v.id("rituals"),
    status: v.union(
      v.literal("sent"),
      v.literal("skipped"),
      v.literal("failed")
    ),
  },
  handler: async (ctx, { ritualId, status, invalidTokens }) => {
    await ctx.db.patch(ritualId, { pushStatus: status });
    await deleteTokens(ctx, invalidTokens);
  },
});
interface PushMessage {
  title: string;
  body: string;
  data: Record<string, string>;
}

// Sends one message to a batch of at most BATCH_SIZE devices. Returns how
// many Expo accepted, the devices it says are gone, and whether it rejected
// any other.
const expoSend = async (batch: Doc<"pushTokens">[], message: PushMessage) => {
  const accessToken = process.env.EXPO_ACCESS_TOKEN;
  const response = await fetch("https://exp.host/--/api/v2/push/send", {
    body: JSON.stringify(
      batch.map((t) => ({ ...message, sound: "default", to: t.token }))
    ),
    headers: {
      "Content-Type": "application/json",
      ...(accessToken !== undefined && accessToken !== ""
        ? { Authorization: `Bearer ${accessToken}` }
        : {}),
    },
    method: "POST",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`Expo push HTTP ${response.status}`);
  }
  const payload: unknown = await response.json();
  const tickets = ticketsOf(payload);
  if (tickets?.length !== batch.length) {
    throw new Error("Invalid Expo push response");
  }
  const accepted = tickets.filter((t) => ticketStatus(t) === "ok").length;
  const invalidTokens = batch
    .filter((_, n) => ticketError(tickets[n]) === "DeviceNotRegistered")
    .map((t) => t._id);
  const failed = tickets.some(
    (t) => ticketStatus(t) !== "ok" && ticketError(t) !== "DeviceNotRegistered"
  );
  return { accepted, failed, invalidTokens };
};

// Sends one batch of review notifications and records the outcome. Returns
// how many Expo accepted; throws if Expo rejected any.
const sendBatch = async (
  ctx: ActionCtx,
  ritualId: Id<"rituals">,
  batch: Doc<"pushTokens">[]
) => {
  const { accepted, failed, invalidTokens } = await expoSend(batch, {
    body: "All participants have finished. Open Atelier to read their answers.",
    data: { ritualId },
    title: "Review ready",
  });
  await ctx.runMutation(internal.push.result, {
    invalidTokens,
    ritualId,
    status: failed ? "failed" : "sent",
  });
  if (failed) {
    throw new Error("Expo rejected a push ticket");
  }
  return accepted;
};

// Invoked as a durable workflow step. Only generic text leaves Convex.
// Expo may accept a request before a network timeout; retries can duplicate a
// notification, so the ritual id is also the client's navigation/dedup key.
export const send = internalAction({
  args: { ritualId: v.id("rituals") },
  handler: async (ctx, { ritualId }): Promise<null> => {
    const tokens = await ctx.runQuery(internal.push.recipients, { ritualId });
    if (!tokens.length) {
      await ctx.runMutation(internal.push.result, {
        invalidTokens: [],
        ritualId,
        status: "skipped",
      });
      return null;
    }
    try {
      let accepted = 0;
      for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- batches go out one at a time so a rejected batch stops the rest
        accepted += await sendBatch(
          ctx,
          ritualId,
          tokens.slice(i, i + BATCH_SIZE)
        );
      }
      await ctx.runMutation(internal.push.result, {
        invalidTokens: [],
        ritualId,
        status: accepted > 0 ? "sent" : "skipped",
      });
      return null;
    } catch (error) {
      await ctx.runMutation(internal.push.result, {
        invalidTokens: [],
        ritualId,
        status: "failed",
      });
      throw error;
    }
  },
});

// Who a raised card's push goes to, and what it says. Null once the card
// has closed, so a card answered at once sends nothing.
export const handPush = internalQuery({
  args: { handId: v.id("hands") },
  handler: async (ctx, { handId }) => {
    const hand = await ctx.db.get(handId);
    if (hand?.status !== "raised") {
      return null;
    }
    const agent = await ctx.db.get(hand.participantId);
    // shortcut: every registered device gets it. Only owners can register
    // today, and there is one owner; once rooms have different owners, send
    // to the room owner's devices only.
    const tokens = await ctx.db.query("pushTokens").collect();
    return {
      agentName: agent?.displayName ?? "An agent",
      participantId: hand.participantId,
      roomId: hand.roomId,
      tokens,
    };
  },
});

export const dropTokens = internalMutation({
  args: { tokenIds: v.array(v.id("pushTokens")) },
  handler: async (ctx, { tokenIds }) => {
    await deleteTokens(ctx, tokenIds);
  },
});

// Tells the owner's phone that an agent is waiting on a card. Only the
// agent's name leaves Convex, never the question.
export const sendHand = internalAction({
  args: { handId: v.id("hands") },
  handler: async (ctx, { handId }): Promise<null> => {
    const push = await ctx.runQuery(internal.push.handPush, { handId });
    if (push === null || push.tokens.length === 0) {
      return null;
    }
    const message = {
      body: `${push.agentName} has a question. Open Atelier to answer it.`,
      data: { participantId: push.participantId, roomId: push.roomId },
      title: "Question waiting",
    };
    let failed = false;
    const gone: Id<"pushTokens">[] = [];
    for (let i = 0; i < push.tokens.length; i += BATCH_SIZE) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- batches go out one at a time
      const sent = await expoSend(
        push.tokens.slice(i, i + BATCH_SIZE),
        message
      );
      gone.push(...sent.invalidTokens);
      failed ||= sent.failed;
    }
    if (gone.length > 0) {
      await ctx.runMutation(internal.push.dropTokens, { tokenIds: gone });
    }
    if (failed) {
      throw new Error("Expo rejected a push ticket");
    }
    return null;
  },
});
