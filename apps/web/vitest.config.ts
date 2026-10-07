import { fileURLToPath, URL } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    // Heavy jsdom tests (a 130-step turn, a sidebar with many rows) take longer than the 5 s default
    // when builders, reviewers and e2e runs share the machine; a real hang still fails at 30 s.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
