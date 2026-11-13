import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderPath, RequestId } from "@omp-app/contracts";
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

  test("omp updates: on with no job until a job writes; its last word read back; the switch writes what the job reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "omp-updates-"));
    try {
      const files = {
        status: join(dir, "omp-update.json"),
        settings: join(dir, "omp-update-settings.json"),
      };
      const handlers = appHandlers({ ompUpdates: files });
      const read = () => handler(handlers, "ompUpdates")({}, call());
      expect(await read()).toEqual({ enabled: true, job: null });

      // As the night job writes it, with a field of its own that the app passes over.
      const lastNight = { at: "2026-11-16T06:00:00.012Z", result: "No new omp to try." };
      await writeFile(
        files.status,
        JSON.stringify({ version: 1, lastNight, pending: "18.18.9", told: ["x"] }),
      );
      expect(await read()).toEqual({ enabled: true, job: { lastNight, pending: "18.18.9" } });
      await writeFile(
        files.status,
        JSON.stringify({ version: 1, lastNight, blocked: "back on 0.3.1632" }),
      );
      expect(((await read()) as { job: unknown }).job).toEqual({
        lastNight,
        blocked: "back on 0.3.1632",
      });
      // A file of another shape is no job's word: nothing is shown rather than something wrong.
      await writeFile(files.status, JSON.stringify({ version: 2, lastNight }));
      expect(((await read()) as { job: unknown }).job).toBeNull();

      const off = await handler(handlers, "setOmpUpdates")({ enabled: false }, call());
      expect(off).toMatchObject({ enabled: false });
      expect(JSON.parse(await readFile(files.settings, "utf8"))).toEqual({
        version: 1,
        enabled: false,
      });
      expect(await handler(handlers, "setOmpUpdates")({ enabled: true }, call())).toMatchObject({
        enabled: true,
      });

      // A settings file that cannot be read is off, as the job reads it: the switch never says on while the job is off.
      await writeFile(files.settings, "{ not json");
      expect(await read()).toMatchObject({ enabled: false });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("without the files a run reads no job and cannot save the switch", async () => {
    expect(await handler(appHandlers(), "ompUpdates")({}, call())).toEqual({
      enabled: true,
      job: null,
    });
    await expect(
      handler(appHandlers(), "setOmpUpdates")({ enabled: false }, call()),
    ).rejects.toMatchObject({
      appError: { code: "unavailable" },
    });
  });
});
