import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { findLedger, record } from './ledger';
import { contextBlock, loadRoomContext, renderMention, renderMessage, roomMembers, turnPrompt } from './prompt';

// Each agent has at most one active ordinary turn. Messages sent while it
// works wait as `queued` and go in together, in send order, as the next turn.
// Independent review turns stay outside this queue. A thread delivery, a
// person's comment that @mentions the agent, waits in the same queue but
// always runs as its own turn.

const HEARTBEAT_MS = 15_000;
export const OFFLINE_AFTER_MS = 3 * HEARTBEAT_MS;

export function runnerOnline(runner: Doc<'runners'> | null) {
  return !!runner && Date.now() - runner.lastHeartbeatAt <= OFFLINE_AFTER_MS;
}

export function offlineReason(runner: Doc<'runners'> | null) {
  return `The runner${runner ? ` "${runner.name}"` : ''} is offline: no heartbeat in the last 45 seconds, so agents cannot receive messages.`;
}

export async function requireRunnerOnline(ctx: QueryCtx, room: Doc<'rooms'> | null): Promise<Doc<'rooms'>> {
  const runner = room ? await ctx.db.get(room.runnerId) : null;
  if (!room || !runnerOnline(runner)) throw new Error(offlineReason(runner));
  return room;
}

export function isActiveTurnStatus(status: Doc<'turns'>['status']) {
  return status === 'queued' || status === 'running';
}

export async function activeOrdinaryTurn(ctx: QueryCtx, participantId: Id<'participants'>) {
  const oldest = (status: 'queued' | 'running') =>
    ctx.db
      .query('turns')
      .withIndex('by_participant_status', (q) => q.eq('participantId', participantId).eq('status', status))
      .filter((q) => q.eq(q.field('ritualId'), undefined))
      .first();
  const queued = await oldest('queued');
  const running = await oldest('running');
  if (queued && running) return queued._creationTime < running._creationTime ? queued : running;
  return queued ?? running;
}

// A steer still in flight waits for the runner's verdict. Once its turn has
// ended and the runner is no longer holding it, the message counts as queued.
async function steerIsStale(ctx: QueryCtx, message: Doc<'messages'>) {
  if (!message.steering) return true;
  const turn = await ctx.db.get(message.steering.turnId);
  if (turn && isActiveTurnStatus(turn.status)) return false;
  const command = await ctx.db.get(message.steering.commandId);
  return !command || command.status === 'pending' || command.status === 'failed';
}

async function waitingMessages(ctx: QueryCtx, participantId: Id<'participants'>) {
  const byState = (delivery: 'queued' | 'steering') =>
    ctx.db.query('messages').withIndex('by_to_delivery', (q) => q.eq('toParticipantId', participantId).eq('delivery', delivery)).collect();
  const queued = await byState('queued');
  const stale = [];
  for (const m of await byState('steering')) if (await steerIsStale(ctx, m)) stale.push(m);
  return [...queued, ...stale].sort((a, b) => a._creationTime - b._creationTime);
}

export async function cancelMessage(ctx: MutationCtx, message: Doc<'messages'>, reason: string, actorParticipantId?: Id<'participants'>) {
  await ctx.db.patch(message._id, { delivery: 'cancelled', cancelReason: reason, steering: undefined });
  await record(ctx, { roomId: message.roomId, type: 'message.cancelled', actorParticipantId, subjectId: message._id, payload: { reason } });
}

