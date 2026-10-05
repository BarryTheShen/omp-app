import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4208);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "playground.spec.ts",
  fullyParallel: true,
  use: {
    baseURL: origin,
    channel: "chrome",
    headless: true,
  },
  webServer: {
    command: `bun run dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${origin}/src/modules/U2/composer/playground.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
