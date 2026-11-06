import { query } from "./_generated/server";
import { getOwner, getUser } from "./lib/auth";

// The phone's first proof that Clerk → Convex auth works end to end.
export const get = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return { signedIn: false as const };
    }
    const owner = await getOwner(ctx);
    const user = await getUser(ctx);
    return {
      email: identity.email ?? null,
      isOwner: owner !== null,
      name: identity.name ?? null,
      signedIn: true as const,
      userId: user?._id ?? null,
    };
  },
});
