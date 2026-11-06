import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      exclude: ["convex/_generated/**"],
      include: ["convex/**/*.ts"],
      provider: "v8",
    },
    include: ["tests/**/*.test.ts"],
  },
});
