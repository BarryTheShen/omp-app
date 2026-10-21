import type { Page, WebSocketRoute } from "@playwright/test";

/*
 * Holds the app's file-search answers (`A1.fileSearch`, `search`) until the spec releases them, so a file list can be
 * seen while it is still loading. Every other frame passes through unchanged and in order. The S2 specs hold omp's
 * command list the same way (hold-catalog.ts).
 */
export interface HeldFileSearch {
  released: boolean;
  readonly ids: Set<string>;
  readonly held: Array<string | Buffer>;
  release: () => void;
}

export function newHeldFileSearch(): HeldFileSearch {
  return { released: false, ids: new Set(), held: [], release: () => undefined };
}

interface FrameFields {
  readonly type: unknown;
  readonly id: unknown;
  readonly port: unknown;
}

/** The type, id and port of a frame. A message that is not a JSON object has none, and passes through. */
function frameFields(message: string | Buffer): FrameFields {
  const none: FrameFields = { type: undefined, id: undefined, port: undefined };
  let frame: unknown;
  try {
    frame = JSON.parse(typeof message === "string" ? message : message.toString("utf8"));
  } catch {
    return none;
  }
  if (frame === null || typeof frame !== "object") return none;
  return {
    type: "type" in frame ? frame.type : undefined,
    id: "id" in frame ? frame.id : undefined,
    port: "port" in frame ? frame.port : undefined,
  };
}

export async function holdFileSearch(page: Page, hold: HeldFileSearch): Promise<void> {
  await page.routeWebSocket(/\/ws/, (socket: WebSocketRoute) => {
    const server = socket.connectToServer();
    hold.release = () => {
      hold.released = true;
      for (const message of hold.held.splice(0)) socket.send(message);
    };
    socket.onMessage((message) => {
      const fields = frameFields(message);
      if (
        fields.type === "call" &&
        fields.port === "A1.fileSearch" &&
        typeof fields.id === "string"
      ) {
        hold.ids.add(fields.id);
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const fields = frameFields(message);
      const isAnswer =
        fields.type === "result" && typeof fields.id === "string" && hold.ids.has(fields.id);
      if (!hold.released && isAnswer) {
        hold.held.push(message);
        return;
      }
      socket.send(message);
    });
  });
}
