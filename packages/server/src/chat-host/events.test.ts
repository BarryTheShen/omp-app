import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { ChatEvent } from "@omp-app/contracts/chat-host";
import { SessionEventStream } from "./events";

/** omp's events, built from the fields the stream reads; the rest of omp's shapes does not matter here. */
function event(fields: Record<string, unknown>): AgentSessionEvent {
  return fields as unknown as AgentSessionEvent;
}
const assistant = { role: "assistant", content: [{ type: "text", text: "so far" }] };
const start = (message: object = assistant) => event({ type: "message_start", message });
const update = (delta: string) =>
  event({
    type: "message_update",
    message: assistant,
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial: assistant },
  });
const end = (message: object = assistant) => event({ type: "message_end", message });

function streamOf(): { readonly stream: SessionEventStream; readonly sent: ChatEvent[] } {
  const sent: ChatEvent[] = [];
  return { stream: new SessionEventStream((sentEvent) => sent.push(sentEvent)), sent };
}

function idsOf(sent: readonly ChatEvent[]): (string | undefined)[] {
  return sent.map((sentEvent) => ("messageId" in sentEvent ? sentEvent.messageId : undefined));
}

describe("the chat's event stream", () => {
  test("a message keeps one id from start to end, and a record that starts inside a streaming reply gets its own", () => {
    const { stream, sent } = streamOf();
    for (const sentEvent of [
      start(),
      update("a"),
      start({ role: "custom", customType: "advisor" }),
      end({ role: "custom", customType: "advisor" }),
      update("b"),
      end(),
    ]) {
      stream.forward(sentEvent);
    }
    expect(idsOf(sent)).toEqual(["msg-1", "msg-1", "msg-2", "msg-2", "msg-1", "msg-1"]);
  });

  test("in the delta form an update carries its increment, not the reply so far", () => {
    const { stream, sent } = streamOf();
    stream.setOptions({ messageUpdates: "delta" });
    stream.forward(start());
    stream.forward(update("next"));
    expect(sent[1]).toEqual({
      type: "message_update",
      messageId: "msg-1",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next" },
    });
  });

  test("the full form keeps omp's whole update", () => {
    const { stream, sent } = streamOf();
    stream.forward(start());
    stream.forward(update("next"));
    const whole = { ...update("next"), messageId: "msg-1" };
    expect(sent[1]).toEqual(whole);
  });

  test("a run's end closes messages it left open, so the next message's updates get the next message's id", () => {
    const { stream, sent } = streamOf();
    stream.forward(start());
    stream.forward(event({ type: "agent_end", messages: [] }));
    stream.forward(start());
    stream.forward(update("x"));
    stream.forward(end());
    expect(idsOf(sent)).toEqual(["msg-1", undefined, "msg-2", "msg-2", "msg-2"]);
  });

  test("what is live: a message being written, with what omp has so far, until it ends", () => {
    const { stream } = streamOf();
    stream.setOptions({ messageUpdates: "delta" });
    stream.forward(start({ role: "assistant", content: [] }));
    const soFar = { role: "assistant", content: [{ type: "text", text: "Hel" }] };
    stream.forward(
      event({
        type: "message_update",
        message: soFar,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "l", partial: soFar },
      }),
    );
    // A new server starts the message with its text so far; the next deltas add to it.
    expect(stream.live()).toEqual([
      { type: "message_start", message: soFar, messageId: "msg-1" } as unknown as ChatEvent,
    ]);
    stream.forward(end(soFar));
    expect(stream.live()).toEqual([]);
  });

  test("what is live: a tool that runs, until it ends or the run does", () => {
    const { stream } = streamOf();
    const running = event({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: {},
    });
    stream.forward(running);
    stream.forward(
      event({ type: "tool_execution_start", toolCallId: "call-2", toolName: "read", args: {} }),
    );
    stream.forward(
      event({ type: "tool_execution_end", toolCallId: "call-2", toolName: "read", result: {} }),
    );
    expect(stream.live()).toEqual([running as ChatEvent]);
    stream.forward(event({ type: "agent_end", messages: [] }));
    expect(stream.live()).toEqual([]);
  });
});
