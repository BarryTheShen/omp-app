import {
  AssistantRuntimeProvider,
  type ThreadMessage,
  type ThreadUserMessagePart,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { AppFailure } from "@omp-app/contracts";
import { useMemo, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import "../../../index.css";
import type { PromptIntent } from "../../R0/runtime/runtime";
import { ComposerSurface } from "../composer/composer";
import {
  type AttachmentBlobStore,
  AttachmentChips,
  AttachmentManager,
  applyLargePaste,
  classifyLargePaste,
  type StoredAttachment,
} from "./index";

function Playground() {
  const [largeText, setLargeText] = useState("");
  const [largeChoice, setLargeChoice] = useState<"attachment" | "inline" | null>(null);
  const blobStore = useMemo<AttachmentBlobStore>(() => {
    const values = new Map<string, StoredAttachment>();
    return {
      async put({ id, file }) {
        const uri = URL.createObjectURL(file);
        const ref = {
          id,
          name: file.name,
          mediaType: file.type || "application/octet-stream",
          sizeBytes: file.size,
          uri,
        };
        const content: ThreadUserMessagePart[] = file.type.startsWith("image/")
          ? [{ type: "image", image: uri }]
          : [{ type: "file", data: uri, mimeType: file.type }];
        const stored = { ref, content };
        values.set(id, stored);
        return stored;
      },
      async get(ref) {
        const stored = values.get(ref.id);
        if (!stored)
          throw new AppFailure({
            code: "not_found",
            message: "Attachment is unavailable",
            retryable: false,
          });
        return stored;
      },
      async delete(ref) {
        values.delete(ref.id);
      },
    };
  }, []);
  const manager = useMemo(() => new AttachmentManager({ blobStore, maxBytes: 1024 }), [blobStore]);
  const subscribe = useMemo(() => manager.subscribe.bind(manager), [manager]);
  const getState = useMemo(() => manager.getState.bind(manager), [manager]);
  const attachmentState = useSyncExternalStore(subscribe, getState, getState);
  const messages = useMemo<readonly ThreadMessage[]>(() => [], []);
  const runtime = useExternalStoreRuntime({
    messages,
    adapters: { attachments: manager },
    onNew: async () => undefined,
    onCancel: async () => undefined,
  });
  const submitPrompt = async (_intent: PromptIntent): Promise<void> => undefined;
  const largeDecision = classifyLargePaste(largeText);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main
        className="min-h-screen bg-background text-foreground"
        data-testid="u2-attachments-playground"
      >
        <header className="border-border bg-card flex items-center justify-between border-b px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight">U2.3 Attachments</h1>
            <p className="text-muted-foreground text-sm">
              Drop, paste, chip, preview and large-paste choices
            </p>
          </div>
          <span data-testid="attachment-count" className="text-muted-foreground text-xs">
            {attachmentState.complete.length} attached
          </span>
        </header>
        <section className="mx-auto flex min-h-[70vh] w-full max-w-3xl flex-col justify-center gap-6 px-6 py-12">
          <div className="border-border bg-card rounded-xl border p-4 shadow-xs">
            <p className="font-medium">Large paste choice</p>
            <textarea
              data-testid="large-paste-input"
              value={largeText}
              onChange={(event) => {
                setLargeText(event.target.value);
                setLargeChoice(null);
              }}
              className="border-border bg-background mt-3 min-h-24 w-full rounded-(--radius) border p-(--space-sm) text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
              placeholder="Paste a long text block"
            />
            {largeDecision.kind === "choose" && (
              <div
                className="mt-3 flex items-center gap-(--space-xs)"
                data-testid="large-paste-choice"
              >
                <span className="text-muted-foreground text-xs">
                  {largeDecision.lineCount} lines
                </span>
                <button
                  type="button"
                  data-testid="large-paste-attach"
                  className="border-border rounded-md border px-3 py-2 text-sm"
                  onClick={async () => {
                    await applyLargePaste(manager, largeText, "attachment");
                    setLargeChoice("attachment");
                  }}
                >
                  Attach as file
                </button>
                <button
                  type="button"
                  data-testid="large-paste-inline"
                  className="border-border rounded-md border px-3 py-2 text-sm"
                  onClick={async () => {
                    await applyLargePaste(manager, largeText, "inline");
                    setLargeChoice("inline");
                  }}
                >
                  Paste inline
                </button>
              </div>
            )}
            {largeChoice && <p data-testid="large-paste-result">{largeChoice}</p>}
          </div>
          <ComposerSurface submitPrompt={submitPrompt} cancel={async () => undefined}>
            <AttachmentChips manager={manager} />
            <input
              data-testid="attachment-file-input"
              type="file"
              accept={manager.accept}
              className="sr-only"
              onChange={async (event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                try {
                  await manager.add({ file });
                } catch {
                  // AttachmentManager exposes the typed validation failure in its state.
                }
                event.target.value = "";
              }}
            />
          </ComposerSurface>
          {attachmentState.error && <p role="alert">{attachmentState.error.message}</p>}
          <p className="text-muted-foreground text-xs">
            Attachment chips retain refs across a manager reload.
          </p>
        </section>
      </main>
    </AssistantRuntimeProvider>
  );
}

const root = document.getElementById("u2-attachments-playground-root");
if (!root) throw new Error("U2.3 attachment playground root is missing.");
createRoot(root).render(<Playground />);
