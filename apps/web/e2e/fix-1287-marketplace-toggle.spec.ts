import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import type { Locator, Page } from "@playwright/test";
import { expect, realTest, screenshots, startChat, waitForFiniteAnimations } from "./real-omp";

const MARKETPLACE = "local-toggle-market";
const PLUGIN_ID = `hello-plugin@${MARKETPLACE}`;

async function seedLocalMarketplace(folder: string): Promise<string> {
  const marketplace = join(folder, "local-marketplace");
  const plugin = join(marketplace, "plugins", "hello-plugin");
  await mkdir(join(marketplace, ".claude-plugin"), { recursive: true });
  await mkdir(join(plugin, ".claude-plugin"), { recursive: true });
  await writeFile(
    join(marketplace, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      name: MARKETPLACE,
      owner: { name: "Local test" },
      plugins: [{ name: "hello-plugin", source: "./plugins/hello-plugin" }],
    }),
  );
  await writeFile(
    join(plugin, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "hello-plugin",
      description: "Local toggle test plugin",
      version: "1.0.0",
    }),
  );
  await writeFile(
    join(plugin, "package.json"),
    JSON.stringify({ name: "hello-plugin", version: "1.0.0", omp: { extensions: ["index.js"] } }),
  );
  await writeFile(join(plugin, "index.js"), "export default function helloPlugin() {}\n");
  return marketplace;
}

async function openToolsTab(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByTestId("settings-screen");
  await expect(settings).toBeVisible();
  await settings.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(page.getByTestId("extension-control-center")).toBeVisible();
}

interface RpcPromptResponse {
  readonly type: "response";
  readonly id: string;
  readonly success: boolean;
}

function rpcPromptClient(child: ChildProcess): {
  readonly ready: Promise<void>;
  readonly run: (message: string, expectedOutput: string) => Promise<string>;
} {
  if (child.stdin === null || child.stdout === null)
    throw new Error("The real omp process has no JSONL streams.");
  const lines = createInterface({ input: child.stdout });
  const responses = new Map<string, (response: RpcPromptResponse) => void>();
  const outputWaiters: Array<{ readonly text: string; readonly resolve: (text: string) => void }> =
    [];
  const outputs: string[] = [];
  const ready = Promise.withResolvers<void>();
  let sequence = 0;
  lines.on("line", (line) => {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (frame.type === "ready") ready.resolve();
    if (
      frame.type === "response" &&
      typeof frame.id === "string" &&
      typeof frame.success === "boolean"
    ) {
      responses.get(frame.id)?.(frame as unknown as RpcPromptResponse);
      responses.delete(frame.id);
    }
    if (frame.type === "command_output" && typeof frame.text === "string") {
      outputs.push(frame.text);
      for (const waiter of [...outputWaiters]) {
        if (!frame.text.includes(waiter.text)) continue;
        outputWaiters.splice(outputWaiters.indexOf(waiter), 1);
        waiter.resolve(frame.text);
      }
    }
  });
  return {
    ready: ready.promise,
    async run(message, expectedOutput) {
      await ready.promise;
      const output = outputs.find((text) => text.includes(expectedOutput));
      if (output !== undefined) return output;
      const responseId = `marketplace-test-${sequence++}`;
      const outputPromise = new Promise<string>((resolve) => {
        outputWaiters.push({ text: expectedOutput, resolve });
      });
      const responsePromise = new Promise<RpcPromptResponse>((resolve) => {
        responses.set(responseId, resolve);
      });
      child.stdin?.write(`${JSON.stringify({ type: "prompt", id: responseId, message })}\n`);
      const response = await responsePromise;
      expect(response.success).toBe(true);
      return outputPromise;
    },
  };
}

async function expectPluginEnabled(page: Page, enabled: boolean): Promise<void> {
  const status = enabled ? "Enabled" : "Disabled";
  await expect(page.locator('[data-testid="extension-inspector"]')).toContainText(status, {
    timeout: 30_000,
  });
  await expect(
    page.getByRole("button", { name: enabled ? "Disable plugin" : "Enable plugin" }),
  ).toBeVisible();
}

