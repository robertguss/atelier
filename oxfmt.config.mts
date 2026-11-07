import { defineConfig } from "oxfmt";
import ultracite from "ultracite/oxfmt";

export default defineConfig({
  ...ultracite,
  ignorePatterns: [
    ...(ultracite.ignorePatterns ?? []),
    // TanStack Router regenerates this file on every dev server and build.
    "apps/web/src/routeTree.gen.ts",
    "pnpm-lock.yaml",
  ],
  // Keep the hand-wrapped Markdown prose in the docs as written.
  proseWrap: "preserve",
});
