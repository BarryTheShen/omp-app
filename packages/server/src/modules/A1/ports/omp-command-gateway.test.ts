import { describe, expect, test } from "bun:test";
import { AppFailure, RequestId, ThreadId } from "@omp-app/contracts";
import type { PortHandlerContext } from "../../../registry/ports";
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

async function expectInternalFailure(run: () => unknown): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (error instanceof AppFailure) {
      expect(error.appError).toMatchObject({ code: "internal", retryable: false });
      return;
    }
    throw error;
  }
  throw new Error("the handler resolved where an internal failure was expected");
}

describe("OmpCommandGateway typed share and dump handlers", () => {
  test("share runs /share and returns the parsed link", async () => {
    const url = "https://share.example.test/abc1234567#key";
    const { handlers, commands } = handlersAnswering(() => ({ url, truncated: false }));
    const share = handlers.share;
    if (share === undefined) throw new Error("the share handler is not registered");
    await expect(share({ threadId }, handlerContext())).resolves.toEqual({
      url,
      truncated: false,
    });
    expect(commands).toEqual(["/share"]);
  });

  test("dump runs /dump for the session scope and /dump all for the all scope", async () => {
    const { handlers, commands } = handlersAnswering((command) => ({
      scope: command === "/dump all" ? "all" : "session",
      text: `report for ${command}`,
      empty: false,
    }));
    const dump = handlers.dump;
    if (dump === undefined) throw new Error("the dump handler is not registered");
    await expect(dump({ threadId, scope: "session" }, handlerContext())).resolves.toEqual({
      scope: "session",
      text: "report for /dump",
      empty: false,
    });
    await expect(dump({ threadId, scope: "all" }, handlerContext())).resolves.toEqual({
      scope: "all",
      text: "report for /dump all",
      empty: false,
    });
    expect(commands).toEqual(["/dump", "/dump all"]);
  });

  test("a command with no parser (raw frames) is never returned as a typed reply", async () => {
    const raw = {
      command: "/share",
      agentInvoked: false,
      outputs: [],
      sessionUpdates: [],
      configUpdates: [],
    };
    const { handlers } = handlersAnswering(() => raw);
    const share = handlers.share;
    if (share === undefined) throw new Error("the share handler is not registered");
    await expectInternalFailure(() => share({ threadId }, handlerContext()));
  });

  test("a share result that is not an https link is an internal failure", async () => {
    const { handlers } = handlersAnswering(() => ({
      url: "http://share.example.test/x",
      truncated: false,
    }));
    const share = handlers.share;
    if (share === undefined) throw new Error("the share handler is not registered");
    await expectInternalFailure(() => share({ threadId }, handlerContext()));
  });
});
