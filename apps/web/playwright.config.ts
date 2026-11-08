import { defineConfig } from "@playwright/test";

// Every spec starts its own app server on a free port (`e2e/real-omp.ts`) and opens the page by its full address, so the
// config has no web server and no base URL. The server serves the built UI (`bun run build` at the repo root).
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: true,
  // Live tests run chats on the compiled chat host, as the packages do: built once per lockfile (e2e/global-setup.ts).
  globalSetup: "./e2e/global-setup.ts",
  // The test-machine build queue sets E2E_WORKERS to the CPUs a job may use (inside its container the machine still reports 20,
  // so Playwright's default of half of them would be ten workers on four CPUs). A --workers flag still wins.
  workers: process.env.E2E_WORKERS ? Number(process.env.E2E_WORKERS) : undefined,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    actionTimeout: 60_000,
    channel: "chrome",
    headless: true,
    navigationTimeout: 60_000,
    trace: "on-first-retry",
  },
});
