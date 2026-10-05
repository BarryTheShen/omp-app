import { defineConfig } from "@playwright/test";

const port = Number(process.env.E2E_PORT ?? 4209);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: ".",
  testMatch: "attachments.spec.ts",
  fullyParallel: true,
  use: { baseURL: origin, channel: "chrome", headless: true },
  webServer: {
    command: `bun run dev --host 127.0.0.1 --port ${port} --strictPort`,
    url: `${origin}/src/modules/U2/attachments/playground.html`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
