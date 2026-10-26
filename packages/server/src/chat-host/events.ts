/**
 * The chat's event stream: omp's session events as omp's SDK emits them, with a `messageId` on each message's start,
 * updates and end, so the server can tell messages apart while they stream. The same ids omp's own protocol hosts give
 * (omp 18.12.6 `modes/rpc/rpc-session-events.ts`): `msg-1`, `msg-2`, …, and a record that starts inside a streaming reply
 * (an advisor card, an IRC message) gets its own id while the reply keeps its.
 *
 * In the `delta` form a `message_update` carries only the increment: the message so far (`message`, beyond its role)
 * and the event's accumulated `partial` are dropped, which keeps a long reply from resending itself on every token.
 */
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { EventOptions, PromptResultEvent } from "@omp-app/contracts/chat-host";

type MessageEventType = "message_start" | "message_update" | "message_end";
type MessageEvent = Extract<AgentSessionEvent, { readonly type: MessageEventType }>;
type MessageUpdate = Extract<AgentSessionEvent, { readonly type: "message_update" }>;

/** An event without the field `K`, member by member. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A message's start, update or end with its id. */
export type StampedMessageEvent = MessageEvent & { readonly messageId: string };

/** A `message_update` in the delta form. */
export interface DeltaMessageUpdate {
  readonly type: "message_update";
  readonly messageId: string;
  readonly message: { readonly role: MessageUpdate["message"]["role"] };
  readonly assistantMessageEvent: OmitEach<AssistantMessageEvent, "partial">;
}

/** Every event the chat host writes. */
export type ChatEvent =
  | Exclude<AgentSessionEvent, { readonly type: MessageEventType }>
  | StampedMessageEvent
  | DeltaMessageUpdate
  | PromptResultEvent;

export class SessionEventStream {
  readonly #emit: (event: ChatEvent) => void;
  #messageUpdates: EventOptions["messageUpdates"] = "full";
  #messageCount = 0;
  /** Ids of started, unfinished messages; the last one is the message an update belongs to. */
  #open: string[] = [];

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
        this.#emit({ ...event, messageId });
        return;
      }
      case "message_update": {
        let messageId = this.#open.at(-1);
        if (messageId === undefined) {
          messageId = this.#mintId();
          this.#open.push(messageId);
        }
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
      case "message_end":
        this.#emit({ ...event, messageId: this.#open.pop() ?? this.#mintId() });
        return;
      case "agent_end":
        // A run leaves no message open; an end the stream never saw must not shift later ids.
        this.#open.length = 0;
        this.#emit(event);
        return;
      default:
        this.#emit(event);
    }
  }

  #mintId(): string {
    this.#messageCount++;
    return `msg-${this.#messageCount}`;
  }
}

function withoutPartial(event: AssistantMessageEvent): OmitEach<AssistantMessageEvent, "partial"> {
  if (!("partial" in event)) return event;
  const { partial: _partial, ...increment } = event;
  return increment;
}