// Start the agent's next turn from everything waiting for it, if it is idle.
// A follow-up to a review or decision, and a thread delivery, always run
// alone. With the runner offline, waiting chat messages are cancelled
// instead; thread deliveries stay queued until the runner is back. Returns
// the new turn.
export async function dispatchNext(ctx: MutationCtx, participantId: Id<'participants'>): Promise<Id<'turns'> | null> {
  const participant = await ctx.db.get(participantId);
  if (!participant || participant.kind !== 'harness') return null;
  if (await activeOrdinaryTurn(ctx, participantId)) return null;
  const waiting = await waitingMessages(ctx, participantId);
  if (waiting.length === 0) return null;

  const room = await ctx.db.get(participant.roomId);
  const runner = room ? await ctx.db.get(room.runnerId) : null;
  if (!room || !runnerOnline(runner)) {
    for (const m of waiting) if (!m.threadId) await cancelMessage(ctx, m, 'runner offline');
    return null;
  }

  const first = waiting[0]!;
  const runsAlone = (m: Doc<'messages'>) => !!m.followUpRitualId || !!m.threadId;
  const batch = runsAlone(first) ? [first] : takeWhile(waiting, (m) => !runsAlone(m));
  const members = await roomMembers(ctx, room._id);
  const messages = [];
  if (first.threadId) messages.push(await renderMention(ctx, first, members));
  else for (const m of batch) messages.push(await renderMessage(ctx, m, 'queued', members));
  const previous = await ctx.db
    .query('turns')
    .withIndex('by_participant', (q) => q.eq('participantId', participantId))
    .order('desc')
    .filter((q) => q.eq(q.field('ritualId'), undefined))
    .first();
  const stopper = previous?.status === 'interrupted' && previous.stoppedByParticipantId ? await ctx.db.get(previous.stoppedByParticipantId) : null;
  const prompt = turnPrompt({ context: contextBlock(await loadRoomContext(ctx, room, members)), stoppedBy: stopper?.displayName, messages });

  const turnId = await ctx.db.insert('turns', {
    roomId: room._id,
    participantId,
    status: 'queued',
    prompt,
    followUp: first.followUpRitualId ? { ritualId: first.followUpRitualId, decisionId: first.followUpDecisionId } : undefined,
    requestedByParticipantIds: [...new Set(batch.map((m) => m.authorParticipantId))],
    editsEnabled: room.editsEnabled === true,
    threadId: first.threadId,
  });
  await ctx.db.insert('commands', { runnerId: room.runnerId, type: 'run_turn', turnId, status: 'pending' });
  const messageLedgerIds = [];
  for (const m of batch) {
    await ctx.db.patch(m._id, { delivery: 'delivered', deliveredTurnId: turnId, steering: undefined });
    const posted = m.commentId
      ? await findLedger(ctx, m.roomId, 'document.comment_posted', m.commentId)
      : await findLedger(ctx, m.roomId, 'message.posted', m._id);
    if (posted) messageLedgerIds.push(posted._id);
  }
  await record(ctx, {
    roomId: room._id,
    type: 'turn.queued',
    actorParticipantId: participantId,
    subjectId: turnId,
    parentLedgerId: messageLedgerIds[0],
    model: participant.model,
    payload: { messageLedgerIds },
  });
  return turnId;
}

// Only a running ordinary turn takes a steer. A follow-up to a review or
// decision, and a turn answering a thread mention, always run as their own
// turn, so they neither take nor give one.
export function takesSteer(turn: Doc<'turns'> | null): turn is Doc<'turns'> {
  return turn?.status === 'running' && !turn.followUp && !turn.threadId;
}

// The runner is back online: every agent in its rooms with a thread delivery
// that waited for it gets its next turn.
export async function dispatchWaitingMentions(ctx: MutationCtx, runnerId: Id<'runners'>) {
  const rooms = await ctx.db.query('rooms').withIndex('by_runner', (q) => q.eq('runnerId', runnerId)).collect();
  for (const room of rooms) {
    const participants = await ctx.db.query('participants').withIndex('by_room', (q) => q.eq('roomId', room._id)).collect();
    for (const p of participants.filter((p) => p.kind === 'harness')) {
      const waiting = await ctx.db
        .query('messages')
        .withIndex('by_to_delivery', (q) => q.eq('toParticipantId', p._id).eq('delivery', 'queued'))
        .filter((q) => q.neq(q.field('threadId'), undefined))
        .first();
      if (waiting) await dispatchNext(ctx, p._id);
    }
  }
}

// "Steer now": hand a waiting message to the runner for the agent's running
// turn. The runner reports the harness's verdict through steerResult.
export async function steerMessage(ctx: MutationCtx, message: Doc<'messages'>, turn: Doc<'turns'>, runnerId: Id<'runners'>, actorParticipantId: Id<'participants'>) {
  const commandId = await ctx.db.insert('commands', {
    runnerId,
    type: 'steer',
    turnId: turn._id,
    status: 'pending',
    payload: { messageId: message._id, text: await renderMessage(ctx, message, 'steered') },
  });
  await ctx.db.patch(message._id, { delivery: 'steering', steering: { turnId: turn._id, commandId } });
  await record(ctx, { roomId: message.roomId, type: 'message.steer_requested', actorParticipantId, subjectId: message._id, payload: { turnId: turn._id } });
}

// The runner could not put a steered message into the running turn. It goes
// back to the queue, and starts a turn now if the agent is already idle.
export async function steerRejected(ctx: MutationCtx, message: Doc<'messages'>) {
  if (message.delivery !== 'steering' || !message.toParticipantId) return;
  await ctx.db.patch(message._id, { delivery: 'queued', steering: undefined });
  await record(ctx, { roomId: message.roomId, type: 'message.steer_rejected', subjectId: message._id });
  await dispatchNext(ctx, message.toParticipantId);
}

function takeWhile<T>(items: T[], keep: (item: T) => boolean) {
  const out = [];
  for (const item of items) {
    if (!keep(item)) break;
    out.push(item);
  }
  return out;
}
