import { reviewFinished } from './lib/review';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, mutation, query, type MutationCtx } from './_generated/server';
import { hasActiveTeammate, requireRunnerSecret } from './lib/auth';
import { dispatchNext, steerRejected } from './lib/dispatch';
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

// Claim a pending command. For run_turn, returns everything the runner needs
// for the turn. A control command (steer, answer, settings, interrupt) is for
// a turn that is already running: it returns the payload and takes no lease,
// and the runner reports back through commandHandled. Returns null if another
// claim got there first or the command no longer applies.
export const claim = mutation({
  args: { secret: v.string(), commandId: v.id('commands') },
  handler: async (ctx, { secret, commandId }) => {
    requireRunnerSecret(secret);
    const command = await ctx.db.get(commandId);
    if (!command || command.status !== 'pending') return null;
    if (command.type !== 'run_turn') {
      const target = await ctx.db.get(command.turnId);
      if (!target || target.status !== 'running') {
        await ctx.db.patch(commandId, { status: 'failed', error: 'Turn is not running' });
        return null;
      }
      await ctx.db.patch(commandId, { status: 'claimed' });
      return { commandId, type: command.type, turn: { id: target._id }, payload: command.payload };
    }
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
      type: 'run_turn' as const,
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
    // The streamed text stays on the turn, so the pane can keep showing it.
    await ctx.db.patch(args.turnId, {
      status: 'done',
      finalText: args.finalText,
      usage: args.usage,
      transcriptRef: args.transcriptRef,
      endedAt: Date.now(),
    });
    await ctx.db.patch(args.commandId, { status: 'done', leaseExpiresAt: undefined });
    if (args.sessionId && !turn.ritualId) await saveSession(ctx, turn, args.sessionId);

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
    if (!turn.ritualId) await dispatchNext(ctx, turn.participantId);
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
    const turns = claimed.filter((c) => c.type === 'run_turn');
    for (const command of turns) {
      await failTurn(ctx, command.turnId, command._id, 'Runner restarted during this turn', true, undefined, { runnerLost: true });
    }
    for (const command of claimed.filter((c) => c.type !== 'run_turn')) {
      const current = await ctx.db.get(command._id);
      if (current?.status === 'claimed') await ctx.db.patch(command._id, { status: 'failed', error: 'Runner restarted' });
    }
    return turns.length;
  },
});

// Runs every minute. A claimed run_turn whose lease has expired means the
// runner stopped renewing it: fail the turn as interrupted and move the
// agent's queue on. Control commands hold no lease and are never reclaimed.
export const reclaimExpiredLeases = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    let reclaimed = 0;
    for (const runner of await ctx.db.query('runners').collect()) {
      const claimed = await ctx.db
        .query('commands')
        .withIndex('by_runner_status', (q) => q.eq('runnerId', runner._id).eq('status', 'claimed'))
        .collect();
      for (const command of claimed) {
        if (command.type !== 'run_turn' || command.leaseExpiresAt === undefined || command.leaseExpiresAt > now) continue;
        const turn = await ctx.db.get(command.turnId);
        if (!turn || !['queued', 'running'].includes(turn.status)) {
          await ctx.db.patch(command._id, { status: 'failed', error: 'Lease expired', leaseExpiresAt: undefined });
          continue;
        }
        await failTurn(ctx, command.turnId, command._id, 'The runner stopped responding during this turn', true, undefined, { runnerLost: true });
        reclaimed++;
      }
    }
    return reclaimed;
  },
});

// The runner passed a control command to the running turn (ok) or could not.
export const commandHandled = mutation({
  args: { secret: v.string(), commandId: v.id('commands'), ok: v.boolean(), error: v.optional(v.string()) },
  handler: async (ctx, { secret, commandId, ok, error }) => {
    requireRunnerSecret(secret);
    const command = await ctx.db.get(commandId);
    if (!command || command.type === 'run_turn' || command.status !== 'claimed') return;
    await ctx.db.patch(commandId, ok ? { status: 'done' } : { status: 'failed', error: error ?? 'Turn is not running on the runner' });
    if (!ok && command.type === 'steer') {
      const messageId = command.payload?.messageId as Id<'messages'> | undefined;
      const message = messageId ? await ctx.db.get(messageId) : null;
      if (message) await steerRejected(ctx, message);
    }
  },
});

