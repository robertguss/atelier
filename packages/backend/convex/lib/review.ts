import { sendEvent } from "@convex-dev/workflow";
import type { WorkflowId } from "@convex-dev/workflow";

import { components } from "../_generated/api";
import type { Doc } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";

// Called in the same transaction as each terminal transition. Retried finish,
// fail, cancellation and recovery calls cannot send duplicate events.
export const reviewFinished = async (ctx: MutationCtx, turn: Doc<"turns">) => {
  if (!turn.ritualId) {
    return;
  }
  const ritual = await ctx.db.get(turn.ritualId);
  if (
    ritual?.workflowId !== undefined &&
    ritual.workflowId !== "" &&
    ritual.status === "collecting"
  ) {
    await sendEvent(ctx, components.workflow, {
      name: turn._id,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the schema stores the id start() returned as a plain string, and the WorkflowId brand has no runtime check to narrow with
      workflowId: ritual.workflowId as WorkflowId,
    });
  }
};
