import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: { include: ["src/**/*.ts"], provider: "v8" },
    // Integration tests drive the real pi and codex CLIs; run them with
    // `pnpm test:integration`.
    exclude: ["src/**/*.integration.test.ts"],
    include: ["src/**/*.test.ts"],
  },
});
