import { mutation } from "./_generated/server";
import { ensureUser } from "./lib/auth";

// Called by the apps after sign-in. Creates or refreshes the caller's user
// row and, for the owner, links rooms that predate memberships.
export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ensureUser(ctx);
    return user._id;
  },
});
