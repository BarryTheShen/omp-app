/**
 * The chat's event stream: omp's session events as omp's SDK emits them, with a `messageId` on each message's start,
 * updates and end, so the server can tell messages apart while they stream. The same ids omp's own protocol hosts give
 * (omp 18.12.6 `modes/rpc/rpc-session-events.ts`): `msg-1`, `msg-2`, …, and a record that starts inside a streaming reply
 * (an advisor card, an IRC message) gets its own id while the reply keeps its.
 *
 * In the `delta` form a `message_update` carries only the increment: the message so far (`message`, beyond its role)
 * and the event's accumulated `partial` are dropped, which keeps a long reply from resending itself on every token.
 *
 * For a server that attaches to a running chat (D2), it keeps what is live: each unfinished message as omp has it so
 * far, and each tool that runs. `live()` gives them as events that bring a new server up to date.
 */
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { ChatEvent, DeltaMessageUpdate, EventOptions } from "@omp-app/contracts/chat-host";

type MessageStart = Extract<AgentSessionEvent, { type: "message_start" }>;
type ToolStart = Extract<AgentSessionEvent, { type: "tool_execution_start" }>;

export class SessionEventStream {
  readonly #emit: (event: ChatEvent) => void;
  #messageUpdates: EventOptions["messageUpdates"] = "full";
  #messageCount = 0;
  /** Ids of started, unfinished messages; the last one is the message an update belongs to. */
  #open: string[] = [];
  /** Each unfinished message as omp has it so far, by its id. */
  readonly #messages = new Map<string, MessageStart["message"]>();
  /** Each tool that runs, by its call's id. */
  readonly #tools = new Map<string, ToolStart>();

  constructor(emit: (event: ChatEvent) => void) {
    this.#emit = emit;
  }

  setOptions(options: EventOptions): EventOptions {
    this.#messageUpdates = options.messageUpdates;
    return { messageUpdates: this.#messageUpdates };
  }

  forward(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start": {
        const messageId = this.#mintId();
        this.#open.push(messageId);
        this.#messages.set(messageId, event.message);
        this.#emit({ ...event, messageId });
        return;
      }
      case "message_update": {
        let messageId = this.#open.at(-1);
        if (messageId === undefined) {
          messageId = this.#mintId();
          this.#open.push(messageId);
        }
        this.#messages.set(messageId, event.message);
        if (this.#messageUpdates === "delta") {
          this.#emit({
            type: "message_update",
            messageId,
            message: { role: event.message.role },
            assistantMessageEvent: withoutPartial(event.assistantMessageEvent),
          });
        } else {
          this.#emit({ ...event, messageId });
        }
        return;
      }
      case "message_end": {
        const messageId = this.#open.pop() ?? this.#mintId();
        this.#messages.delete(messageId);
        this.#emit({ ...event, messageId });
        return;
      }
      case "tool_execution_start":
        this.#tools.set(event.toolCallId, event);
        this.#emit(event);
        return;
      case "tool_execution_end":
        this.#tools.delete(event.toolCallId);
        this.#emit(event);
        return;
      case "agent_end":
        // A run leaves no message open; an end the stream never saw must not shift later ids.
        this.#open.length = 0;
        this.#messages.clear();
        this.#tools.clear();
        this.#emit(event);
        return;
      default:
        this.#emit(event);
    }
  }

  /**
   * What is live, for a server that attaches now: each unfinished message as a start that holds what omp has written so
   * far (later updates add to it), then each tool that runs.
   */
  live(): readonly ChatEvent[] {
    const messages = this.#open.flatMap((messageId): ChatEvent[] => {
      const message = this.#messages.get(messageId);
      return message === undefined ? [] : [{ type: "message_start", message, messageId }];
    });
    return [...messages, ...this.#tools.values()];
  }

  #mintId(): string {
    this.#messageCount++;
    return `msg-${this.#messageCount}`;
  }
}

function withoutPartial(event: AssistantMessageEvent): DeltaMessageUpdate["assistantMessageEvent"] {
  if (!("partial" in event)) return event;
  const { partial: _partial, ...increment } = event;
  return increment;
}
