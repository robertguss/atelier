/// <reference types="vite/client" />
import { convexTest } from 'convex-test';
import workflow from '@convex-dev/workflow/test';
import { beforeEach, afterEach, test, expect, vi } from 'vitest';
import schema from '../convex/schema';
import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { insertBlock, openChangeSet, orderBetween, patchBlock } from '../convex/lib/document';
const modules = import.meta.glob('../convex/**/*.ts');

beforeEach(() => {
  vi.useFakeTimers();
  process.env.ATELIER_OWNER_EMAILS = 'owner@example.com';
  process.env.ATELIER_RUNNER_SECRET = 'test-secret';
  process.env.CLERK_SECRET_KEY = 'sk_test';
  process.env.ATELIER_WEB_URL = 'https://atelier.example.com/';
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const SECTIONS = [
  { heading: 'Goal', guidance: 'What are we trying to change, and for whom?' },
  { heading: 'Risks' },
  { heading: 'Next steps', guidance: 'Who does what by when.' },
];

async function setup() {
  const t = convexTest(schema, modules); workflow.register(t);
  const owner = t.withIdentity({ email: 'owner@example.com', subject: 'owner', name: 'Robert' });
  const dana = t.withIdentity({ email: 'dana@example.com', subject: 'dana', name: 'Dana' });
  const runnerId = await t.mutation(api.runners.heartbeat, { secret: 'test-secret', name: 'test', machine: 'test', harnesses: [{ id: 'claude', version: 'test' }] });
  return { t, owner, dana, runnerId };
}

async function roomWithTeammate(s: Awaited<ReturnType<typeof setup>>, templateId?: Id<'templates'>) {
  const roomId = await s.owner.mutation(api.rooms.create, { name: 'Planning', runnerId: s.runnerId, cwd: '/tmp/planning', templateId });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json([{ id: 'user_1' }])));
  const invite = await s.owner.action(api.invites.create, { roomId, email: 'dana@example.com' });
  await s.dana.mutation(api.invites.accept, { token: invite.url.split('/invite/')[1]! });
  vi.unstubAllGlobals();
  const participants = (await s.owner.query(api.rooms.get, { roomId }))!.participants;
  return {
    roomId,
    robert: participants.find(p => p.displayName === 'Robert')!,
    danaParticipant: participants.find(p => p.displayName === 'Dana')!,
    claude: participants.find(p => p.harness === 'claude')!,
  };
}

test('the owner creates, lists, updates and removes templates, and a removed template cannot seed a room', async () => {
  const { owner, runnerId } = await setup();
  expect(await owner.query(api.templates.list, {})).toEqual([]);
  const templateId = await owner.mutation(api.templates.create, { name: '  Discovery  ', sections: [{ heading: ' Goal ', guidance: '  ' }] });
  expect((await owner.query(api.templates.list, {})).map(x => [x._id, x.name, x.sections])).toEqual([[templateId, 'Discovery', [{ heading: 'Goal' }]]]);

  await owner.mutation(api.templates.update, { templateId, name: 'Discovery v2', sections: SECTIONS });
  expect((await owner.query(api.templates.list, {})).map(x => [x.name, x.sections])).toEqual([['Discovery v2', SECTIONS]]);
  await expect(owner.mutation(api.templates.update, { templateId, name: ' ', sections: SECTIONS })).rejects.toThrow('needs a name');
  await expect(owner.mutation(api.templates.create, { name: 'Blank heading', sections: [{ heading: '  ' }] })).rejects.toThrow('heading');

  await owner.mutation(api.templates.remove, { templateId });
  expect(await owner.query(api.templates.list, {})).toEqual([]);
  await expect(owner.mutation(api.rooms.create, { name: 'Late', runnerId, cwd: '/tmp/late', templateId })).rejects.toThrow('Unknown template');
});

test('a teammate calling any template function is refused because only the owner can manage templates', async () => {
  const s = await setup();
  const templateId = await s.owner.mutation(api.templates.create, { name: 'Discovery', sections: SECTIONS });
  const { roomId } = await roomWithTeammate(s);
  const refusal = 'Only the owner can manage templates';
  await expect(s.dana.query(api.templates.list, {})).rejects.toThrow(refusal);
  await expect(s.dana.mutation(api.templates.create, { name: 'Mine', sections: SECTIONS })).rejects.toThrow(refusal);
  await expect(s.dana.mutation(api.templates.update, { templateId, name: 'Taken', sections: [] })).rejects.toThrow(refusal);
  await expect(s.dana.mutation(api.templates.remove, { templateId })).rejects.toThrow(refusal);
  await expect(s.dana.mutation(api.templates.saveFromRoom, { roomId, name: 'Copied' })).rejects.toThrow(refusal);
  expect((await s.owner.query(api.templates.list, {})).map(x => [x.name, x.sections])).toEqual([['Discovery', SECTIONS]]);
});

