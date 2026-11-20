import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RequestId, ThreadId } from "@omp-app/contracts";
import type { PortHandlerContext } from "../../../registry/ports";
import { BackgroundJobStopStoreService } from "../background-jobs";
import type { A1PortContext } from "./context";
import { createOmpCommandGatewayRegistration } from "./omp-command-gateway";

const threadId = ThreadId.parse("thread-port-1");

type Handler = (args: unknown, context: PortHandlerContext) => unknown;

/**
 * A gateway stand-in: it records each command the typed handlers run and answers with `reply`, the
 * value a parser would have produced (or, for the refusal case, the raw frames of an unparsed command).
 */
function handlersAnswering(reply: (command: string) => unknown): {
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly commands: string[];
} {
  const commands: string[] = [];
  const gateway = {
    onOutput: () => () => undefined,
    onCompaction: () => () => undefined,
    runWithParser: async (args: { readonly command: string }) => {
      commands.push(args.command);
      return { result: undefined, data: reply(args.command) };
    },
  };
  const context = {
    ompCommandGateway: gateway,
    publish: () => undefined,
    watchStreamActivity: () => () => undefined,
  } as unknown as A1PortContext;
  const { handlers } = createOmpCommandGatewayRegistration(context);
  return { handlers, commands };
}

function handlerContext(): PortHandlerContext {
  return {
    signal: new AbortController().signal,
    connectionId: "test-connection",
    requestId: RequestId.parse("test-request"),
    portContext: undefined,
  };
}

describe("OmpCommandGateway typed tools handler", () => {
  test("runs /tools and returns its parsed availability rows", async () => {
    const { handlers, commands } = handlersAnswering(() => ({
      tools: [
        { tool: "ast_edit", state: "fallback" },
        { tool: "debug", state: "fallback" },
        { tool: "lsp", state: "fallback" },
        { tool: "read", state: "available" },
      ],
    }));
    const tools = handlers.tools;
    if (tools === undefined) throw new Error("the tools handler is not registered");
    await expect(tools({ threadId }, handlerContext())).resolves.toEqual({
      tools: [
        { tool: "ast_edit", state: "fallback" },
        { tool: "debug", state: "fallback" },
        { tool: "lsp", state: "fallback" },
        { tool: "read", state: "available" },
      ],
    });
    expect(commands).toEqual(["/tools"]);
  });
});

/** The time the stop-recording tests' store stamps each stop with (ms). */
const STOPPED_AT = 1_700_000_000_000;

describe("OmpCommandGateway records the stops the chat's Stop control confirms", () => {
  /** The handler a registration names. A registration without it is a test bug, so this throws. */
  function handlerNamed(handlers: Readonly<Record<string, Handler>>, name: string): Handler {
    const handler = handlers[name];
    if (handler === undefined) throw new Error(`the registration has no ${name} handler`);
    return handler;
  }

  async function recordingHarness(
    texts: readonly string[],
    status: "completed" | "aborted" = "completed",
  ) {
    const root = await mkdtemp(join(tmpdir(), "omp-command-stops-"));
    const gateway = {
      onOutput: () => () => undefined,
      onCompaction: () => () => undefined,
      run: async (args: { readonly command: string }) => ({
        command: args.command,
        status,
        agentInvoked: false,
        promptSettled: true,
        sessionSettled: true,
        outputs: texts.map((text) => ({ text })),
        sessionUpdates: [],
        configUpdates: [],
      }),
    };
    const context = {
      ompCommandGateway: gateway,
      backgroundJobStopStore: new BackgroundJobStopStoreService({
        appDataDir: join(root, "app"),
        now: () => STOPPED_AT,
      }),
      publish: () => undefined,
      watchStreamActivity: () => () => undefined,
    } as unknown as A1PortContext;
    const { handlers } = createOmpCommandGatewayRegistration(context);
    return {
      root,
      run: handlerNamed(handlers, "run"),
      stops: handlerNamed(handlers, "backgroundJobStops"),
    };
  }

  test("a cancel omp confirms is kept for the chat, with its time, and read back by its stops", async () => {
    const { root, run, stops } = await recordingHarness(["Cancelled background job bg_1."]);
    try {
      await run({ threadId, command: "/jobs kill bg_1" }, handlerContext());
      expect(await stops({ threadId }, handlerContext())).toEqual({
        stops: [{ jobId: "bg_1", status: "stopped", at: STOPPED_AT }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a job omp had already finished is kept as finished, with its time", async () => {
    const { root, run, stops } = await recordingHarness([
      'No running background job with id "bg_2".',
    ]);
    try {
      await run({ threadId, command: "/jobs kill bg_2" }, handlerContext());
      expect(await stops({ threadId }, handlerContext())).toEqual({
        stops: [{ jobId: "bg_2", status: "finished", at: STOPPED_AT }],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a stop that did not happen, an aborted run, or another command keeps nothing", async () => {
    const cases = [
      {
        texts: ["Could not cancel background job bg_3."],
        status: "completed",
        command: "/jobs kill bg_3",
      },
      { texts: ["Cancelled background job bg_3."], status: "aborted", command: "/jobs kill bg_3" },
      { texts: ["Cancelled background job bg_3."], status: "completed", command: "/jobs list" },
    ] as const;
    for (const { texts, status, command } of cases) {
      const { root, run, stops } = await recordingHarness(texts, status);
      try {
        await run({ threadId, command }, handlerContext());
        expect(await stops({ threadId }, handlerContext())).toEqual({ stops: [] });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  });
});