// The harness either took a steered message into the running turn or
// rejected it. A rejected message returns to the queue.
export const steerResult = mutation({
  args: { secret: v.string(), messageId: v.id('messages'), outcome: v.union(v.literal('steered'), v.literal('rejected')) },
  handler: async (ctx, { secret, messageId, outcome }) => {
    requireRunnerSecret(secret);
    const message = await ctx.db.get(messageId);
    if (!message || message.delivery !== 'steering' || !message.steering) return;
    if (outcome === 'rejected') return await steerRejected(ctx, message);
    const turnId = message.steering.turnId;
    await ctx.db.patch(messageId, { delivery: 'steered', deliveredTurnId: turnId, steering: undefined });
    const turn = await ctx.db.get(turnId);
    if (turn && !(turn.requestedByParticipantIds ?? []).includes(message.authorParticipantId)) {
      await ctx.db.patch(turnId, { requestedByParticipantIds: [...(turn.requestedByParticipantIds ?? []), message.authorParticipantId] });
    }
    await record(ctx, { roomId: message.roomId, type: 'message.steered', actorParticipantId: message.authorParticipantId, subjectId: messageId, payload: { turnId } });
  },
});

// Saves the harness session id as soon as the runner sees it, so a turn
// interrupted before it finishes can still be resumed. Follows the same rules
// as finish: reviews never save a session, and a follow-up in a shared room
// saves to its review.
export const sessionStarted = mutation({
  args: { secret: v.string(), turnId: v.id('turns'), sessionId: v.string() },
  handler: async (ctx, { secret, turnId, sessionId }) => {
    requireRunnerSecret(secret);
    const turn = await ctx.db.get(turnId);
    if (!turn || turn.ritualId || !['queued', 'running'].includes(turn.status)) return;
    await saveSession(ctx, turn, sessionId);
  },
});

async function saveSession(ctx: MutationCtx, turn: Doc<'turns'>, sessionId: string) {
  if (turn.followUp?.separateSession) await saveFollowUpSession(ctx, turn.followUp.ritualId, turn.participantId, sessionId);
  else await ctx.db.patch(turn.participantId, { harnessSessionId: sessionId });
}

async function failTurn(
  ctx: MutationCtx,
  turnId: Id<'turns'>,
  commandId: Id<'commands'>,
  error: string,
  interrupted: boolean,
  transcriptRef?: string,
  { runnerLost = false }: { runnerLost?: boolean } = {},
) {
  const turn = await ctx.db.get(turnId);
  if (!turn || !['queued', 'running'].includes(turn.status)) return;
  const command = await ctx.db.get(commandId);
  if (!command || command.turnId !== turnId || !['pending', 'claimed'].includes(command.status)) throw new Error('Invalid turn command');
  await ctx.db.patch(commandId, { status: 'failed', error, leaseExpiresAt: undefined });
  if (runnerLost) await abandonControlCommands(ctx, turn, command.runnerId, error);
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
  if (!turn.ritualId) await dispatchNext(ctx, turn.participantId);
}

// A runner that died or restarted will never answer the control commands it
// held for a turn, so its steers in flight go back to the queue.
async function abandonControlCommands(ctx: MutationCtx, turn: Doc<'turns'>, runnerId: Id<'runners'>, error: string) {
  for (const status of ['pending', 'claimed'] as const) {
    const commands = await ctx.db.query('commands').withIndex('by_runner_status', (q) => q.eq('runnerId', runnerId).eq('status', status)).collect();
    for (const c of commands) if (c.turnId === turn._id && c.type !== 'run_turn') await ctx.db.patch(c._id, { status: 'failed', error });
  }
  const steering = await ctx.db
    .query('messages')
    .withIndex('by_to_delivery', (q) => q.eq('toParticipantId', turn.participantId).eq('delivery', 'steering'))
    .collect();
  for (const m of steering) if (m.steering?.turnId === turn._id) await ctx.db.patch(m._id, { delivery: 'queued', steering: undefined });
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
