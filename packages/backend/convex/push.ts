import { v } from "convex/values";

import { internal } from "./_generated/api";
import {
  mutation,
  query,
  internalQuery,
  internalMutation,
  internalAction,
} from "./_generated/server";
import { requireOwner } from "./lib/auth";

export const register = mutation({
  args: { platform: v.string(), token: v.string() },
  handler: async (ctx, { token, platform }) => {
    const owner = await requireOwner(ctx);
    if (!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9_-]+\]$/.test(token)) {
      throw new Error("Invalid Expo push token");
    }
    const tokens = await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userSubject", owner.subject))
      .collect();
    if (!tokens.some((t) => t.token === token)) {
      await ctx.db.insert("pushTokens", {
        userSubject: owner.subject,
        token,
        platform,
      });
    }
  },
});
export const readiness = query({
  args: {},
  handler: async (ctx) => {
    const owner = await requireOwner(ctx);
    return {
      registered:
        (
          await ctx.db
            .query("pushTokens")
            .withIndex("by_user", (q) => q.eq("userSubject", owner.subject))
            .collect()
        ).length > 0,
    };
  },
});
export const recipients = internalQuery({
  args: { ritualId: v.id("rituals") },
  handler: async (ctx, { ritualId }) => {
    const ritual = await ctx.db.get(ritualId);
    if (!ritual || ritual.status === "collecting" || !ritual.ownerSubject) {
      return [];
    }
    return await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userSubject", ritual.ownerSubject!))
      .collect();
  },
});
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
    for (const id of invalidTokens) {
      await ctx.db.delete(id);
    }
  },
});
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
      for (let i = 0; i < tokens.length; i += 100) {
        const batch = tokens.slice(i, i + 100);
        const response = await fetch("https://exp.host/--/api/v2/push/send", {
          body: JSON.stringify(
            batch.map((t) => ({
              to: t.token,
              title: "Review ready",
              body: "All participants have finished. Open Atelier to read their answers.",
              data: { ritualId },
              sound: "default",
            }))
          ),
          headers: {
            "Content-Type": "application/json",
            ...(process.env.EXPO_ACCESS_TOKEN
              ? { Authorization: `Bearer ${process.env.EXPO_ACCESS_TOKEN}` }
              : {}),
          },
          method: "POST",
          signal: AbortSignal.timeout(15_000),
        });
        if (!response.ok) {
          throw new Error(`Expo push HTTP ${response.status}`);
        }
        const payload = await response.json();
        if (
          !Array.isArray(payload.data) ||
          payload.data.length !== batch.length
        ) {
          throw new Error("Invalid Expo push response");
        }
        accepted += payload.data.filter(
          (ticket: { status?: string }) => ticket.status === "ok"
        ).length;
        const invalidTokens = batch
          .filter(
            (_, n) => payload.data[n]?.details?.error === "DeviceNotRegistered"
          )
          .map((t) => t._id);
        const failed = payload.data.some(
          (ticket: { status?: string; details?: { error?: string } }) =>
            ticket.status !== "ok" &&
            ticket.details?.error !== "DeviceNotRegistered"
        );
        await ctx.runMutation(internal.push.result, {
          invalidTokens,
          ritualId,
          status: failed ? "failed" : "sent",
        });
        if (failed) {
          throw new Error("Expo rejected a push ticket");
        }
      }
      await ctx.runMutation(internal.push.result, {
        invalidTokens: [],
        ritualId,
        status: accepted ? "sent" : "skipped",
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
