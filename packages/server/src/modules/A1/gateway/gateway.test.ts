import { describe, expect, test } from "bun:test";
import { type AbortSignalLike, AppFailure, ThreadId } from "@omp-app/contracts";
import {
  type CommandListing,
  type CommandPromptFuture,
  type CommandPromptOutcome,
  type CommandSession,
  type CommandSessionEvent,
  withAdmission,
} from "./command-session";
import {
  type CommandParserContext,
  createOmpCommandGateway,
  OmpCommandGatewayService,
} from "./gateway";

/** One prompt the gateway sent: the test admits it, then settles or fails it, as omp would. */
interface SentPrompt {
  readonly text: string;
  admit(agentInvoked: boolean): void;
  settle(outcome: CommandPromptOutcome): void;
  fail(error: AppFailure): void;
}

/**
 * A chat's command session the test drives (the gateway's whole view of a chat since SDK plan H5.3e): it lists omp's
 * commands, records each prompt, and sends the chat's command events.
 */
class FakeCommandSession implements CommandSession {
  commands: readonly string[] = [];
  listings = 0;
  readonly prompts: SentPrompt[] = [];
  readonly #listeners = new Set<(event: CommandSessionEvent) => void>();

  async availableCommands(): Promise<readonly CommandListing[]> {
    this.listings += 1;
    return this.commands.map((name) => ({ name }));
  }

  prompt(text: string, signal?: AbortSignalLike): CommandPromptFuture {
    const admitted = Promise.withResolvers<{ readonly agentInvoked: boolean }>();
    const outcome = Promise.withResolvers<CommandPromptOutcome>();
    const fail = (error: AppFailure): void => {
      admitted.reject(error);
      outcome.reject(error);
    };
    // As a command session promises: an aborted signal gives up the wait, not omp's run.
    signal?.addEventListener(
      "abort",
      () => fail(new AppFailure({ code: "cancelled", message: "cancelled", retryable: false })),
      { once: true },
    );
    this.prompts.push({
      text,
      admit: (agentInvoked) => admitted.resolve({ agentInvoked }),
      settle: (value) => outcome.resolve(value),
      fail,
    });
    return withAdmission(outcome.promise, admitted.promise);
  }

