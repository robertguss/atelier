import { defineConfig } from "vitest/config";

// Tests cover pure modules only. Vitest cannot parse react-native's Flow
// source, so test files must not import react-native or Expo modules.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    coverage: { provider: "v8", include: ["src/lib/**/*.ts"] },
  },
});
