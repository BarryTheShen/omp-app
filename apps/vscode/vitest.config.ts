import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The rules need no VS Code and no page; the panel runs against the real app in apps/web/e2e.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
