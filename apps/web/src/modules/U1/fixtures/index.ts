import type {
  CapabilityMap,
  ChatSessionEvent,
  ChatSessionRequest,
  OmpMessage,
  ThreadId,
} from "@omp-app/contracts";
import { INVENTORY } from "@omp-app/contracts";
import { ompEvent } from "@/modules/R0/store/session-events";
import { OmpRuntimeStore } from "../../R0/store";

/**
 * The inventory's F6 group: transcript message rows and the transcript shortcuts, all of which U1
 * covers. Read from the inventory, so a row added there without a U1 descriptor fails the
 * acceptance test instead of passing against a stale copy.
 */
export const U1_ACCEPTANCE_F6_IDS: readonly string[] = INVENTORY.filter(
  (item) => item.group === "F6",
).map((item) => item.id);

export const U1_ACCEPTANCE_CAPABILITIES: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
  "omp.cmd.abort": { state: "available", via: "rpc" },
};

const THREAD_ID = "u1-acceptance" as ThreadId;
const ASSISTANT_MESSAGE_ID = "u1-acceptance-assistant";
const TIMESTAMP = 1_759_700_000_000;
const USAGE = {
  input: 2,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function userMessage(text: string): Extract<OmpMessage, { role: "user" }> {
  return {
    role: "user",
    content: [{ type: "text", text }],
    attribution: "user",
    timestamp: TIMESTAMP,
  };
}

function assistantMessage(text: string): Extract<OmpMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture-provider",
    model: "fixture-model",
    usage: USAGE,
    stopReason: "stop",
    timestamp: TIMESTAMP + 1_000,
  };
}

const NO_REQUEST: ChatSessionRequest = async () => undefined as never;

export interface U1AcceptanceFixture {
  readonly store: OmpRuntimeStore;
  readonly send: ChatSessionRequest;
  readonly updateAssistant: () => void;
  readonly finishAssistant: () => void;
  readonly failRuntime: () => void;
}

/** A typed in-memory R0 snapshot fixture; no A0 manifest or omp JSONL is read by U1. */
export function createU1AcceptanceFixture(): U1AcceptanceFixture {
  const store = new OmpRuntimeStore({ threadId: THREAD_ID });
  let sequence = 0;
  const ingest = (event: ChatSessionEvent): void => {
    sequence += 1;
    store.ingest(event, sequence);
  };
  const user = userMessage("Summarize this fixture conversation.");
  ingest({ kind: "process", status: "ready" });
  ingest(ompEvent({ type: "message_start", messageId: "u1-acceptance-user", message: user }));
  ingest(ompEvent({ type: "message_end", messageId: "u1-acceptance-user", message: user }));
  ingest(
    ompEvent({
      type: "message_start",
      messageId: ASSISTANT_MESSAGE_ID,
      message: assistantMessage("The fixture response"),
    }),
  );

  const updateAssistant = (): void => {
    const partial = assistantMessage("The fixture response is **stable** across deltas.");
    ingest(
      ompEvent({
        type: "message_update",
        messageId: ASSISTANT_MESSAGE_ID,
        message: partial,
        assistantMessageEvent: {
          type: "text_delta",
          contentIndex: 0,
          delta: " is **stable** across deltas.",
          partial,
        },
      }),
    );
  };
  const finishAssistant = (): void => {
    ingest(
      ompEvent({
        type: "message_end",
        messageId: ASSISTANT_MESSAGE_ID,
        message: assistantMessage("The fixture response is **stable** across deltas."),
      }),
    );
    ingest(ompEvent({ type: "agent_end", messages: [] }));
  };
  const failRuntime = (): void => {
    ingest({
      kind: "process",
      status: "error",
      error: { code: "permission", message: "The runtime was blocked", retryable: true },
    });
  };

  return { store, send: NO_REQUEST, updateAssistant, finishAssistant, failRuntime };
}
