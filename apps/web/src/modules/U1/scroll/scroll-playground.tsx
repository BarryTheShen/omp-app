import { AssistantRuntimeProvider, ThreadPrimitive } from "@assistant-ui/react";
import type {
  CapabilityMap,
  ChatSessionEvent,
  ChatSessionRequest,
  EntryId as EntryIdType,
  OmpMessage,
  ThreadId,
} from "@omp-app/contracts";
import { EntryId } from "@omp-app/contracts";
import { useCallback, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Toolbar } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import { ompEvent } from "@/modules/R0/store/session-events";
import { RENDERERS, registry } from "@/registry";
import { RegistryProvider } from "@/registry-core";
import { AppShell } from "@/shell";
import { useOmpRuntime } from "../../R0/runtime";
import { OmpRuntimeStore } from "../../R0/store";
import { MessageParts } from "../parts";
import { ThreadShell } from "../thread";
import { ScrollFollowControls, useThreadScrollController } from "./index";

const THREAD_ID = "u1-8-scroll-playground" as ThreadId;
const CAPABILITIES: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "omp" },
  "omp.cmd.abort": { state: "available", via: "omp" },
};
const USAGE = {
  input: 2,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 6,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface ScrollHistoryEntry {
  readonly id: EntryIdType;
  readonly parentId: EntryIdType | null;
  readonly type: "message";
  readonly timestamp: string;
  readonly message: OmpMessage;
}

interface ScrollFixture {
  readonly store: OmpRuntimeStore;
  readonly entries: readonly ScrollHistoryEntry[];
  readonly nextSequence: number;
}

function assistantMessage(
  text: string,
  timestamp: number,
): Extract<OmpMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-completions",
    provider: "fixture-provider",
    model: "fixture-model",
    usage: USAGE,
    stopReason: "stop",
    timestamp,
  };
}
function userMessage(text: string, timestamp: number): Extract<OmpMessage, { role: "user" }> {
  return {
    role: "user",
    content: [{ type: "text", text }],
    attribution: "user",
    timestamp,
  };
}

function createScrollFixture(): ScrollFixture {
  const store = new OmpRuntimeStore({ threadId: THREAD_ID });
  const ready: ChatSessionEvent = { kind: "process", status: "ready" };
  store.ingest(ready, 1);
  const entries: ScrollHistoryEntry[] = [];
  let parentId: EntryIdType | null = null;
  for (let index = 0; index < 60; index += 1) {
    const userId = EntryId.parse(`scroll-user-${index}`);
    const userTimestamp = 1_759_600_000_000 + index * 2_000;
    const user = userMessage(
      `Question ${index + 1}: summarize this part of the conversation.`,
      userTimestamp,
    );
    entries.push({
      id: userId,
      parentId,
      type: "message",
      timestamp: new Date(userTimestamp).toISOString(),
      message: user,
    });
    parentId = userId;

    const assistantId = EntryId.parse(`scroll-assistant-${index}`);
    const assistantTimestamp = userTimestamp + 1_000;
    const assistant = assistantMessage(
      `Conversation entry ${index + 1}. This long transcript fixture provides stable content for scroll anchoring and content-visibility.`,
      assistantTimestamp,
    );
    entries.push({
      id: assistantId,
      parentId,
      type: "message",
      timestamp: new Date(assistantTimestamp).toISOString(),
      message: assistant,
    });
    parentId = assistantId;
  }
  store.pairEndedMessages(entries, parentId);
  return { store, entries, nextSequence: 2 };
}

const noRequest: ChatSessionRequest = async () => undefined as never;

