import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Page } from "@playwright/test";
import { expect, REAL_OMP, realTest, screenshots } from "./real-omp";

/**
 * Issue 927. With no model set up, omp exits when it starts, and the app used to show "omp isn't
 * available" with the wrong reason. The fixture gives omp the fake model; these wrappers drop that
 * model, point omp at an empty agent folder and remove the provider keys, so omp starts the way a
 * fresh install does: one for omp's commands (`ompBinary`), one for every chat (`chatWrapper`). The
 * fixture's own agent folder still holds the fake model's config, which only the server reads.
 */
const dir = resolve(process.cwd(), "../../.data/fix-927-no-model");
mkdirSync(dir, { recursive: true });
const emptyAgent = mkdtempSync(join(dir, "agent-"));
/** A script that runs `program` (empty: the command it is given) with that model, agent folder and keys gone. */
function withoutModel(program: string): string {
  return `#!/bin/bash
args=()
skip=0
for arg in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  if [ "$arg" = "--model" ]; then skip=1; continue; fi
  args+=("$arg")
done
unset ANTHROPIC_API_KEY OPENAI_API_KEY GEMINI_API_KEY GOOGLE_API_KEY OPENROUTER_API_KEY MISTRAL_API_KEY GROQ_API_KEY XAI_API_KEY
export PI_CODING_AGENT_DIR="${emptyAgent}"
exec ${program} "\${args[@]}"
`;
}
const noModelOmp = join(dir, "omp-no-model.sh");
writeFileSync(noModelOmp, withoutModel(`"${REAL_OMP}"`));
chmodSync(noModelOmp, 0o755);
const noModelChat = join(dir, "chat-no-model.sh");
writeFileSync(noModelChat, withoutModel(""));
chmodSync(noModelChat, 0o755);
realTest.use({ ompBinary: noModelOmp, chatWrapper: noModelChat });

async function expectNoModelScreen(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "No model is set up yet" })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole("heading", { name: "omp isn't available" })).toHaveCount(0);
  await expect(page.getByText("ANTHROPIC_API_KEY", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("/login", { exact: false }).first()).toBeVisible();
  // The token styles loaded: the page's background is the app's own, not the browser's default.
  const background = await page
    .locator("main")
    .evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(background).not.toBe("rgba(0, 0, 0, 0)");
}

realTest(
  "with no model set up, the first screen says so and how to set one up",
  async ({ realApp }) => {
    const page = await realApp.open({ expectApp: false });
    await expectNoModelScreen(page);
    await mkdir(screenshots, { recursive: true });
    await page.screenshot({ path: join(screenshots, "fix-927-no-model-light.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(screenshots, "fix-927-no-model-390.png") });

    const dark = await realApp.open({
      expectApp: false,
      beforeLoad: (opened) =>
        opened.addInitScript(() => window.localStorage.setItem("omp-app.theme", "dark")),
    });
    await expectNoModelScreen(dark);
    await dark.screenshot({ path: join(screenshots, "fix-927-no-model-dark.png") });
  },
);
