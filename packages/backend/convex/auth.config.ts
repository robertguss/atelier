import type { AuthConfig } from "convex/server";

// Clerk Frontend API URL, set with `npx convex env set CLERK_JWT_ISSUER_DOMAIN ...`
const domain = process.env.CLERK_JWT_ISSUER_DOMAIN;
if (domain === undefined || domain === "") {
  throw new Error(
    "CLERK_JWT_ISSUER_DOMAIN is not set on this Convex deployment"
  );
}

export default {
  providers: [{ applicationID: "convex", domain }],
} satisfies AuthConfig;
