import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  AssistantRuntimeProvider,
  ExportedMessageRepository,
  MessageByIndexProvider,
  MessagePrimitive,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BranchPicker, MessageActionBar } from "./branch-picker";

const user: ThreadMessageLike = {
  role: "user",
  id: "user-1",
  content: [{ type: "text", text: "What changed?" }],
  metadata: { custom: {} },
};
const first: ThreadMessageLike = {
  role: "assistant",
  id: "assistant-1",
  content: [{ type: "text", text: "First answer" }],
  metadata: { custom: {} },
};
const second: ThreadMessageLike = {
  role: "assistant",
  id: "assistant-2",
  content: [{ type: "text", text: "Regenerated answer" }],
  metadata: { custom: {} },
};

function Playground() {
  const repository = useMemo(
    () =>
      ExportedMessageRepository.fromBranchableArray(
        [
          { message: user, parentId: null },
          { message: first, parentId: "user-1" },
          { message: second, parentId: "user-1" },
        ],
        { headId: "assistant-2" },
      ),
    [],
  );
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messageRepository: repository,
    onNew: async () => undefined,
    convertMessage: (message) => message,
    isRunning: false,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="min-h-dvh space-y-(--space-md) bg-background px-(--space-xl) py-(--space-2xl) text-foreground">
        <MessageByIndexProvider index={0}>
          <MessagePrimitive.Root className="mx-auto flex max-w-3xl flex-col gap-(--space-md) rounded-(--radius) border border-border bg-card p-(--space-xl)">
            <p className="text-sm">What changed?</p>
            <div className="flex items-center justify-between">
              <BranchPicker />
              <MessageActionBar />
            </div>
          </MessagePrimitive.Root>
        </MessageByIndexProvider>
        <MessageByIndexProvider index={1}>
          <MessagePrimitive.Root className="mx-auto flex max-w-3xl flex-col gap-(--space-md) rounded-(--radius) border border-border bg-card p-(--space-xl)">
            <p className="text-sm">Regenerated answer</p>
            <div className="flex items-center justify-between">
              <BranchPicker />
              <MessageActionBar />
            </div>
          </MessagePrimitive.Root>
        </MessageByIndexProvider>
      </main>
    </AssistantRuntimeProvider>
  );
}

const root = document.getElementById("p3-branch-picker-playground-root");
if (!root) throw new Error("P3 branch picker playground root is missing.");
createRoot(root).render(
  <StrictMode>
    <Playground />
  </StrictMode>,
);
