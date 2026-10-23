import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, type RealApp, realTest, screenshots, sendPrompt, startChat } from "./real-omp";

realTest.setTimeout(300_000);

function frameOf(message: string | Buffer): Record<string, unknown> | undefined {
  try {
    return JSON.parse(String(message)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

type OpenArgs = { readonly start?: string; readonly threadId?: string };
type OpenMatcher = (args: OpenArgs) => boolean;

interface OpenRule {
  readonly matches: OpenMatcher;
  readonly requestIds: Set<string>;
  readonly waiting: Array<{ readonly ws: WebSocketRoute; readonly message: string | Buffer }>;
  holding: boolean;
}

class OpenHold {
  private readonly rules: OpenRule[] = [];

  hold(matches: OpenMatcher = () => true): { waiting: () => number; release: () => void } {
    const rule: OpenRule = { matches, requestIds: new Set(), waiting: [], holding: true };
    this.rules.push(rule);
    return {
      waiting: () => rule.waiting.length,
      release: () => {
        rule.holding = false;
        for (const answer of rule.waiting.splice(0)) answer.ws.send(answer.message);
      },
    };
  }

  async install(page: Page): Promise<void> {
    await page.routeWebSocket(/\/ws/, (ws) => {
      const server = ws.connectToServer();
      ws.onMessage((message) => {
        const frame = frameOf(message);
        if (frame?.type === "call" && frame.port === "A0.rpcSession" && frame.method === "open") {
          const args = (frame.args ?? {}) as OpenArgs;
          for (const rule of this.rules) {
            if (rule.holding && rule.matches(args)) rule.requestIds.add(String(frame.id));
          }
        }
        server.send(message);
      });
      server.onMessage((message) => {
        const frame = frameOf(message);
        if (frame?.type === "result") {
          const rule = this.rules.find(
            (candidate) => candidate.holding && candidate.requestIds.has(String(frame.id)),
          );
          if (rule !== undefined) {
            rule.waiting.push({ ws, message });
            return;
          }
        }
        ws.send(message);
      });
    });
  }
}

function newChatButton(page: Page) {
  return page.locator('[aria-label="Sessions"]').getByRole("button", { name: "New chat" }).first();
}
async function expectStyled(page: Page): Promise<void> {
  const colors = await page.locator("[data-shell-layout]").evaluate((shell) => {
    const context = document.createElement("canvas").getContext("2d");
    if (context === null) throw new Error("Canvas is unavailable.");
    const normalize = (color: string): string => {
      context.fillStyle = "#000000";
      context.fillStyle = color;
      return context.fillStyle;
    };
    const background = getComputedStyle(shell).backgroundColor;
    const token = getComputedStyle(document.documentElement)
      .getPropertyValue("--background")
      .trim();
    return {
      normalizedBackground: normalize(background),
      normalizedToken: normalize(token),
      token,
    };
  });
  expect(colors.token).not.toBe("");
  expect(colors.normalizedBackground).toBe(colors.normalizedToken);
}

async function exercise(realApp: RealApp, theme: "light" | "dark"): Promise<void> {
  await mkdir(screenshots, { recursive: true });
  const holds = new OpenHold();
  const page = await realApp.open({
    beforeLoad: async (target) => {
      await target.addInitScript(
        (selectedTheme) => localStorage.setItem("omp-app.theme", selectedTheme),
        theme,
      );
      await holds.install(target);
    },
  });
  const first = await startChat(page);
  await sendPrompt(first, "first prompt");
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });

  const opening = holds.hold((args) => args.start === "new");
  await newChatButton(page).click();
  await expect.poll(() => opening.waiting(), { timeout: 30_000 }).toBeGreaterThan(0);

  const composer = page.getByRole("textbox", { name: "Message input" });
  await expect(composer).toBeVisible({ timeout: 2_000 });
  const composerElement = await composer.elementHandle();
  if (composerElement === null) throw new Error("Message input element was not mounted.");
  await newChatButton(page).click();
  await expectStyled(page);
  await page.screenshot({ path: join(screenshots, `fix-1662-composer-${theme}.png`) });
  if (theme === "light") {
    await page.setViewportSize({ width: 390, height: 844 });
    await expectStyled(page);
    await page.screenshot({ path: join(screenshots, "fix-1662-composer-narrow.png") });
  }

  await composer.fill("during new chat");
  await composer.press("Enter");
  await expect(composer).toHaveValue("during new chat");

  opening.release();
  await expect.poll(() => composerElement.evaluate((element) => element.isConnected)).toBe(true);
  await expect(
    page.getByRole("region", { name: "Messages" }).getByText("during new chat", { exact: true }),
  ).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText("pong", { exact: true })).toBeVisible({ timeout: 90_000 });
  expect(realApp.problems).toEqual([]);
}

realTest(
  "#1662: the composer stays available while New chat opens (light and narrow)",
  async ({ realApp }) => {
    await exercise(realApp, "light");
  },
);

realTest("#1662: the composer stays available while New chat opens (dark)", async ({ realApp }) => {
  await exercise(realApp, "dark");
});
