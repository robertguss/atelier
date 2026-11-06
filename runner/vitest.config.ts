import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Integration tests drive the real pi and codex CLIs; run them with
    // `pnpm test:integration`.
    exclude: ["src/**/*.integration.test.ts"],
    coverage: { include: ["src/**/*.ts"], provider: "v8" },
  },
});
