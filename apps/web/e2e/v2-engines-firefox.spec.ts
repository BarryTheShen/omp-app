import { existsSync } from "node:fs";
import { firefox } from "@playwright/test";
import { realTest } from "./real-omp";
import { defineEngineChecks } from "./v2-engines-checks";

/**
 * The app in Firefox, as Playwright's own Firefox build runs it (the test image's Mozilla Firefox is for the extension's
 * checks, `firefox.ts`). A machine without that build skips, saying so.
 */
realTest.use({ browserName: "firefox", channel: "" });
realTest.skip(
  !existsSync(firefox.executablePath()),
  "Playwright's Firefox is not installed here (PLAYWRIGHT_BROWSERS_PATH)",
);
defineEngineChecks("firefox");