test('creating a room with a chosen template seeds its headings and guidance in order, attributed to Robert, in one change set', async () => {
  const s = await setup();
  const templateId = await s.owner.mutation(api.templates.create, { name: 'Discovery', sections: SECTIONS });
  const { roomId, robert } = await roomWithTeammate(s, templateId);
  const robertAuthor = { kind: 'participant', participantId: robert._id };
  const doc = (await s.dana.query(api.documents.get, { roomId }))!;
  expect(doc.blocks.map(b => [b.kind, b.text, b.author])).toEqual([
    ['heading', 'Goal', robertAuthor],
    ['paragraph', 'What are we trying to change, and for whom?', robertAuthor],
    ['heading', 'Risks', robertAuthor],
    ['heading', 'Next steps', robertAuthor],
    ['paragraph', 'Who does what by when.', robertAuthor],
  ]);
  await s.t.run(async ctx => {
    expect((await ctx.db.query('documents').collect()).map(d => d.templateId)).toEqual([templateId]);
    expect((await ctx.db.query('changeSets').collect()).map(c => [c.kind, c.revisionCount])).toEqual([['template_seed', 5]]);
    const changed = (await ctx.db.query('ledger').collect()).filter(e => e.type === 'document.changed');
    expect(changed).toHaveLength(1);
    expect(JSON.stringify(changed)).not.toContain('Who does what');
  });
});

test('saving a room as a template copies its headings and template guidance, but no paragraph a model or person wrote', async () => {
  const s = await setup();
  const templateId = await s.owner.mutation(api.templates.create, { name: 'Discovery', sections: SECTIONS });
  const { roomId, robert, danaParticipant, claude } = await roomWithTeammate(s, templateId);
  const doc = (await s.owner.query(api.documents.get, { roomId }))!;
  const [goal, goalGuidance, risks, nextSteps, nextGuidance] = doc.blocks;

  await s.t.run(async ctx => {
    const model = await openChangeSet(ctx, doc.documentId, { kind: 'model_turn', actorParticipantId: claude._id });
    await insertBlock(ctx, model, { order: orderBetween(goalGuidance!.order, risks!.order), kind: 'paragraph', text: 'MODEL-FINDING the cache is cold', author: { kind: 'participant', participantId: claude._id } });
    await insertBlock(ctx, model, { order: orderBetween(risks!.order, nextSteps!.order), kind: 'listItem', text: 'MODEL-RISK migrations', author: { kind: 'participant', participantId: claude._id } });
    const person = await openChangeSet(ctx, doc.documentId, { kind: 'human_edit', actorParticipantId: danaParticipant._id });
    const decisions = orderBetween(nextGuidance!.order, null);
    await insertBlock(ctx, person, { order: decisions, kind: 'heading', text: 'Decisions', author: { kind: 'participant', participantId: danaParticipant._id } });
    await insertBlock(ctx, person, { order: orderBetween(decisions, null), kind: 'paragraph', text: 'PERSON-NOTE we chose Postgres', author: { kind: 'participant', participantId: danaParticipant._id } });
    // Guidance someone has rewritten is now room content.
    await patchBlock(ctx, person, nextGuidance!._id, { text: 'PERSON-EDIT Dana does the rollout on Friday' });
  });
  expect(goal!.author).toEqual({ kind: 'participant', participantId: robert._id });

  const savedId = await s.owner.mutation(api.templates.saveFromRoom, { roomId, name: '  From planning  ' });
  const saved = (await s.owner.query(api.templates.list, {})).find(x => x._id === savedId)!;
  expect(saved.name).toBe('From planning');
  expect(saved.sections).toEqual([
    { heading: 'Goal', guidance: 'What are we trying to change, and for whom?' },
    { heading: 'Risks' },
    { heading: 'Next steps' },
    { heading: 'Decisions' },
  ]);
  expect(JSON.stringify(saved)).not.toMatch(/MODEL-|PERSON-/);
});
