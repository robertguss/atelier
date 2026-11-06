import { reviewFinished } from './lib/review';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type MutationCtx } from './_generated/server';
import { hasActiveTeammate, requireRunnerSecret } from './lib/auth';
import { record } from './lib/ledger';

// Functions the runner calls. Each takes the runner secret instead of a Clerk
// session. See docs/v0-spec.md, "Runner ↔ Convex protocol".

const LEASE_MS = 5 * 60_000;

export const pendingCommands = query({
  args: { secret: v.string(), runnerId: v.id('runners') },
  handler: async (ctx, { secret, runnerId }) => {
    requireRunnerSecret(secret);
    return await ctx.db
      .query('commands')
      .withIndex('by_runner_status', (q) => q.eq('runnerId', runnerId).eq('status', 'pending'))
      .collect();
  },
});

// Claim a pending command. Returns everything the runner needs for the turn,
// or null if another claim got there first.
export const claim = mutation({
  args: { secret: v.string(), commandId: v.id('commands') },
  handler: async (ctx, { secret, commandId }) => {
    requireRunnerSecret(secret);
    const command = await ctx.db.get(commandId);
    if (!command || command.status !== 'pending') return null;
    await ctx.db.patch(commandId, { status: 'claimed', leaseExpiresAt: Date.now() + LEASE_MS });

    const turn = await ctx.db.get(command.turnId);
    if (!turn || turn.status !== 'queued') {
      await ctx.db.patch(commandId, { status: 'failed', error: 'Turn is no longer queued', leaseExpiresAt: undefined });
      return null;
    }
    const participant = await ctx.db.get(turn.participantId);
    const room = await ctx.db.get(turn.roomId);
    if (!participant || !room || !participant.harness) return null;

    let sessionId = turn.ritualId ? undefined : participant.harnessSessionId;
    if (turn.followUp && !turn.ritualId) {
      // With a teammate in the room, a follow-up must not continue the
      // ordinary session, or the agent would later repeat the review to them.
      // The choice is fixed here so finish saves to the session it resumed.
      const separateSession = await hasActiveTeammate(ctx, room._id);
      await ctx.db.patch(turn._id, { followUp: { ...turn.followUp, separateSession } });
      if (separateSession) {
        const ritual = await ctx.db.get(turn.followUp.ritualId);
        sessionId = ritual ? followUpSession(ritual, participant._id) : undefined;
      }
    }

    return {
      commandId,
      type: command.type,
      turn: { id: turn._id, prompt: turn.prompt, independentReview: !!turn.ritualId, ritualId: turn.ritualId },
      participant: {
        id: participant._id,
        harness: participant.harness,
        model: participant.model,
        reasoning: participant.reasoning,
        sessionId,
      },
      room: { id: room._id, cwd: room.cwd, name: room.name, handbook: room.handbook },
    };
  },
});

export const start = mutation({
  args: { secret: v.string(), turnId: v.id('turns'), harnessVersion: v.string() },
  handler: async (ctx, { secret, turnId, harnessVersion }) => {
    requireRunnerSecret(secret);
    const turn = await ctx.db.get(turnId);
    if (!turn || !['queued', 'running'].includes(turn.status)) return;
    await ctx.db.patch(turnId, { status: 'running', startedAt: Date.now(), harnessVersion });
    await record(ctx, {
      roomId: turn.roomId,
      type: 'turn.started',
      actorParticipantId: turn.participantId,
      subjectId: turnId,
      harnessVersion,
    });
  },
});

// Throttled by the runner to about two writes a second. Also renews the lease.
export const progress = mutation({
  args: { secret: v.string(), turnId: v.id('turns'), commandId: v.id('commands'), partialText: v.string() },
  handler: async (ctx, { secret, turnId, commandId, partialText }) => {
    requireRunnerSecret(secret);
    const turn = await ctx.db.get(turnId);
    if (!turn || turn.status !== 'running') return false;
    const command = await ctx.db.get(commandId);
    if (!command || command.turnId !== turnId || command.status !== 'claimed') return false;
    await ctx.db.patch(turnId, { partialText });
    await ctx.db.patch(commandId, { leaseExpiresAt: Date.now() + LEASE_MS });
    return true;
  },
});

