import { defineConfig } from "oxlint";
import core from "ultracite/oxlint/core";
import vitest from "ultracite/oxlint/vitest";

export default defineConfig({
  env: core.env,
  extends: [core, vitest],
  ignorePatterns: [
    ...core.ignorePatterns,
    // TanStack Router regenerates this file on every dev server and build.
    "apps/web/src/routeTree.gen.ts",
  ],
  options: { typeAware: true },
});
