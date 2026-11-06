import { v } from 'convex/values';
import { mutation, query } from './_generated/server';
import { requireOwner } from './lib/auth';
import { record } from './lib/ledger';

export const list = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    const rooms = await ctx.db.query('rooms').order('desc').collect();
    return rooms.filter((r) => r.archivedAt === undefined);
  },
});

export const get = query({
  args: { roomId: v.id('rooms') },
  handler: async (ctx, { roomId }) => {
    await requireOwner(ctx);
    const room = await ctx.db.get(roomId);
    if (!room) return null;
    const participants = await ctx.db
      .query('participants')
      .withIndex('by_room', (q) => q.eq('roomId', roomId))
      .collect();
    return { room, participants };
  },
});

// Step 2: a room starts with the owner and a Claude Code participant.
// Codex and Pi join in step 3.
export const create = mutation({
  args: { name: v.string(), runnerId: v.id('runners'), cwd: v.string() },
  handler: async (ctx, { name, runnerId, cwd }) => {
    const owner = await requireOwner(ctx);
    const runner = await ctx.db.get(runnerId);
    if (!runner) throw new Error('Unknown runner');

    const roomId = await ctx.db.insert('rooms', { name: name.trim(), runnerId, cwd: cwd.trim(), handbook: '' });
    const created = await record(ctx, { roomId, type: 'room.created', subjectId: roomId, payload: { name, cwd, runner: runner.name } });

    const humanId = await ctx.db.insert('participants', {
      roomId,
      kind: 'human',
      displayName: owner.name ?? owner.email ?? 'You',
    });
    await record(ctx, { roomId, type: 'participant.joined', subjectId: humanId, parentLedgerId: created, payload: { kind: 'human' } });

    const claudeId = await ctx.db.insert('participants', {
      roomId,
      kind: 'harness',
      harness: 'claude',
      displayName: 'Claude',
    });
    await record(ctx, {
      roomId,
      type: 'participant.joined',
      subjectId: claudeId,
      parentLedgerId: created,
      provider: 'anthropic',
      payload: { kind: 'harness', harness: 'claude' },
    });

    return roomId;
  },
});

export const addParticipant = mutation({
  args: { roomId: v.id('rooms'), harness: v.union(v.literal('claude'), v.literal('codex'), v.literal('pi')) },
  handler: async (ctx, { roomId, harness }) => {
    await requireOwner(ctx);
    const room = await ctx.db.get(roomId);
    if (!room) throw new Error('Unknown room');
    const existing = await ctx.db.query('participants').withIndex('by_room', q => q.eq('roomId', roomId)).collect();
    const found = existing.find(p => p.harness === harness);
    if (found) return found._id;
    const runner = await ctx.db.get(room.runnerId);
    if (!runner?.harnesses.some(h => h.id === harness)) throw new Error('Harness unavailable on this runner');
    const id = await ctx.db.insert('participants', { roomId, kind: 'harness', harness, displayName: { claude: 'Claude', codex: 'Codex', pi: 'Pi' }[harness] });
    await record(ctx, { roomId, type: 'participant.joined', subjectId: id, payload: { kind: 'harness', harness } });
    return id;
  },
});