export const finish = mutation({
  args: {
    secret: v.string(),
    turnId: v.id('turns'),
    commandId: v.id('commands'),
    finalText: v.string(),
    sessionId: v.optional(v.string()),
    model: v.optional(v.string()),
    usage: v.optional(v.object({ inputTokens: v.number(), outputTokens: v.number(), costUsd: v.optional(v.number()) })),
    transcriptRef: v.string(),
  },
  handler: async (ctx, args) => {
    requireRunnerSecret(args.secret);
    const turn = await ctx.db.get(args.turnId);
    if (!turn || !['queued', 'running'].includes(turn.status)) return;
    const command = await ctx.db.get(args.commandId);
    if (!command || command.turnId !== args.turnId || command.status !== 'claimed') throw new Error('Invalid turn command');
    await ctx.db.patch(args.turnId, {
      status: 'done',
      finalText: args.finalText,
      partialText: undefined,
      usage: args.usage,
      transcriptRef: args.transcriptRef,
      endedAt: Date.now(),
    });
    await ctx.db.patch(args.commandId, { status: 'done', leaseExpiresAt: undefined });
    if (args.sessionId && !turn.ritualId) {
      if (turn.followUp?.separateSession) await saveFollowUpSession(ctx, turn.followUp.ritualId, turn.participantId, args.sessionId);
      else await ctx.db.patch(turn.participantId, { harnessSessionId: args.sessionId });
    }

    const messageId = await ctx.db.insert('messages', {
      roomId: turn.roomId,
      authorParticipantId: turn.participantId,
      body: args.finalText,
      turnId: args.turnId,
      ritualId: turn.ritualId,
      visibility: turn.ritualId ? 'sealed' : 'room',
      followUpRitualId: turn.followUp?.ritualId,
    });
    await reviewFinished(ctx, turn);
    const participant = await ctx.db.get(turn.participantId);
    await record(ctx, {
      roomId: turn.roomId,
      type: 'turn.finished',
      actorParticipantId: turn.participantId,
      subjectId: args.turnId,
      provider: providerOf(participant?.harness),
      model: args.model,
      harnessVersion: turn.harnessVersion,
      payload: { messageId, usage: args.usage, transcriptRef: args.transcriptRef },
    });
  },
});

export const fail = mutation({
  args: {
    secret: v.string(),
    turnId: v.id('turns'),
    commandId: v.id('commands'),
    error: v.string(),
    interrupted: v.optional(v.boolean()),
    transcriptRef: v.optional(v.string()),
  },
  handler: async (ctx, { secret, turnId, commandId, error, interrupted, transcriptRef }) => {
    requireRunnerSecret(secret);
    await failTurn(ctx, turnId, commandId, error, interrupted ?? false, transcriptRef);
  },
});

// On startup the runner marks its own unfinished work as interrupted.
export const recover = mutation({
  args: { secret: v.string(), runnerId: v.id('runners') },
  handler: async (ctx, { secret, runnerId }) => {
    requireRunnerSecret(secret);
    const claimed = await ctx.db
      .query('commands')
      .withIndex('by_runner_status', (q) => q.eq('runnerId', runnerId).eq('status', 'claimed'))
      .collect();
    for (const command of claimed) {
      await failTurn(ctx, command.turnId, command._id, 'Runner restarted during this turn', true);
    }
    return claimed.length;
  },
});

async function failTurn(
  ctx: MutationCtx,
  turnId: Id<'turns'>,
  commandId: Id<'commands'>,
  error: string,
  interrupted: boolean,
  transcriptRef?: string,
) {
  const turn = await ctx.db.get(turnId);
  if (!turn || !['queued', 'running'].includes(turn.status)) return;
  const command = await ctx.db.get(commandId);
  if (!command || command.turnId !== turnId || !['pending', 'claimed'].includes(command.status)) throw new Error('Invalid turn command');
  await ctx.db.patch(commandId, { status: 'failed', error, leaseExpiresAt: undefined });
  await ctx.db.patch(turnId, {
    status: interrupted && !turn.ritualId ? 'interrupted' : 'failed',
    error,
    transcriptRef,
    endedAt: Date.now(),
  });
  await reviewFinished(ctx, turn);
  await record(ctx, {
    roomId: turn.roomId,
    type: interrupted ? 'turn.interrupted' : 'turn.failed',
    actorParticipantId: turn.participantId,
    subjectId: turnId,
    harnessVersion: turn.harnessVersion,
    payload: { error },
  });
}

function followUpSession(ritual: Doc<'rituals'>, participantId: Id<'participants'>) {
  return ritual.followUpSessions?.find((s) => s.participantId === participantId)?.sessionId;
}

async function saveFollowUpSession(ctx: MutationCtx, ritualId: Id<'rituals'>, participantId: Id<'participants'>, sessionId: string) {
  const ritual = await ctx.db.get(ritualId);
  if (!ritual) return;
  const others = (ritual.followUpSessions ?? []).filter((s) => s.participantId !== participantId);
  await ctx.db.patch(ritualId, { followUpSessions: [...others, { participantId, sessionId }] });
}

function providerOf(harness: string | undefined) {
  if (harness === 'claude') return 'anthropic';
  if (harness === 'codex') return 'openai';
  return harness;
}

export const prepareReview = mutation({
  args: { secret: v.string(), ritualId: v.id('rituals'), snapshot: v.string() },
  handler: async (ctx, { secret, ritualId, snapshot }) => {
    requireRunnerSecret(secret);
    const ritual = await ctx.db.get(ritualId);
    if (!ritual || ritual.status !== 'collecting') throw new Error('Review is no longer collecting');
    const existing = await ctx.db.query('reviewSnapshots').withIndex('by_ritual', q => q.eq('ritualId', ritualId)).unique();
    if (existing) return existing.text;
    if (ritual.snapshot !== undefined) return ritual.snapshot; // Early development rituals.
    if (snapshot.length > 400_000) throw new Error('Review snapshot too large');
    await ctx.db.insert('reviewSnapshots', { ritualId, text: snapshot });
    return snapshot;
  },
});
