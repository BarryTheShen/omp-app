import type { Page, WebSocketRoute } from "@playwright/test";

/**
 * Holds omp's answer to `get_available_commands`, and the `available_commands_update` frames that carry the list, until
 * the spec releases them: the app then shows its slash list while omp has not answered. Every other frame passes through
 * unchanged and in order. Taken out of fix-1959-slash-before-live.spec.ts for the fix-2175 specs.
 */
export interface HeldCatalog {
  released: boolean;
  readonly resultIds: Set<string>;
  readonly held: Array<string | Buffer>;
  release: () => void;
}

export function newHeldCatalog(): HeldCatalog {
  return { released: false, resultIds: new Set(), held: [], release: () => undefined };
}

export async function holdCatalog(page: Page, hold: HeldCatalog): Promise<void> {
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
        "port" in frame &&
        frame.port === "A0.chatSession" &&
        "method" in frame &&
        frame.method === "request" &&
        "args" in frame &&
        frame.args !== null &&
        typeof frame.args === "object" &&
        "method" in frame.args &&
        frame.args.method === "get_available_commands"
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
