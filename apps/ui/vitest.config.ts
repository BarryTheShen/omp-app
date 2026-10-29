import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "jsdom",
    // Vitest hands every stylesheet over empty; the contrast test reads the theme file's text.
    css: { include: [/themes\.css/] },
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
