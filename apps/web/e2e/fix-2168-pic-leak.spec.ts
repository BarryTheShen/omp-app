import type { Page } from "@playwright/test";
import { expect, realTest, sendPrompt, startChat, waitForFiniteAnimations } from "./real-omp";

const IMAGE = "fix-2168.png";
const NEW_CHAT_TEXT = "fix-2168 new chat message";
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

function frameOf(message: string | Buffer): Record<string, unknown> | undefined {
  try {
    return JSON.parse(String(message)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

async function recordSends(page: Page, sends: Array<Record<string, unknown>>): Promise<void> {
  await page.routeWebSocket(/\/ws/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      const frame = frameOf(message);
      if (frame?.type === "call" && frame.method === "send") sends.push(frame);
      server.send(message);
    });
    server.onMessage((message) => socket.send(message));
  });
}

async function dropImage(composer: Awaited<ReturnType<typeof startChat>>): Promise<void> {
  await composer.evaluate(
    (input, { base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: "image/png" }));
      input.dispatchEvent(
        new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }),
      );
    },
    { base64: PNG_BASE64, name: IMAGE },
  );
}

function argsOf(frame: Record<string, unknown>): Record<string, unknown> {
  const args = frame.args;
  return typeof args === "string"
    ? (JSON.parse(args) as Record<string, unknown>)
    : (args as Record<string, unknown>);
}

realTest.setTimeout(300_000);

realTest(
  "a picture from chat A is not sent by the first message of New chat",
  async ({ realApp }) => {
    const sends: Array<Record<string, unknown>> = [];
    const page = await realApp.open({ beforeLoad: (target) => recordSends(target, sends) });
    const chatA = await startChat(page);
    await sendPrompt(chatA, "run_bash");
    await expect(page.getByText("Conversation settled")).toBeVisible({ timeout: 180_000 });
    await dropImage(chatA);
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toBeVisible({
      timeout: 30_000,
    });

    const newChat = await startChat(page);
    await waitForFiniteAnimations(page);
    await expect(page.getByRole("button", { name: `Remove ${IMAGE}` })).toHaveCount(0);
    await sendPrompt(newChat, NEW_CHAT_TEXT);
    await expect(
      page.getByRole("region", { name: "Conversation transcript" }).getByText(NEW_CHAT_TEXT),
    ).toBeVisible({
      timeout: 180_000,
    });

    const sent = sends.find((frame) => JSON.stringify(frame).includes(NEW_CHAT_TEXT));
    expect(sent, "the New chat send frame").toBeDefined();
    const command = argsOf(sent as Record<string, unknown>).command as Record<string, unknown>;
    expect(command.images ?? []).toEqual([]);
    expect(realApp.problems).toEqual([]);
  },
);
