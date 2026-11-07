import { v } from "convex/values";

import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import {
  action,
  internalMutation,
  internalQuery,
  mutation,
  query,
} from "./_generated/server";
import type { QueryCtx } from "./_generated/server";
import { ensureUser, hasActiveTeammate, requireOwner } from "./lib/auth";
import { record } from "./lib/ledger";
import { agentName } from "./lib/prompt";
import { resetSoloFollowUpSessions } from "./lib/sessions";

// Room invites. A Convex row per room and email decides access; a Clerk
// invitation is sent only when the email has no Clerk account yet, so the
// person can sign up while Clerk sign-up is restricted.

const INVITE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
const CLERK_API = "https://api.clerk.com/v1";

const hashToken = async (token: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(token)
  );
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
};

const findInvite = async (ctx: QueryCtx, token: string) => {
  const tokenHash = await hashToken(token);
  return await ctx.db
    .query("roomInvites")
    .withIndex("by_token_hash", (q) => q.eq("tokenHash", tokenHash))
    .unique();
};

// A verified email on the signed-in identity must equal the invited one.
const emailMatches = (
  identity: { email?: string; emailVerified?: boolean } | null,
  email: string
) =>
  identity?.email !== undefined &&
  identity.email !== "" &&
  identity.emailVerified !== false &&
  identity.email.toLowerCase() === email;

const maskEmail = (email: string) => {
  const [local = "", domain = ""] = email.split("@");
  return `${local.slice(0, 1)}***@${domain}`;
};

const randomToken = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCodePoint(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/[=]+$/u, "");
};

// Clerk's parsed JSON response, for the caller to narrow.
const clerk = async (
  method: "GET" | "POST",
  path: string,
  body?: object
): Promise<unknown> => {
  const key = process.env.CLERK_SECRET_KEY;
  if (key === undefined || key === "") {
    throw new Error("CLERK_SECRET_KEY is not set");
  }
  const init: RequestInit = {
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    method,
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`${CLERK_API}${path}`, init);
  if (!response.ok) {
    throw new Error(
      `Clerk ${method} ${path.split("?")[0]} failed: ${response.status}`
    );
  }
  const json: unknown = await response.json();
  return json;
};

const invitationIdOf = (invitation: unknown) => {
  if (
    typeof invitation === "object" &&
    invitation !== null &&
    "id" in invitation &&
    typeof invitation.id === "string"
  ) {
    return invitation.id;
  }
  throw new Error("Clerk returned an invitation without an id");
};

export const create = action({
  args: { email: v.string(), roomId: v.id("rooms") },
  handler: async (
    ctx,
    { roomId, email: rawEmail }
  ): Promise<{
    inviteId: Id<"roomInvites">;
    url: string;
    emailed: boolean;
  }> => {
    await requireOwner(ctx);
    const webUrl = process.env.ATELIER_WEB_URL ?? "";
    for (const [name, value] of [
      ["CLERK_SECRET_KEY", process.env.CLERK_SECRET_KEY],
      ["ATELIER_WEB_URL", webUrl],
    ]) {
      if (value === undefined || value === "") {
        console.error(`${name} is not set`);
        throw new Error("Invites aren't set up on this server yet.");
      }
    }
    const email = rawEmail.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/u.test(email)) {
      throw new Error("Enter an email address");
    }
    if (!(await ctx.runQuery(internal.invites.roomExists, { roomId }))) {
      throw new Error("Unknown room");
    }
    await ctx.runQuery(internal.invites.assertInvitable, { email, roomId });

    const token = randomToken();
    const url = `${webUrl.replace(/\/+$/u, "")}/invite/${token}`;
    const users = await clerk(
      "GET",
      `/users?email_address=${encodeURIComponent(email)}`
    );
    let clerkInvitationId: string | undefined;
    if (Array.isArray(users) && users.length === 0) {
      const invitation = await clerk("POST", "/invitations", {
        email_address: email,
        ignore_existing: true,
        notify: true,
        redirect_url: url,
      });
      clerkInvitationId = invitationIdOf(invitation);
    }
    const inviteId: Id<"roomInvites"> = await ctx.runMutation(
      internal.invites.insert,
      {
        clerkInvitationId,
        email,
        roomId,
        tokenHash: await hashToken(token),
      }
    );
    return { emailed: clerkInvitationId !== undefined, inviteId, url };
  },
});

export const roomExists = internalQuery({
  args: { roomId: v.id("rooms") },
  handler: async (ctx, { roomId }) => (await ctx.db.get(roomId)) !== null,
});

export const assertInvitable = internalQuery({
  args: { email: v.string(), roomId: v.id("rooms") },
  handler: async (ctx, { email, roomId }) => {
    const members = await ctx.db
      .query("roomMembers")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    const emails = await Promise.all(
      members
        .filter((m) => m.removedAt === undefined)
        .map(async (m) => {
          const user = await ctx.db.get(m.userId);
          return user?.email?.toLowerCase();
        })
    );
    if (emails.includes(email)) {
      throw new Error(`${email} is already in this room.`);
    }
    const now = Date.now();
    const invites = await ctx.db
      .query("roomInvites")
      .withIndex("by_room", (q) => q.eq("roomId", roomId))
      .collect();
    if (
      invites.some(
        (i) => i.status === "pending" && i.expiresAt > now && i.email === email
      )
    ) {
      throw new Error(`${email} already has a pending invite.`);
    }
  },
});

export const insert = internalMutation({
  args: {
    clerkInvitationId: v.optional(v.string()),
    email: v.string(),
    roomId: v.id("rooms"),
    tokenHash: v.string(),
  },
  handler: async (ctx, args) => {
    const inviteId = await ctx.db.insert("roomInvites", {
      ...args,
      expiresAt: Date.now() + INVITE_LIFETIME_MS,
      status: "pending",
    });
    await record(ctx, {
      payload: { email: args.email },
      roomId: args.roomId,
      subjectId: inviteId,
      type: "invite.created",
    });
    return inviteId;
  },
});

