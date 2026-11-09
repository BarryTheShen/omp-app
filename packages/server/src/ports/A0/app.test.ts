import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { FolderPath, RequestId } from "@omp-app/contracts";
import { EmbeddersStore } from "../../embedders";
import { ensureHostFolder, HostFolderRefused } from "../../host-folders";
import type { Logger } from "../../logging";
import { OmpProcessRegistry } from "../../process";
import type { PortHandlerContext } from "../../registry/ports";
import { EventReplayHub } from "../../replay";
import { createAppPortRegistration } from "./app";
import type { A0PortContext } from "./context";

type HandlerSet = Readonly<Record<string, (args: unknown, context: PortHandlerContext) => unknown>>;

/** AppPort over a context with no chats: AppPort starts none. */
function appHandlers(overrides: Partial<A0PortContext> = {}): HandlerSet {
  const context: A0PortContext = {
    processRegistry: new OmpProcessRegistry({
      createProcess: () => {
        throw new Error("AppPort starts no chat");
      },
    }),
    replay: new EventReplayHub(),
    capabilities: {},
    resolveThread: async () => undefined,
    externalOmp: async () => "none",
    latestThread: async () => undefined,
    serverInfo: {
      instanceId: "instance-a0-7",
      serverVersion: "test",
      launchFolder: FolderPath.parse("/workspace"),
      omp: null,
    },
    health: { status: "ok" },
    ...overrides,
  };
  return createAppPortRegistration(context).handlers as HandlerSet;
}

function handler(handlers: HandlerSet, name: string) {
  const found = handlers[name];
  if (found === undefined) throw new Error(`missing handler ${name}`);
  return found;
}

function call(): PortHandlerContext {
  return {
    signal: new AbortController().signal,
    connectionId: "app",
    requestId: RequestId.parse("call-app"),
    portContext: undefined,
  };
}

/** A logger that keeps what it is told. */
function keepingLogger(): {
  readonly logger: Logger;
  readonly events: Array<{ level: string; event: string; fields: Record<string, unknown> }>;
} {
  const events: Array<{ level: string; event: string; fields: Record<string, unknown> }> = [];
  return {
    events,
    logger: {
      path: "/log/omp-app.log",
      info: (event, fields) => events.push({ level: "info", event, fields: { ...fields } }),
      warn: (event, fields) => events.push({ level: "warn", event, fields: { ...fields } }),
      error: (event, fields) => events.push({ level: "error", event, fields: { ...fields } }),
      addSecret: () => undefined,
      tail: () => "",
    },
  };
}

describe("AppPort", () => {
  test("returns server information, capabilities and health", () => {
    const app = appHandlers();
    expect(handler(app, "serverInfo")({}, call())).toMatchObject({ instanceId: "instance-a0-7" });
    expect(handler(app, "capabilities")({}, call())).toEqual({});
    expect(handler(app, "health")({}, call())).toEqual({ status: "ok" });
  });

  test("browser errors reach the debug log cut to size, and a page stuck in a loop cannot flood it", () => {
    const { logger, events } = keepingLogger();
    const report = handler(appHandlers({ logger }), "reportClientError");
    expect(
      report(
        {
          kind: "unhandledrejection",
          message: "x".repeat(1_500),
          stack: "s".repeat(4_000),
          page: "http://127.0.0.1:4317/",
        },
        call(),
      ),
    ).toBeNull();
    expect(events).toHaveLength(1);
    expect(events[0]?.event).toBe("client.error");
    expect(String(events[0]?.fields.message).length).toBeLessThan(530);
    expect(String(events[0]?.fields.stack).length).toBeLessThan(2_030);
    expect(events[0]?.fields.kind).toBe("unhandledrejection");

    for (let index = 0; index < 100; index += 1) {
      report({ kind: "console", message: `loop ${index}` }, call());
    }
    // 30 a minute at most (the first report counts): the rest are dropped.
    expect(events.filter((event) => event.event === "client.error")).toHaveLength(30);
  });

  test("browser performance traces reach the log with names and numbers only", () => {
    const { logger, events } = keepingLogger();
    expect(
      handler(appHandlers({ logger }), "reportClientTrace")(
        { marks: { click: 1, newest_20_painted: 44 }, gaps: [52], supported: ["layout-shift"] },
        call(),
      ),
    ).toBeNull();
    expect(events).toEqual([
      {
        level: "info",
        event: "trace",
        fields: {
          mark_click: 1,
          mark_newest_20_painted: 44,
          gaps: [52],
          supported: ["layout-shift"],
        },
      },
    ]);
  });

  test("the debug report comes from the composition's seam, and is unavailable without one", async () => {
    await expect(handler(appHandlers(), "debugReport")({}, call())).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
    const withSeam = appHandlers({
      debugReport: async () => ({ fileName: "omp-app-debug-x.log", text: "report text" }),
    });
    expect(await handler(withSeam, "debugReport")({}, call())).toEqual({
      fileName: "omp-app-debug-x.log",
      text: "report text",
    });
  });

  test("lists who may frame the lite view, saves a new list, and refuses one with a source it does not take", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "app-embedders-")), "embedders.json");
    try {
      const handlers = appHandlers({
        embedders: { fixed: ["http://127.0.0.1:9000"], store: await EmbeddersStore.open(path) },
      });
      expect(handler(handlers, "embedders")({}, call())).toEqual({
        fixed: ["http://127.0.0.1:9000"],
        saved: [],
      });
      expect(
        await handler(handlers, "setEmbedders")({ sources: ["moz-extension:"] }, call()),
      ).toEqual({ fixed: ["http://127.0.0.1:9000"], saved: ["moz-extension:"] });
      await expect(
        handler(handlers, "setEmbedders")(
          { sources: ["http://example.com"] },
          call(),
        ) as Promise<unknown>,
      ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
      expect(handler(handlers, "embedders")({}, call())).toMatchObject({
        saved: ["moz-extension:"],
      });
      // A run of the app with no settings for it says so.
      await expect(
        handler(appHandlers(), "setEmbedders")({ sources: [] }, call()) as Promise<unknown>,
      ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    } finally {
      await rm(dirname(path), { recursive: true, force: true });
    }
  });

  test("makes a project's host folder, private and empty, the same one each time; refuses a host it does not take", async () => {
    const appData = await mkdtemp(join(tmpdir(), "app-host-folders-"));
    try {
      const handlers = appHandlers({
        hostFolders: {
          ensure: (host, project, id) => ensureHostFolder(appData, host, project, id),
          refused: (error) => error instanceof HostFolderRefused,
        },
      });
      const asked = { host: "vscode", project: "My App", id: "0123456789abcdef0123" };
      const made = (await handler(handlers, "hostFolder")(asked, call())) as { folder: string };
      expect(made.folder).toBe(join(appData, "host-folders", "vscode", "my-app-0123456789ab"));
      expect((await stat(made.folder)).mode & 0o777).toBe(0o700);
      expect(await readdir(made.folder)).toEqual([]);
      expect(await handler(handlers, "hostFolder")(asked, call())).toEqual(made);
      await expect(
        handler(handlers, "hostFolder")({ ...asked, host: "../etc" }, call()) as Promise<unknown>,
      ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
      // A run of the app that cannot keep such folders says so.
      await expect(
        handler(appHandlers(), "hostFolder")(asked, call()) as Promise<unknown>,
      ).rejects.toMatchObject({ appError: { code: "unavailable" } });
    } finally {
      await rm(appData, { recursive: true, force: true });
    }
  });
});
