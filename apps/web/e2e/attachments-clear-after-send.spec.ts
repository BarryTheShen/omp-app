import type { Locator, Page } from "@playwright/test";
import type { RealApp } from "./real-omp";
import { expect, realTest, startChat } from "./real-omp";

const ATTACHMENTS = '[data-slot="u2-composer-attachments"]';

async function addFile(page: Page, composer: Locator, name: string): Promise<void> {
  await composer.evaluate((input, fileName) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File(["attachment body"], fileName, { type: "text/plain" }));
    input.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer }));
  }, name);
  await expect(page.locator(ATTACHMENTS)).toContainText(name);
}

async function expectNoAttachments(page: Page): Promise<void> {
  await expect(page.locator(ATTACHMENTS)).toHaveCount(0);
}

realTest(
  "clears an attachment after admission and does not reuse it on the next message",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    const page = await realApp.open();
    const composer = await startChat(page);

    await addFile(page, composer, "sent-once.txt");
    await composer.fill("First message with an attachment");
    await composer.press("Enter");
    await expect(page.getByText("pong", { exact: true }).first()).toBeVisible({ timeout: 45_000 });
    await expectNoAttachments(page);

    await composer.fill("Second message without an attachment");
    await composer.press("Enter");
    await expect(page.getByText("pong", { exact: true })).toHaveCount(2, { timeout: 45_000 });
    await expectNoAttachments(page);
    expect(realApp.problems).toEqual([]);
  },
);

realTest(
  "keeps an attachment when the send fails before admission",
  async ({ realApp }: { readonly realApp: RealApp }) => {
    let failNextPrompt = false;
    const page = await realApp.open({
      beforeLoad: async (openedPage) => {
        await openedPage.routeWebSocket(
          () => true,
          (webSocket) => {
            const server = webSocket.connectToServer();
            webSocket.onMessage((message) => {
              let isPrompt = false;
              try {
                const frame = JSON.parse(String(message)) as Record<string, unknown>;
                isPrompt =
                  frame.type === "call" &&
                  frame.port === "A0.rpcSession" &&
                  frame.method === "send";
              } catch {
                // Non-JSON frames are forwarded unchanged.
              }
              if (failNextPrompt && isPrompt) {
                failNextPrompt = false;
                void webSocket.close({ code: 1011, reason: "test failure" });
                return;
              }
              server.send(message);
            });
          },
        );
      },
    });
    const composer = await startChat(page);

    await addFile(page, composer, "kept-after-failure.txt");
    failNextPrompt = true;
    await composer.fill("This send should fail before admission");
    await composer.press("Enter");
    await expect(page.locator('[data-composer-error="true"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(ATTACHMENTS)).toContainText("kept-after-failure.txt");
    expect(realApp.problems).toEqual([]);
  },
);