// The row is revoked first, so the invite stops working at once. The Clerk
// invitation id is cleared only after Clerk confirms its revoke, so a revoke
// whose Clerk call failed can be run again.
export const revoke = action({
  args: { inviteId: v.id("roomInvites") },
  handler: async (ctx, { inviteId }) => {
    await requireOwner(ctx);
    const clerkInvitationId: string | null = await ctx.runMutation(
      internal.invites.markRevoked,
      { inviteId }
    );
    if (clerkInvitationId === null || clerkInvitationId === "") {
      return;
    }
    await clerk(
      "POST",
      `/invitations/${encodeURIComponent(clerkInvitationId)}/revoke`
    );
    await ctx.runMutation(internal.invites.clearClerkInvitation, {
      clerkInvitationId,
      inviteId,
    });
  },
});

// Returns the Clerk invitation still to revoke, if any. An invite already
// revoked whose Clerk invitation is still live returns it again.
export const markRevoked = internalMutation({
  args: { inviteId: v.id("roomInvites") },
  handler: async (ctx, { inviteId }) => {
    const invite = await ctx.db.get(inviteId);
    if (!invite) {
      throw new Error("Unknown invite");
    }
    if (
      invite.status === "revoked" &&
      invite.clerkInvitationId !== undefined &&
      invite.clerkInvitationId !== ""
    ) {
      return invite.clerkInvitationId;
    }
    if (invite.status !== "pending") {
      throw new Error(`This invite is already ${invite.status}`);
    }
    await ctx.db.patch(inviteId, { revokedAt: Date.now(), status: "revoked" });
    await record(ctx, {
      roomId: invite.roomId,
      subjectId: inviteId,
      type: "invite.revoked",
    });
    return invite.clerkInvitationId ?? null;
  },
});

export const clearClerkInvitation = internalMutation({
  args: { clerkInvitationId: v.string(), inviteId: v.id("roomInvites") },
  handler: async (ctx, { inviteId, clerkInvitationId }) => {
    const invite = await ctx.db.get(inviteId);
    if (invite?.clerkInvitationId === clerkInvitationId) {
      await ctx.db.patch(inviteId, { clerkInvitationId: undefined });
    }
  },
});

// What the invite page shows. An unknown token returns null and nothing else.
export const lookup = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const invite = await findInvite(ctx, token);
    if (!invite) {
      return null;
    }
    const room = await ctx.db.get(invite.roomId);
    const identity = await ctx.auth.getUserIdentity();
    return {
      email: maskEmail(invite.email),
      expiresAt: invite.expiresAt,
      matches: emailMatches(identity, invite.email),
      roomId: invite.roomId,
      roomName: room?.name ?? "",
      status:
        invite.status === "pending" && invite.expiresAt <= Date.now()
          ? ("expired" as const)
          : invite.status,
    };
  },
});

type AcceptResult =
  | { ok: true; roomId: Id<"rooms"> }
  | {
      ok: false;
      reason:
        | "not_found"
        | "expired"
        | "revoked"
        | "accepted"
        | "email_mismatch";
    };

// Rejections are returned rather than thrown, so an expiry found here is
// written to the invite row.
export const accept = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }): Promise<AcceptResult> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      throw new Error("Sign in to accept this invite");
    }
    const invite = await findInvite(ctx, token);
    if (!invite) {
      return { ok: false, reason: "not_found" };
    }
    if (!emailMatches(identity, invite.email)) {
      return { ok: false, reason: "email_mismatch" };
    }
    const user = await ensureUser(ctx);
    if (invite.status === "accepted") {
      return invite.acceptedByUserId === user._id
        ? { ok: true, roomId: invite.roomId }
        : { ok: false, reason: "accepted" };
    }
    if (invite.status !== "pending") {
      return { ok: false, reason: invite.status };
    }
    if (invite.expiresAt <= Date.now()) {
      await ctx.db.patch(invite._id, { status: "expired" });
      return { ok: false, reason: "expired" };
    }

    const { roomId } = invite;
    const existing = await ctx.db
      .query("roomMembers")
      .withIndex("by_room_user", (q) =>
        q.eq("roomId", roomId).eq("userId", user._id)
      )
      .unique();
    const joins = !existing || existing.removedAt !== undefined;
    const firstTeammate = joins && !(await hasActiveTeammate(ctx, roomId));
    let memberId = existing?._id;
    let participantId = existing?.participantId;
    if (!existing) {
      participantId = await ctx.db.insert("participants", {
        displayName: agentName(
          identity.name !== undefined && identity.name !== ""
            ? identity.name
            : identity.email
        ),
        kind: "human",
        roomId,
        userId: user._id,
      });
      memberId = await ctx.db.insert("roomMembers", {
        participantId,
        role: "member",
        roomId,
        userId: user._id,
      });
    } else if (existing.removedAt !== undefined) {
      await ctx.db.patch(existing._id, { removedAt: undefined });
    }
    await ctx.db.patch(invite._id, {
      acceptedAt: Date.now(),
      acceptedByUserId: user._id,
      status: "accepted",
    });
    if (joins) {
      const joinedLedgerId = await record(ctx, {
        actorParticipantId: participantId,
        payload: { inviteId: invite._id },
        roomId,
        subjectId: memberId,
        type: "member.joined",
      });
      if (firstTeammate) {
        await resetSoloFollowUpSessions(ctx, roomId, joinedLedgerId);
      }
    }
    return { ok: true, roomId };
  },
});
