import type { Page, WebSocketRoute } from "@playwright/test";
import { expect, realTest, startChat } from "./real-omp";

interface HeldCatalog {
  released: boolean;
  readonly resultIds: Set<string>;
  readonly held: Array<string | Buffer>;
  release: () => void;
}

function newHeldCatalog(): HeldCatalog {
  return { released: false, resultIds: new Set(), held: [], release: () => undefined };
}

async function holdCatalog(page: Page, hold: HeldCatalog): Promise<void> {
  await page.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    hold.release = () => {
      hold.released = true;
      for (const message of hold.held.splice(0)) socket.send(message);
    };
    socket.onMessage((message) => {
      let frame: unknown;
      try {
        frame = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
      } catch {
        server.send(message);
        return;
      }
      if (
        frame !== null &&
        typeof frame === "object" &&
        "type" in frame &&
        frame.type === "call" &&
        "id" in frame &&
        typeof frame.id === "string" &&
        "method" in frame &&
        frame.method === "send" &&
        "args" in frame &&
        frame.args !== null &&
        typeof frame.args === "object" &&
        "command" in frame.args &&
        frame.args.command !== null &&
        typeof frame.args.command === "object" &&
        "type" in frame.args.command &&
        frame.args.command.type === "get_available_commands"
      ) {
        hold.resultIds.add(frame.id);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const text = typeof message === "string" ? message : message.toString("utf8");
      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        socket.send(message);
        return;
      }
      const isResult =
        frame !== null &&
        typeof frame === "object" &&
        "type" in frame &&
        frame.type === "result" &&
        "id" in frame &&
        typeof frame.id === "string" &&
        hold.resultIds.has(frame.id);
      const isUpdate = text.includes('"available_commands_update"');
      if (!hold.released && (isResult || isUpdate)) {
        hold.held.push(message);
        return;
      }
      socket.send(message);
    });
  });
}

realTest("runs a slash command immediately after New chat opens", async ({ realApp }) => {
  const hold = newHeldCatalog();
  const page = await realApp.open({ beforeLoad: (target) => holdCatalog(target, hold) });
  const input = await startChat(page);
  await input.fill("/goal stable-goal");
  await input.press("Enter");

  await expect(
    page.getByText("Goal set: stable-goal. Status: Active.", { exact: true }),
  ).toBeVisible({
    timeout: 15_000,
  });
  await expect(input).toHaveValue("");
  hold.release();
  expect(realApp.problems).toEqual([]);
});