async function assertSubjectInsideDialog(
  dialog: Locator,
  subject: Locator,
  state: string,
): Promise<void> {
  await expect(dialog).toBeVisible();
  await expect(subject).toBeVisible();
  const [dialogBox, subjectBox] = await Promise.all([
    dialog.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
    subject.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    }),
  ]);
  expect(dialogBox.width, `${state} dialog must have a visible box`).toBeGreaterThan(0);
  expect(dialogBox.height, `${state} dialog must have a visible box`).toBeGreaterThan(0);
  expect(subjectBox.width, `${state} subject must have a visible box`).toBeGreaterThan(0);
  expect(subjectBox.height, `${state} subject must have a visible box`).toBeGreaterThan(0);
  expect(subjectBox.x).toBeGreaterThanOrEqual(dialogBox.x);
  expect(subjectBox.y).toBeGreaterThanOrEqual(dialogBox.y);
  expect(subjectBox.x + subjectBox.width).toBeLessThanOrEqual(dialogBox.x + dialogBox.width);
  expect(subjectBox.y + subjectBox.height).toBeLessThanOrEqual(dialogBox.y + dialogBox.height);
}

async function captureState(page: Page, state: string): Promise<void> {
  const dialog = page.getByRole("dialog").filter({ has: page.getByTestId("settings-screen") });
  const layouts = [
    { width: 1280, scheme: "light" as const },
    { width: 1280, scheme: "dark" as const },
    { width: 390, scheme: "light" as const },
    { width: 390, scheme: "dark" as const },
  ];
  const subject =
    state === "confirmation"
      ? page.getByRole("group", { name: "Disable plugin" })
      : state === "disabled-with-reason"
        ? page.getByText("Open a chat first: plugins are changed through a running chat.")
        : state === "failed"
          ? page.getByRole("alert").filter({ hasText: "Plugin error:" })
          : state === "busy"
            ? page.getByTestId("extension-inspector").locator("button").first()
            : page.getByRole("button", { name: "Disable plugin" });
  if (state === "busy") {
    for (const [index, layout] of layouts.entries()) {
      if (index > 0) {
        await expectPluginEnabled(page, false);
        await page.getByRole("button", { name: "Enable plugin" }).click();
        const enableGroup = page.getByRole("group", { name: "Enable plugin" });
        await enableGroup.getByRole("button", { name: "Enable plugin" }).click();
        await expectPluginEnabled(page, true);
        await page.getByRole("button", { name: "Disable plugin" }).click();
        const group = page.getByRole("group", { name: "Disable plugin" });
        await group.getByRole("button", { name: "Disable plugin" }).click();
      }
      await page.setViewportSize({ width: layout.width, height: 900 });
      await page.emulateMedia({ colorScheme: layout.scheme });
      await assertSubjectInsideDialog(dialog, subject, state);
      await waitForFiniteAnimations(page);
      await page.screenshot({
        path: join(screenshots, `fix-1287-${state}-${layout.width}-${layout.scheme}.png`),
        fullPage: true,
      });
      if (layout.width === 390) {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
          `${state} ${layout.scheme} must fit the 390 px viewport`,
        ).toBeLessThanOrEqual(390);
      }
    }
    await expectPluginEnabled(page, false);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ colorScheme: "light" });
    return;
  }
  for (const layout of layouts) {
    await page.setViewportSize({ width: layout.width, height: 900 });
    await page.emulateMedia({ colorScheme: layout.scheme });
    await assertSubjectInsideDialog(dialog, subject, state);
    await waitForFiniteAnimations(page);
    await page.screenshot({
      path: join(screenshots, `fix-1287-${state}-${layout.width}-${layout.scheme}.png`),
      fullPage: true,
    });
    if (layout.width === 390) {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
        `${state} ${layout.scheme} must fit the 390 px viewport`,
      ).toBeLessThanOrEqual(390);
    }
    if (state === "failed") {
      const colors = await page.evaluate(() => {
        const alert = document.querySelector('p[role="alert"]');
        const token = document.createElement("span");
        token.style.color = "var(--destructive)";
        document.body.append(token);
        const expected = getComputedStyle(token).color;
        token.remove();
        return { expected, actual: alert ? getComputedStyle(alert).color : "" };
      });
      expect(colors.actual).toBe(colors.expected);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ colorScheme: "light" });
}

async function removeMarketplaceInstall(agentDir: string): Promise<void> {
  const path = join(dirname(agentDir), "home", ".omp", "plugins", "installed_plugins.json");
  const registry = JSON.parse(await readFile(path, "utf8")) as {
    plugins: Record<string, unknown>;
  };
  expect(registry.plugins[PLUGIN_ID]).toBeDefined();
  delete registry.plugins[PLUGIN_ID];
  await writeFile(path, `${JSON.stringify(registry, null, 2)}\n`);
}

