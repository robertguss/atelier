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
  overrides: [
    {
      // Convex turns module file names into API paths (api.turnActivity),
      // and its convention is camelCase.
      files: ["packages/backend/convex/**"],
      rules: {
        "unicorn/filename-case": [
          "error",
          { cases: { camelCase: true, kebabCase: true } },
        ],
      },
    },
  ],
});
