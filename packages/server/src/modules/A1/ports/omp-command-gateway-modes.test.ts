import { describe, expect, test } from "bun:test";
import { AppFailure, RequestId, ThreadId } from "@omp-app/contracts";
import type { PortHandlerContext } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { createOmpCommandGatewayRegistration } from "./omp-command-gateway";

const threadId = ThreadId.parse("thread-mode-1");

type Handler = (args: unknown, context: PortHandlerContext) => unknown;

/** A gateway stand-in whose parsed run answers `data(command)`, and which records each command it ran. */
function handlersAnswering(data: (command: string) => unknown): {
  readonly handlers: Readonly<Record<string, Handler>>;
  readonly commands: string[];
} {
  const commands: string[] = [];
  const gateway = {
    onOutput: () => () => undefined,
    onCompaction: () => () => undefined,
    runWithParser: async (args: { readonly command: string }) => {
      commands.push(args.command);
      return { result: undefined, data: data(args.command) };
    },
  };
  return registrationWith(gateway, commands);
}

/** A gateway stand-in whose every run fails with `error`, as the gateway does for an unavailable command. */
function handlersRejecting(error: unknown): {
  readonly handlers: Readonly<Record<string, Handler>>;
} {
  const gateway = {
    onOutput: () => () => undefined,
    onCompaction: () => () => undefined,
    runWithParser: async () => {
      throw error;
    },
  };
  return registrationWith(gateway, []);
}

function registrationWith(
  gateway: object,
  commands: string[],
): { readonly handlers: Readonly<Record<string, Handler>>; readonly commands: string[] } {
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

function modeChangeHandler(handlers: Readonly<Record<string, Handler>>): Handler {
  const handler = handlers.modeChange;
  if (handler === undefined) throw new Error("the modeChange handler is not registered");
  return handler;
}

describe("OmpCommandGateway typed mode-change handler", () => {
  test("modeChange runs the spelled command for the request and returns the parsed outcome", async () => {
    const { handlers, commands } = handlersAnswering(() => ({
      outcome: "applied",
      mode: "slow",
      on: true,
    }));
    await expect(
      modeChangeHandler(handlers)(
        { threadId, request: { mode: "slow", requested: true } },
        handlerContext(),
      ),
    ).resolves.toEqual({ outcome: "applied", mode: "slow", on: true });
    expect(commands).toEqual(["/slow on"]);
  });

  test("a browser window change runs /browser with that window", async () => {
    const { handlers, commands } = handlersAnswering(() => ({
      outcome: "applied",
      mode: "browser",
      visibility: "headless",
    }));
    await expect(
      modeChangeHandler(handlers)(
        { threadId, request: { mode: "browser", visibility: "headless" } },
        handlerContext(),
      ),
    ).resolves.toEqual({ outcome: "applied", mode: "browser", visibility: "headless" });
    expect(commands).toEqual(["/browser headless"]);
  });

  test("a command omp does not offer is unsupported, not a failure", async () => {
    const { handlers } = handlersRejecting(
      new AppFailure({
        code: "unavailable",
        message: "Slash command /computer is not available in this omp session.",
        retryable: true,
      }),
    );
    await expect(
      modeChangeHandler(handlers)(
        { threadId, request: { mode: "computer", requested: true } },
        handlerContext(),
      ),
    ).resolves.toEqual({ outcome: "unsupported", mode: "computer", reason: "not-offered" });
  });

  test("a cancelled change stays a cancellation: it is not turned into an outcome", async () => {
    const { handlers } = handlersRejecting(
      new AppFailure({
        code: "cancelled",
        message: "The command was cancelled.",
        retryable: false,
      }),
    );
    await expect(
      modeChangeHandler(handlers)(
        { threadId, request: { mode: "slow", requested: false } },
        handlerContext(),
      ),
    ).rejects.toMatchObject({ appError: { code: "cancelled" } });
  });

  test("a parsed value that is not a valid outcome is an internal failure, never a guess", async () => {
    const { handlers } = handlersAnswering(() => ({ outcome: "applied", mode: "slow" }));
    await expect(
      modeChangeHandler(handlers)(
        { threadId, request: { mode: "slow", requested: true } },
        handlerContext(),
      ),
    ).rejects.toMatchObject({ appError: { code: "internal", retryable: false } });
  });
});
