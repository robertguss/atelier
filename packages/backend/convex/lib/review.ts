import { sendEvent, type WorkflowId } from '@convex-dev/workflow';
import { components } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import type { Doc } from '../_generated/dataModel';

// Called in the same transaction as each terminal transition. Retried finish,
// fail, cancellation and recovery calls cannot send duplicate events.
export async function reviewFinished(ctx: MutationCtx, turn: Doc<'turns'>) {
  if (!turn.ritualId) return;
  const ritual = await ctx.db.get(turn.ritualId);
  if (ritual?.workflowId && ritual.status === 'collecting') {
    await sendEvent(ctx, components.workflow, { workflowId: ritual.workflowId as WorkflowId, name: turn._id });
  }
}
