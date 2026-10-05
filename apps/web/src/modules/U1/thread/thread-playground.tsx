import type {
  CapabilityMap,
  Fixture,
  OmpMessage,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/shell";
import { FixtureSession } from "../../../../../../packages/omp-rpc/src/fixtures/fixture-session";
import { RpcSession } from "../../../../../../packages/omp-rpc/src/session";
import { OmpRuntimeStore } from "../../R0/store";
import { MarkdownShowcase } from "../markdown";
import { MessageParts } from "../parts";
import { ThreadShell } from "./thread";

const THREAD_ID = "u1-playground" as ThreadId;
const CAPABILITIES: CapabilityMap = {
  "omp.cmd.prompt": { state: "available", via: "rpc" },
  "omp.cmd.abort": { state: "available", via: "rpc" },
  "omp.cmd.abort_bash": { state: "available", via: "rpc" },
  "omp.cmd.bash": { state: "available", via: "rpc" },
};

const IMAGE_DATA =
  typeof btoa === "function"
    ? btoa(
        '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120"><rect width="320" height="120" fill="lightblue"/><text x="16" y="68" font-size="28" fill="darkslategray">U1 image part</text></svg>',
      )
    : "";
const IMAGE_USER_MESSAGE: OmpMessage = {
  role: "user",
  content: [
    { type: "text", text: "what is in this picture?" },
    { type: "image", data: IMAGE_DATA, mimeType: "image/svg+xml" },
  ],
  attribution: "user",
  timestamp: 1_759_600_000_500,
} as OmpMessage;
type PlaygroundMode = "empty" | "streaming" | "settled" | "error";

function Controls({
  mode,
  onPlay,
  onError,
  onMarkdown,
}: {
  readonly mode: PlaygroundMode;
  readonly onPlay: () => void;
  readonly onError: () => void;
  readonly onMarkdown: () => void;
}) {
  return (
    <div className="flex items-center gap-1.5" data-testid="thread-fixture-controls">
      <button
        className="border-border bg-background hover:bg-muted rounded-md border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="thread-play-fixture"
        type="button"
        onClick={onPlay}
      >
        {mode === "streaming" ? "Playing…" : "Play fixture"}
      </button>
      <button
        className="border-danger/40 bg-danger-surface hover:bg-danger-surface/80 text-danger-surface-foreground rounded-md border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="thread-show-error"
        type="button"
        onClick={onError}
      >
        Show error
      </button>
      <button
        className="border-border bg-background hover:bg-muted rounded-md border px-2 py-1 text-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        data-testid="thread-show-markdown"
        type="button"
        onClick={onMarkdown}
      >
        Rich Markdown
      </button>
    </div>
  );
}

function ThreadPlayground() {
  const [fixture, setFixture] = useState<Fixture | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | undefined>(undefined);
  const [showMarkdown, setShowMarkdown] = useState(false);
  const [mode, setMode] = useState<PlaygroundMode>("empty");
  const store = useMemo(() => new OmpRuntimeStore({ threadId: THREAD_ID }), []);
  const sequenceRef = useRef(0);
  const sessionRef = useRef<RpcSession | undefined>(undefined);
  useEffect(() => {
    let active = true;
    void fetch("/prompt-stream-fixture.json")
      .then((response) => {
        if (!response.ok) throw new Error(`Fixture request failed (${response.status})`);
        return response.json() as Promise<Fixture>;
      })
      .then((loaded) => {
        if (active) setFixture(loaded);
      })
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "Fixture load failed");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (fixture === undefined) return;
    const duplex = new FixtureSession({ fixture, realtime: true });
    const session = new RpcSession(duplex);
    const unsubscribe = session.onEvent((event) => store.ingest(event, ++sequenceRef.current));
    sessionRef.current = session;
    void session.start().catch((error: unknown) => {
      setLoadError(error instanceof Error ? error.message : "Fixture session failed to start");
    });
    return () => {
      unsubscribe();
      sessionRef.current = undefined;
      void session.close();
    };
  }, [fixture, store]);

  const send: RpcSessionSend = async (args, options) => {
    const session = sessionRef.current;
    if (session === undefined) throw new Error("Fixture session is not ready");
    return (await session.send(args.command, options)) as never;
  };

  const playFixture = useCallback(() => {
    const session = sessionRef.current;
    if (session === undefined || mode === "streaming" || mode === "settled") return;
    store.ingest(
      {
        kind: "omp",
        event: { type: "message_start", messageId: "msg-image", message: IMAGE_USER_MESSAGE },
      },
      ++sequenceRef.current,
    );
    store.ingest(
      {
        kind: "omp",
        event: { type: "message_end", messageId: "msg-image", message: IMAGE_USER_MESSAGE },
      },
      ++sequenceRef.current,
    );
    void session.send({ type: "prompt", message: "run_bash" }).then(
      () => setMode("settled"),
      () => setMode("error"),
    );
  }, [mode, store]);

  const showError = useCallback(() => {
    setMode("error");
    void store.setTodos([]).catch(() => {
      setMode("error");
    });
  }, [store]);
  const showRichMarkdown = useCallback(() => setShowMarkdown(true), []);
  if (loadError !== undefined) {
    return <div role="alert">{loadError}</div>;
  }

  return (
    <AppShell
      leftSidebar={
        <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-sidebar-foreground">
          Fixture-backed transcript
        </div>
      }
      rightSidebar={
        <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-sidebar-foreground">
          Thread row slots
        </div>
      }
      threadHeader={
        <Controls
          mode={mode}
          onError={showError}
          onMarkdown={showRichMarkdown}
          onPlay={playFixture}
        />
      }
      transcript={
        <div className="h-full min-h-0 overflow-hidden">
          <ThreadShell
            capabilities={CAPABILITIES}
            send={send}
            slots={{
              renderMessage: (message) => <MessageParts message={message} />,
            }}
            store={store}
          />
          {showMarkdown && <MarkdownShowcase />}
        </div>
      }
    />
  );
}

const rootElement = document.getElementById("thread-playground-root");
if (!rootElement) throw new Error("Thread playground root is missing.");
createRoot(rootElement).render(<ThreadPlayground />);
