import { fileURLToPath } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    // Test files sit next to the routes they cover; keep them out of the route tree.
    tanstackRouter({
      autoCodeSplitting: true,
      routeFileIgnorePattern: "\\.test\\.",
      target: "react",
    }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { "~": fileURLToPath(new URL("src", import.meta.url)) },
  },
  test: {
    coverage: {
      exclude: ["src/routeTree.gen.ts"],
      include: ["src/**/*.{ts,tsx}"],
      provider: "v8",
    },
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/test/setup.ts"],
    // The jsdom suites slow down when every workspace tests at once; the 5 s default failed them then.
    testTimeout: 15_000,
  },
});
