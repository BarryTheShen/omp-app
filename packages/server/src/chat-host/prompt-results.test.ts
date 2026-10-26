import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { PromptResultEvent } from "@omp-app/contracts/chat-host";
import { ExtensionMessageTracker, PromptResults, startPrompt } from "./prompt-results";

/** omp's events, built from the fields the results read. */
function event(fields: Record<string, unknown>): AgentSessionEvent {
  return fields as unknown as AgentSessionEvent;
}
const agentStart = event({ type: "agent_start" });
function agentEnd(stopReason: "stop" | "error" | "aborted", fields: Record<string, unknown> = {}) {
  const reply = {
    role: "assistant",
    stopReason,
    api: "openai-completions",
    provider: "fake",
    model: "fake-model",
    ...(stopReason === "error" ? { errorMessage: "The fake provider rejected this request." } : {}),
  };
  return event({
    type: "agent_end",
    messages: [{ role: "user" }, reply],
    yielded: true,
    ...fields,
  });
}

function results(state = { isStreaming: false, queuedMessageCount: 0 }) {
  const sent: PromptResultEvent[] = [];
  return { results: new PromptResults(state, (result) => sent.push(result)), sent, state };
}

/** The results are written in the next macrotask. */
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("prompt results", () => {
  test("a prompt owns the first run started after it was accepted; an earlier run's end does not settle it", async () => {
    const { results: open, sent } = results();
    open.observe(agentStart);
    const ticket = open.begin("7");
    open.observe(agentEnd("stop"));
    open.observe(agentStart);
    open.observe(agentEnd("error"));
    open.settle(ticket);
    await nextTurn();
    expect(sent).toEqual([
      {
        type: "prompt_result",
        requestId: "7",
        agentInvoked: true,
        status: "error",
        error: {
          message: "The fake provider rejected this request.",
          provider: "fake",
          model: "fake-model",
          retryable: false,
        },
      },
    ]);
  });

  test("a prompt queued into a live run is reported at the first yield after the queue is empty", async () => {
    const { results: open, sent, state } = results({ isStreaming: true, queuedMessageCount: 1 });
    const ticket = open.begin("3");
    open.settle(ticket);
    open.observe(agentEnd("stop"));
    await nextTurn();
    expect(sent).toEqual([]);
    state.queuedMessageCount = 0;
    open.observe(agentEnd("aborted"));
    await nextTurn();
    expect(sent.map((result) => [result.requestId, result.status])).toEqual([["3", "aborted"]]);
  });

  test("the agent's own follow-up work (a retry) is not the end of the prompt", async () => {
    const { results: open, sent } = results();
    const ticket = open.begin("1");
    open.observe(agentStart);
    open.observe(agentEnd("error", { yielded: false }));
    open.settle(ticket);
    open.observe(agentStart);
    open.observe(agentEnd("stop"));
    await nextTurn();
    expect(sent.map((result) => result.status)).toEqual(["completed"]);
  });

  test("a prompt that reached no run before an abort is reported aborted", async () => {
    const { results: open, sent } = results();
    open.settle(open.begin("2"));
    await nextTurn();
    expect(sent.map((result) => result.status)).toEqual(["aborted"]);
  });

  test("a result is written after the current turn, so it follows its prompt's response", async () => {
    const { results: open, sent } = results();
    const ticket = open.begin("4");
    open.observe(agentStart);
    open.observe(agentEnd("stop"));
    open.settle(ticket);
    expect(sent).toEqual([]);
    await nextTurn();
    expect(sent).toHaveLength(1);
  });
});

describe("starting a prompt", () => {
  test("a prompt refused before omp admitted it answers with the failure and owes no result", async () => {
    const { results: open, sent } = results();
    const ticket = open.begin("5");
    const start = await startPrompt({
      ticket,
      results: open,
      tracker: new ExtensionMessageTracker(),
      run: async () => {
        throw new Error("Agent is busy");
      },
    });
    expect(start).toEqual({ admitted: false, error: new Error("Agent is busy") });
    open.discard(ticket);
    await nextTurn();
    expect(sent).toEqual([]);
  });

  test("a failure after admission is the prompt's result", async () => {
    const { results: open, sent } = results();
    const failed = Promise.withResolvers<boolean>();
    const start = await startPrompt({
      ticket: open.begin("6"),
      results: open,
      tracker: new ExtensionMessageTracker(),
      run: (onPromptAdmitted) => {
        onPromptAdmitted();
        return failed.promise;
      },
    });
    expect(start).toEqual({ admitted: true });
    failed.reject(new Error("the provider went away"));
    await nextTurn();
    await nextTurn();
    expect(sent).toEqual([
      {
        type: "prompt_result",
        requestId: "6",
        agentInvoked: false,
        status: "error",
        error: { message: "the provider went away", retryable: false },
      },
    ]);
  });
});