function ScrollPlayground() {
  const [fixture] = useState(createScrollFixture);
  const [entries, setEntries] = useState(fixture.entries);
  const [streamCount, setStreamCount] = useState(0);
  const sequence = useRef(fixture.nextSequence);
  /** The reply that is streaming: it stays open until "Finish stream", so nothing here races a timer. */
  const openStream = useRef<{
    readonly id: string;
    readonly timestamp: number;
    text: string;
  } | null>(null);
  const transcriptRootRef = useRef<HTMLDivElement | null>(null);
  const scrollController = useThreadScrollController(transcriptRootRef);
  const { runtime } = useOmpRuntime({
    store: fixture.store,
    send: noRequest,
    capabilities: CAPABILITIES,
  });

  const startStream = useCallback(() => {
    const index = streamCount + 1;
    const id = `scroll-stream-${index}`;
    const timestamp = 1_759_700_000_000 + index * 1_000;
    const text = `Streaming response ${index} is starting.`;
    openStream.current = { id, timestamp, text };
    fixture.store.ingest(
      ompEvent({
        type: "message_start",
        messageId: id,
        message: assistantMessage(text, timestamp),
      }),
      sequence.current++,
    );
    setStreamCount(index);
  }, [fixture.store, streamCount]);

  /** Adds a section to the open reply: it grows at the bottom while the reader may be elsewhere. */
  const addToStream = useCallback(() => {
    const open = openStream.current;
    if (open === null) return;
    const delta = " The assistant is adding another section of the reply.";
    open.text += delta;
    const partial = assistantMessage(open.text, open.timestamp);
    fixture.store.ingest(
      ompEvent({
        type: "message_update",
        messageId: open.id,
        message: partial,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
      }),
      sequence.current++,
    );
  }, [fixture.store]);

  const finishStream = useCallback(() => {
    const open = openStream.current;
    if (open === null) return;
    openStream.current = null;
    fixture.store.ingest(
      ompEvent({
        type: "message_end",
        messageId: open.id,
        message: assistantMessage(open.text, open.timestamp),
      }),
      sequence.current++,
    );
    fixture.store.ingest(ompEvent({ type: "agent_end", messages: [] }), sequence.current++);
  }, [fixture.store]);

  const prependOlder = useCallback(() => {
    const first = entries[0];
    const last = entries.at(-1);
    if (first === undefined || last === undefined) return;
    const id = EntryId.parse(`scroll-older-${entries.length}`);
    const timestamp = 1_759_500_000_000 - entries.length * 1_000;
    const older: ScrollHistoryEntry = {
      id,
      parentId: null,
      type: "message",
      timestamp: new Date(timestamp).toISOString(),
      message: userMessage("Earlier conversation entry loaded from the history page.", timestamp),
    };
    const updatedFirst = { ...first, parentId: id };
    const updated = [older, updatedFirst, ...entries.slice(1)];
    setEntries(updated);
    fixture.store.pairEndedMessages(updated, last.id);
  }, [entries, fixture.store]);
  const reconnect = useCallback(() => {
    fixture.store.pairEndedMessages(entries, entries.at(-1)?.id ?? null);
    fixture.store.ingest({ kind: "process", status: "ready" }, sequence.current++);
  }, [entries, fixture.store]);
  return (
    <RegistryProvider capabilities={CAPABILITIES} registry={registry} renderers={RENDERERS}>
      <AssistantRuntimeProvider runtime={runtime}>
        <ThreadPrimitive.ViewportProvider>
          <AppShell
            leftSidebar={<p className="text-muted-foreground p-(--space-sm) text-sm">Sessions</p>}
            rightSidebar={
              <p className="text-muted-foreground p-(--space-sm) text-sm">No side panel</p>
            }
            threadHeader={
              <div className="flex flex-wrap items-center justify-between gap-(--space-sm)">
                <div>
                  <h1 className="text-base font-semibold">Long conversation</h1>
                  <p className="text-muted-foreground text-xs">Streaming and history navigation</p>
                </div>
                <span
                  aria-hidden="true"
                  className="bg-background sr-only"
                  data-testid="u1-8-background-token"
                >
                  Transcript background token
                </span>
                <Toolbar ariaLabel="Conversation actions">
                  <Button type="button" size="sm" variant="outline" onClick={startStream}>
                    Start stream
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={addToStream}>
                    Add to stream
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={finishStream}>
                    Finish stream
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={prependOlder}>
                    Load older messages
                  </Button>
                  <Button type="button" size="sm" variant="outline" onClick={reconnect}>
                    Reconnect
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={scrollController.followLatest}
                  >
                    Reset display
                  </Button>
                </Toolbar>
              </div>
            }
            transcript={
              <div
                ref={transcriptRootRef}
                data-testid="u1-8-scroll-playground"
                data-is-at-bottom={scrollController.isAtBottom ? "true" : "false"}
                className="bg-background h-full min-h-0"
              >
                <ThreadShell
                  slots={{ renderMessage: (message) => <MessageParts message={message} /> }}
                  store={fixture.store}
                  autoScroll={!scrollController.followPaused}
                  footer={
                    <ScrollFollowControls
                      onFollowLatest={scrollController.followLatest}
                      isAtBottom={scrollController.isAtBottom}
                    />
                  }
                />
              </div>
            }
          />
        </ThreadPrimitive.ViewportProvider>
      </AssistantRuntimeProvider>
    </RegistryProvider>
  );
}

const root = document.getElementById("u1-8-scroll-root");
if (root === null) throw new Error("The U1 scroll playground root is missing.");
createRoot(root).render(<ScrollPlayground />);
