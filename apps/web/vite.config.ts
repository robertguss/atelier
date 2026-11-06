import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// A static single-page app. All runtime config comes from VITE_* env vars, so
// the same build can be hosted anywhere or wrapped in a desktop shell later.
export default defineConfig({
  plugins: [
    // Test files sit next to the routes they cover; keep them out of the route tree.
    tanstackRouter({ target: 'react', autoCodeSplitting: true, routeFileIgnorePattern: '\\.test\\.' }),
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: { '~': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