  onEvent(listener: (event: CommandSessionEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  emit(event: CommandSessionEvent): void {
    for (const listener of [...this.#listeners]) listener(event);
  }

  /** The prompt the gateway sent at `index`; the test fails when it sent none. */
  sent(index = 0): SentPrompt {
    const prompt = this.prompts[index];
    if (prompt === undefined) throw new Error(`the gateway sent no prompt ${index}`);
    return prompt;
  }
}

/** omp answered a command without the model (a built-in or an extension's command): admitted and settled at once. */
function answerLocally(prompt: SentPrompt): void {
  prompt.admit(false);
  prompt.settle({ agentInvoked: false, status: "completed", promptSettled: true });
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
}

const threadId = ThreadId.parse("thread-1");

function createHarness(commands: readonly string[]) {
  const session = new FakeCommandSession();
  session.commands = commands;
  const errors: AppFailure[] = [];
  const gateway = new OmpCommandGatewayService({
    resolveSession: () => session,
    onError: (error) => errors.push(error),
  });
  return { session, gateway, errors };
}

/** The rejection of a promise that must reject. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );
}

describe("OmpCommandGatewayService", () => {
  test("resolves only at the prompt's settlement, not at its admission", async () => {
    const { session, gateway } = createHarness(["compact"]);
    const future = gateway.run({ threadId, command: "/compact" });
    await flush();
    const prompt = session.sent();
    expect(prompt.text).toBe("/compact");
    prompt.admit(true);
    await expect(future.admitted).resolves.toEqual({ agentInvoked: true });

    let settled = false;
    void future.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);

    prompt.settle({ agentInvoked: true, status: "completed", promptSettled: false });
    const result = await future;
    expect(settled).toBe(true);
    expect(result).toMatchObject({
      command: "/compact",
      status: "completed",
      agentInvoked: true,
      promptSettled: false,
      sessionSettled: false,
      outputs: [],
      sessionUpdates: [],
      configUpdates: [],
    });
  });

  test("output omp prints before it admits the prompt is kept, and a prompt that ends aborted completes with it", async () => {
    // omp's idle `/fresh` prints its line, then answers the prompt, then ends it as aborted.
    const { session, gateway } = createHarness(["fresh"]);
    const future = gateway.run({ threadId, command: "/fresh" });
    await flush();
    const prompt = session.sent();
    session.emit({
      type: "command_output",
      text: "Fresh provider session started (0 provider states pruned).",
    });
    prompt.admit(true);
    await expect(future.admitted).resolves.toEqual({ agentInvoked: true });
    prompt.settle({ agentInvoked: true, status: "aborted", promptSettled: true });
    expect(await future).toMatchObject({
      command: "/fresh",
      agentInvoked: true,
      status: "aborted",
      outputs: [{ text: "Fresh provider session started (0 provider states pruned)." }],
    });
  });

  test("collects the command's output, title and configuration changes, and streams its output live", async () => {
    const { session, gateway } = createHarness(["compact"]);
    const future = gateway.run({ threadId, command: "/compact" });
    await flush();
    const prompt = session.sent();
    prompt.admit(true);
    await flush();

    const liveOutputs: unknown[] = [];
    gateway.onOutput((event) => liveOutputs.push(event));

    session.emit({ type: "command_output", text: "Compacting…" });
    session.emit({ type: "session_info_update", sessionId: threadId, title: "Compacted session" });
    session.emit({ type: "config_update", thinkingLevel: "low" });
    session.emit({ type: "command_output", text: "Done." });
    await flush();

    prompt.settle({ agentInvoked: true, status: "completed", promptSettled: true });
    const result = await future;

    expect(result.outputs.map((output) => output.text)).toEqual(["Compacting…", "Done."]);
    expect(result.sessionUpdates).toEqual([{ sessionId: threadId, title: "Compacted session" }]);
    expect(result.configUpdates).toEqual([{ thinkingLevel: "low" }]);
    expect(result.promptSettled).toBe(true);
    expect(liveOutputs).toEqual([
      { threadId, output: { text: "Compacting…" } },
      { threadId, output: { text: "Done." } },
    ]);
  });

  test("runs a second command for the same chat only after the first settles", async () => {
    const { session, gateway } = createHarness(["compact", "model"]);
    const first = gateway.run({ threadId, command: "/compact" });
    await flush();
    session.sent(0).admit(true);
    await flush();

    const second = gateway.run({ threadId, command: "/model" });
    await flush();
    expect(session.prompts).toHaveLength(1);

    session.sent(0).settle({ agentInvoked: true, status: "completed", promptSettled: true });
    await first;
    await flush();
    expect(session.sent(1).text).toBe("/model");
    answerLocally(session.sent(1));
    expect(await second).toMatchObject({
      command: "/model",
      agentInvoked: false,
      promptSettled: true,
    });
  });

  test("a command no parser knows returns what it collected as data", async () => {
    const { session, gateway } = createHarness(["model"]);
    const future = gateway.runWithParser({ threadId, command: "/model gpt-5" });
    await flush();
    answerLocally(session.sent());
    const { result, data } = await future;
    expect(result.command).toBe("/model gpt-5");
    const raw = data as CommandParserContext;
    expect(raw.outputs).toEqual([]);
    expect(raw.sessionUpdates).toEqual([]);
    expect(raw.configUpdates).toEqual([]);
  });

  test("an unavailable command fails before its prompt is sent", async () => {
    const { session, gateway } = createHarness(["compact"]);
    const rejection = await rejectionOf(gateway.run({ threadId, command: "/not-a-real-command" }));
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError.code).toBe("unavailable");
    expect(session.listings).toBe(1);
    expect(session.prompts).toEqual([]);
  });

  test("a colon form is checked by the name omp reads, and omp gets the text as typed", async () => {
    const { session, gateway } = createHarness(["force"]);
    const future = gateway.run({ threadId, command: "/force:read summarize" });
    await flush();
    expect(session.sent().text).toBe("/force:read summarize");
    answerLocally(session.sent());
    await expect(future).resolves.toMatchObject({ command: "/force:read summarize" });
  });

  test("a colon name omp does not list is unavailable, and nothing is sent", async () => {
    const { session, gateway } = createHarness(["force"]);
    const rejection = await rejectionOf(
      gateway.run({ threadId, command: "/nosuch:read summarize" }),
    );
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError.code).toBe("unavailable");
    expect(session.prompts).toEqual([]);
  });

  test("cancels a running command and rejects with AppFailure cancelled", async () => {
    const { session, gateway } = createHarness(["compact"]);
    const controller = new AbortController();
    const future = gateway.run({ threadId, command: "/compact" }, { signal: controller.signal });
    await flush();
    session.sent().admit(true);
    await flush();

    controller.abort();
    const rejection = await rejectionOf(future);
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError.code).toBe("cancelled");
  });

  test("a prompt omp fails rejects with omp's failure", async () => {
    const { session, gateway } = createHarness(["compact"]);
    const future = gateway.run({ threadId, command: "/compact" });
    await flush();
    session.sent().admit(true);
    await flush();
    session
      .sent()
      .fail(new AppFailure({ code: "omp_error", message: "model unavailable", retryable: true }));
    const rejection = await rejectionOf(future);
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError).toMatchObject({
      code: "omp_error",
      retryable: true,
    });
  });

  test("a parser that throws is reported and rejects without crashing", async () => {
    const { session, gateway, errors } = createHarness(["compact"]);
    gateway.registerCommandParser("compact", () => {
      throw new Error("parser exploded");
    });
    const future = gateway.runWithParser({ threadId, command: "/compact" });
    await flush();
    answerLocally(session.sent());
    const rejection = await rejectionOf(future);
    expect(rejection).toBeInstanceOf(AppFailure);
    expect((rejection as AppFailure).appError).toMatchObject({
      code: "internal",
      retryable: false,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.appError.code).toBe("internal");
  });

  test("rejects a duplicate parser registration for the same command name", () => {
    const gateway = new OmpCommandGatewayService({
      resolveSession: () => {
        throw new Error("not used in this test");
      },
    });
    gateway.registerCommandParser("compact", () => "first");
    expect(() => gateway.registerCommandParser("compact", () => "second")).toThrow(
      /Duplicate command parser registration/,
    );
  });

  test("the app's gateway already has typed /share, /dump, /session, /tools and /memory parsers registered", () => {
    const gateway = createOmpCommandGateway({
      resolveSession: () => {
        throw new Error("not used in this test");
      },
    });
    for (const name of ["share", "dump", "session", "tools", "memory"]) {
      expect(() => gateway.registerCommandParser(name, () => "again")).toThrow(
        new RegExp(`Duplicate command parser registration for ${name}`),
      );
    }
  });

  test("a /compact that finishes in the background reports its saved outcome once, and other output nothing", async () => {
    const { session, gateway } = createHarness(["compact"]);
    const outcomes: unknown[] = [];
    gateway.onCompaction((event) => outcomes.push(event));
    const future = gateway.run({ threadId, command: "/compact soft" });
    await flush();
    // omp answers the prompt without a turn. The compaction runs after that, and omp prints its result then.
    answerLocally(session.sent());
    await expect(future).resolves.toMatchObject({ command: "/compact soft", agentInvoked: false });
    session.emit({ type: "command_output", text: "Done." });
    await flush();
    expect(outcomes).toEqual([]);
    session.emit({
      type: "command_output",
      text: "Compaction complete. Tokens: 120000 -> 28000 (saved 92000).",
    });
    session.emit({ type: "command_output", text: "Compaction complete." });
    await flush();
    expect(outcomes).toEqual([{ threadId, outcome: "saved" }]);
  });

  test("a background /compact that fails reports a failed outcome, without omp's words in the event", async () => {
    const { session, gateway } = createHarness(["compact"]);
    const outcomes: unknown[] = [];
    gateway.onCompaction((event) => outcomes.push(event));
    const future = gateway.run({ threadId, command: "/compact" });
    await flush();
    answerLocally(session.sent());
    await future;
    session.emit({ type: "command_output", text: "Compaction failed: nothing to compact." });
    await flush();
    expect(outcomes).toEqual([{ threadId, outcome: "failed" }]);
  });

  test("only /compact is watched: another background command's compaction-like text reports nothing", async () => {
    const { session, gateway } = createHarness(["fresh"]);
    const outcomes: unknown[] = [];
    gateway.onCompaction((event) => outcomes.push(event));
    const future = gateway.run({ threadId, command: "/fresh" });
    await flush();
    answerLocally(session.sent());
    await future;
    session.emit({ type: "command_output", text: "Compaction complete." });
    await flush();
    expect(outcomes).toEqual([]);
  });
});
