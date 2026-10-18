import { defineConfig } from "@playwright/test";

// Builders run e2e in parallel worktrees, so each run picks its own port (E2E_PORT) and never reuses
// a server it did not start: a busy port fails loudly instead of testing someone else's build.
const port = Number(process.env.E2E_PORT ?? 4173);
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  // The test-machine build queue sets E2E_WORKERS to the CPUs a job may use (inside its container the machine still reports 20,
  // so Playwright's default of half of them would be ten workers on four CPUs). A --workers flag still wins.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    actionTimeout: 60_000,
    baseURL: origin,
    channel: "chrome",
    headless: true,
    navigationTimeout: 60_000,
    trace: "on-first-retry",
  },
  webServer: {
    command: `bun run preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
