import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The tools' rules and the address check need no page; the page functions run in a browser (apps/web/e2e).
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