realTest(
  "marketplace plugin controls use the installed registry and confirm changes through omp",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const marketplacePath = await seedLocalMarketplace(realApp.folder);
    const promptClient = rpcPromptClient(realApp.startOmp([]));
    await promptClient.ready;
    const before = await promptClient.run(
      "/marketplace installed",
      "No marketplace plugins installed",
    );
    expect(before).toContain("No marketplace plugins installed");
    const added = await promptClient.run(
      `/marketplace add ${marketplacePath}`,
      `Added marketplace: ${MARKETPLACE}`,
    );
    expect(added).toContain(`Added marketplace: ${MARKETPLACE}`);
    const installed = await promptClient.run(
      `/marketplace install --scope user ${PLUGIN_ID}`,
      `Installed hello-plugin from ${MARKETPLACE}`,
    );
    expect(installed).toContain(`Installed hello-plugin from ${MARKETPLACE}`);
    const after = await promptClient.run("/marketplace installed", PLUGIN_ID);
    expect(after).toContain(`${PLUGIN_ID} [user]`);

    const page = await realApp.open();
    await openToolsTab(page);
    await page.getByTestId("extension-tab-plugins").click();
    await expect(page.getByTestId("extension-item-hello-plugin")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("extension-item-hello-plugin").click();
    const noChatButton = page.getByRole("button", { name: "Disable plugin" });
    await expect(noChatButton).toBeDisabled();
    await expect(
      page.getByText("Open a chat first: plugins are changed through a running chat."),
    ).toBeVisible();
    await mkdir(screenshots, { recursive: true });
    await captureState(page, "disabled-with-reason");
    await page.getByRole("button", { name: "Close settings" }).click();

    await startChat(page);
    await openToolsTab(page);
    await page.getByTestId("extension-tab-plugins").click();
    await page.getByRole("button", { name: "Reload extension catalog" }).click();
    await expect(page.getByTestId("extension-item-hello-plugin")).toBeVisible({ timeout: 60_000 });
    await page.getByTestId("extension-item-hello-plugin").click();
    await expectPluginEnabled(page, true);
    await captureState(page, "idle");

    await page.getByRole("button", { name: "Disable plugin" }).click();
    const cancelGroup = page.getByRole("group", { name: "Disable plugin" });
    await expect(cancelGroup).toContainText("Disable the hello-plugin plugin in the user scope?");
    await captureState(page, "confirmation");
    await cancelGroup.getByRole("button", { name: "Cancel" }).click();
    await expectPluginEnabled(page, true);

    await page.getByRole("button", { name: "Disable plugin" }).click();
    const disableGroup = page.getByRole("group", { name: "Disable plugin" });
    await disableGroup.getByRole("button", { name: "Disable plugin" }).click();
    const busy = page.getByRole("button", { name: "Working…" });
    await expect(busy).toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
    await captureState(page, "busy");
    await expectPluginEnabled(page, false);
    await page.getByRole("button", { name: "Enable plugin" }).click();
    await page
      .getByRole("group", { name: "Enable plugin" })
      .getByRole("button", { name: "Enable plugin" })
      .click();
    await expectPluginEnabled(page, true);

    await page.getByRole("button", { name: "Disable plugin" }).click();
    const failedButton = page
      .getByRole("group", { name: "Disable plugin" })
      .getByRole("button", { name: "Disable plugin" });
    const failedClick = failedButton.evaluate((button) => (button as HTMLButtonElement).click());
    await removeMarketplaceInstall(realApp.agentDir);
    await failedClick;
    const failure = page.getByRole("alert").filter({ hasText: "Plugin error:" });
    await expect(failure).toContainText(
      'Plugin "hello-plugin@local-toggle-market" is not installed',
      {
        timeout: 30_000,
      },
    );
    const inspector = page.getByTestId("extension-inspector");
    await expect(inspector.getByText("Enabled", { exact: true })).toBeVisible();
    await expect(
      page.getByText(
        "This plugin was not installed from a marketplace, so omp cannot turn it on or off from here.",
      ),
    ).toBeVisible();
    await captureState(page, "failed");
    expect(realApp.problems).toEqual([]);
  },
);
