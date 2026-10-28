import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Locator, Page } from "@playwright/test";
import {
  expect,
  hostRequest,
  onHostEvent,
  realTest,
  screenshots,
  startChat,
  waitForFiniteAnimations,
} from "./real-omp";

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

/**
 * Runs omp's commands on a chat host the test started (`realApp.startOmp`): each command is the host's `prompt`, and its
 * words come back as the host's `command_output` events.
 */
function hostCommandClient(child: ChildProcess): {
  readonly run: (message: string, expectedOutput: string) => Promise<string>;
} {
  const outputWaiters: Array<{ readonly text: string; readonly resolve: (text: string) => void }> =
    [];
  const outputs: string[] = [];
  onHostEvent(child, (event) => {
    if (event.type !== "command_output" || typeof event.text !== "string") return;
    const text = event.text;
    outputs.push(text);
    for (const waiter of [...outputWaiters]) {
      if (!text.includes(waiter.text)) continue;
      outputWaiters.splice(outputWaiters.indexOf(waiter), 1);
      waiter.resolve(text);
    }
  });
  return {
    async run(message, expectedOutput) {
      const output = outputs.find((text) => text.includes(expectedOutput));
      if (output !== undefined) return output;
      const outputPromise = new Promise<string>((resolve) => {
        outputWaiters.push({ text: expectedOutput, resolve });
      });
      await hostRequest(child, "prompt", { text: message });
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
      await waitForFiniteAnimations(page);
      await assertSubjectInsideDialog(dialog, subject, state);
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
    await waitForFiniteAnimations(page);
    await assertSubjectInsideDialog(dialog, subject, state);
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

/** The server's notice that the extension list changed: the stream the app's list subscribes to. */
const CATALOG_CHANGED = "A1.extensionCatalog/changed";

/** The list's change notice, held from the registry write until the Disable call has gone out. */
interface HeldCatalogChange {
  /** Set just before the registry write: the notices before it pass through. */
  armed: boolean;
  /** Set once the Disable call has gone out: the held notices are delivered, and later ones pass through. */
  released: boolean;
  readonly held: Array<string | Buffer>;
}

function isCatalogChanged(text: string): boolean {
  try {
    const frame: unknown = JSON.parse(text);
    return (
      frame !== null &&
      typeof frame === "object" &&
      "stream" in frame &&
      frame.stream === CATALOG_CHANGED
    );
  } catch {
    return false;
  }
}

/**
 * Routes the page's WebSocket before the app connects. While the hold is armed, the list's change notice is kept back, so
 * the list keeps the marketplace link, and the confirmation, until the Disable call has gone out. Every other frame passes
 * through in order.
 */
async function holdCatalogChange(page: Page, hold: HeldCatalogChange): Promise<void> {
  await page.routeWebSocket(/\/ws/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      server.send(message);
      const sent = typeof message === "string" ? message : message.toString("utf8");
      if (hold.armed && !hold.released && sent.includes("/plugins disable")) {
        hold.released = true;
        for (const held of hold.held.splice(0)) socket.send(held);
      }
    });
    server.onMessage((message) => {
      const received = typeof message === "string" ? message : message.toString("utf8");
      if (hold.armed && !hold.released && isCatalogChanged(received)) {
        hold.held.push(message);
        return;
      }
      socket.send(message);
    });
  });
}

realTest(
  "marketplace plugin controls use the installed registry and confirm changes through omp",
  async ({ realApp }, testInfo) => {
    testInfo.setTimeout(300_000);
    const marketplacePath = await seedLocalMarketplace(realApp.folder);
    const promptClient = hostCommandClient(realApp.startOmp([]));
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

    const hold: HeldCatalogChange = { armed: false, released: false, held: [] };
    const page = await realApp.open({ beforeLoad: (target) => holdCatalogChange(target, hold) });
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
    // The write changes the registry, and the list hears about it from the change notice. The hold keeps that notice back
    // until the Disable call has gone out, so the list keeps the confirmation. The 500 ms pause is longer than the app's
    // refresh: without the hold the list would have dropped the confirmation before the click.
    hold.armed = true;
    await removeMarketplaceInstall(realApp.agentDir);
    await expect.poll(() => hold.held.length, { timeout: 30_000 }).toBeGreaterThan(0);
    await page.waitForTimeout(500);
    await page
      .getByRole("group", { name: "Disable plugin" })
      .getByRole("button", { name: "Disable plugin" })
      .click();
    await expect.poll(() => hold.released, { timeout: 30_000 }).toBe(true);
    const failure = page.getByRole("alert").filter({ hasText: "Plugin error:" });
    // omp 18.12 refuses a plugin that its runtime config no longer has (18.8.9 said "is not installed"). The app shows
    // omp's text as it is.
    await expect(failure).toContainText(`Plugin ${PLUGIN_ID} not found in runtime config`, {
      timeout: 30_000,
    });
    // The list then reloads without the marketplace link: the Disable button and the confirmation go, and the refusal
    // stays on the inspector through that reload.
    await expect(
      page.getByText(
        "This plugin was not installed from a marketplace, so omp cannot turn it on or off from here.",
      ),
    ).toBeVisible();
    await expect(failure).toContainText(`Plugin ${PLUGIN_ID} not found in runtime config`);
    const inspector = page.getByTestId("extension-inspector");
    await expect(inspector.getByText("Enabled", { exact: true })).toBeVisible();
    await captureState(page, "failed");
    expect(realApp.problems).toEqual([]);
  },
);
