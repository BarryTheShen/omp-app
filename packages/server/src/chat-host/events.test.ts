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
});
