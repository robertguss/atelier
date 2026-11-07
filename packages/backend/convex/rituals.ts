import { v } from 'convex/values';
import { WorkflowManager, start } from '@convex-dev/workflow';
import { components, internal } from './_generated/api';
import { mutation, query, internalMutation } from './_generated/server';
import { requireMember, requireOwner } from './lib/auth';
import { record } from './lib/ledger';

const workflow = new WorkflowManager(components.workflow);
export const collect = workflow.define({ args: { ritualId: v.id('rituals'), turnIds: v.array(v.id('turns')) }, returns: v.null() }).handler(async (step, { ritualId, turnIds }): Promise<null> => {
  for (const id of turnIds) await step.awaitEvent({ name: id });
  await step.runMutation(internal.rituals.reveal, { ritualId });
  await step.runAction(internal.push.send, { ritualId }, { retry: { maxAttempts: 3, initialBackoffMs: 1000, base: 2 } });
  return null;
});
export const reveal = internalMutation({
  args: { ritualId: v.id('rituals') },
  handler: async (ctx, { ritualId }): Promise<boolean> => {
    const ritual = await ctx.db.get(ritualId);
    if (!ritual || ritual.status !== 'collecting') return true;
    const turns = await ctx.db.query('turns').withIndex('by_ritual', q => q.eq('ritualId', ritualId)).collect();
    if (turns.length !== ritual.participantIds.length || turns.some(t => ['queued', 'running'].includes(t.status))) return false;
    await ctx.db.patch(ritualId, { status: 'revealed', revealedAt: Date.now(), pushStatus: 'queued' });
    for (const message of await ctx.db.query('messages').withIndex('by_ritual', q => q.eq('ritualId', ritualId)).collect()) await ctx.db.patch(message._id, { visibility: 'room' });
    await record(ctx, { roomId: ritual.roomId, type: 'ritual.revealed', subjectId: ritualId });
    return true;
  },
});
export const begin = mutation({
  args: { roomId: v.id('rooms'), request: v.string(), participantIds: v.array(v.id('participants')) },
  handler: async (ctx, { roomId, request, participantIds }) => {
    const owner = await requireOwner(ctx);
    const room = await ctx.db.get(roomId);
    if (!room || room.archivedAt !== undefined || request.length > 50_000 || !request.trim() || !participantIds.length || new Set(participantIds).size !== participantIds.length) throw new Error('Choose participants and enter a request');
    const participants = await Promise.all(participantIds.map(id => ctx.db.get(id)));
    if (participants.some(p => !p || p.roomId !== roomId || p.kind !== 'harness')) throw new Error('Invalid participant');
    const { participant: human } = await requireMember(ctx, roomId);
    const ritualId = await ctx.db.insert('rituals', { roomId, request: request.trim(), participantIds, type: 'independent_review', status: 'collecting', ownerSubject: owner.subject });
    const parentLedgerId = await record(ctx, { roomId, type: 'ritual.started', subjectId: ritualId, actorParticipantId: human._id });
    const decisions = await ctx.db.query('decisions').withIndex('by_room', q => q.eq('roomId', roomId)).order('desc').take(10);
    const prompt = `Independent read-only review. Write your own answer. Do not seek other participants' answers.\nRoom: ${room.name}\nHandbook:\n${room.handbook}\nRecent decisions:\n${decisions.map(d => d.choice + ': ' + (d.rationale ?? '')).join('\n')}\nRequest:\n${request.trim()}`;
    const turnIds = [];
    for (const participantId of participantIds) {
      const turnId = await ctx.db.insert('turns', { roomId, ritualId, participantId, prompt, status: 'queued' });
      turnIds.push(turnId);
      await ctx.db.insert('commands', { runnerId: room.runnerId, type: 'run_turn', turnId, status: 'pending' });
      await record(ctx, { roomId, type: 'turn.queued', subjectId: turnId, actorParticipantId: participantId, parentLedgerId });
    }
    const workflowId = await start(ctx, internal.rituals.collect, { ritualId, turnIds });
    await ctx.db.patch(ritualId, { workflowId });
    return ritualId;
  },
});
export const list = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    await requireOwner(ctx);
    return (await ctx.db.query('rituals').withIndex('by_room', q => q.eq('roomId', roomId)).order('desc').collect()).map(r => ({ _id: r._id, request: r.request, status: r.status }));
  },
});
export const get = query({
  args: { ritualId: v.id('rituals') },
  handler: async (ctx, { ritualId }) => {
    await requireOwner(ctx);
    const ritual = await ctx.db.get(ritualId);
    if (!ritual) return null;
    const participants = await ctx.db.query('participants').withIndex('by_room', q => q.eq('roomId', ritual.roomId)).collect();
    const turns = await ctx.db.query('turns').withIndex('by_ritual', q => q.eq('ritualId', ritualId)).collect();
    const cruxes = await ctx.db.query('cruxes').withIndex('by_ritual', q => q.eq('ritualId', ritualId)).collect();
    const decisions = (await ctx.db.query('decisions').withIndex('by_room', q => q.eq('roomId', ritual.roomId)).collect()).filter(d => d.ritualId === ritualId);
    return {
      _id: ritualId, roomId: ritual.roomId, request: ritual.request, status: ritual.status, pushStatus: ritual.pushStatus, cruxes, decisions,
      takeaways: await ctx.db.query('takeaways').withIndex('by_ritual', q => q.eq('ritualId', ritualId)).collect(),
      turns: turns.map(t => ({ _id: t._id, participantId: t.participantId, name: participants.find(p => p._id === t.participantId)?.displayName ?? 'Participant', status: t.status,
        ...(ritual.status !== 'collecting' ? { answer: t.finalText, error: t.error } : {}),
      })),
    };
  },
});
export const recordCrux = mutation({
  args: { ritualId: v.id('rituals'), statement: v.string(), options: v.array(v.string()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const ritual = await ctx.db.get(args.ritualId);
    if (!ritual || ritual.status !== 'revealed' || !args.statement.trim()) throw new Error('A revealed review and crux are required');
    const { participant: human } = await requireMember(ctx, ritual.roomId);
    const id = await ctx.db.insert('cruxes', { ...args, roomId: ritual.roomId, authorParticipantId: human._id });
    await record(ctx, { roomId: ritual.roomId, type: 'crux.recorded', subjectId: id, actorParticipantId: human._id });
    return id;
  },
});
export const decide = mutation({
  args: { ritualId: v.id('rituals'), choice: v.string(), rationale: v.string() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const ritual = await ctx.db.get(args.ritualId);
    if (!ritual || ritual.status !== 'revealed' || !args.choice.trim()) throw new Error('A revealed review and decision are required');
    const cruxes = await ctx.db.query('cruxes').withIndex('by_ritual', q => q.eq('ritualId', args.ritualId)).collect();
    if (!cruxes.length) throw new Error('Record a crux first');
    const { participant: human } = await requireMember(ctx, ritual.roomId);
    const id = await ctx.db.insert('decisions', { ...args, roomId: ritual.roomId });
    await ctx.db.patch(ritual._id, { status: 'decided' });
    await record(ctx, { roomId: ritual.roomId, type: 'decision.recorded', subjectId: id, actorParticipantId: human._id });
  },
});

export const saveTakeaway = mutation({
  args: { ritualId: v.id('rituals'), body: v.string() },
  handler: async (ctx, { ritualId, body }) => {
    await requireOwner(ctx);
    const ritual = await ctx.db.get(ritualId);
    if (!ritual || ritual.status === 'collecting') throw new Error('Wait until the review finishes');
    const text = body.trim();
    if (!text || text.length > 10_000) throw new Error('Enter a takeaway of at most 10,000 characters');
    const { participant: human } = await requireMember(ctx, ritual.roomId);
    const id = await ctx.db.insert('takeaways', { ritualId, body: text, authorParticipantId: human._id });
    await record(ctx, { roomId: ritual.roomId, type: 'takeaway.recorded', subjectId: id, actorParticipantId: human._id });
    return id;
  },
});
