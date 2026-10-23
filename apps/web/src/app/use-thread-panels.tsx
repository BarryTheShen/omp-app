import { type FolderPath, ToolCallId } from "@omp-app/contracts";
import type { ReactNode } from "react";
import { useMemo, useSyncExternalStore } from "react";
import { createRuleStoreAdapter } from "@/modules/I3/ports";
import { useRulesController } from "@/modules/I3/rules";
import { BranchSummaryRow, branchSummaryOfRow } from "@/modules/P3/summary";
import {
  CacheMissRow,
  CompactionSummaryRow,
  compactionSummaryOfRow,
} from "@/modules/P7/compaction";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { LateDiagnosticsCard } from "@/modules/T2/late-diagnostics";
import { MessageParts } from "@/modules/U1/parts";
import type { ThreadRowSlots } from "@/modules/U1/thread";
import { NestedTranscript } from "@/modules/U3/tool-card/nested";
import { projectTodoSnapshot } from "@/modules/U5/todo/model";
import { TOOL_RENDERERS } from "@/registry";
import { useChatTodoStore } from "./owned-stores";
import type { ActiveThreadProps } from "./thread-props";
import { toolRegistry } from "./tool-renderers";

interface ThreadPanelsInput {
  readonly store: OmpRuntimeStore;
  readonly client: ActiveThreadProps["client"];
  readonly folder: ActiveThreadProps["folder"];
  readonly rowActions: (row: { readonly id: string; readonly role: string }) => ReactNode;
}

export function useThreadPanels({ store, client, folder, rowActions }: ThreadPanelsInput) {
  const todoStore = useChatTodoStore(store);
  const rulesAdapter = useMemo(() => createRuleStoreAdapter(client), [client]);
  const rulesController = useRulesController({
    adapter: rulesAdapter,
    folder: folder ?? ("" as FolderPath),
    open: true,
  });
  const todoSnapshot = useSyncExternalStore(
    (listener) => todoStore.subscribe(listener),
    () => todoStore.getSnapshot(),
    () => todoStore.getSnapshot(),
  );
  const todoModel = useMemo(() => projectTodoSnapshot(todoSnapshot), [todoSnapshot]);
  const toolRenderers = useMemo(
    () =>
      Object.fromEntries(
        TOOL_RENDERERS.flatMap((descriptor) =>
          descriptor.match.by === "name"
            ? [[descriptor.match.name, toolRegistry.resolve(descriptor.match.name).renderer]]
            : [],
        ),
      ),
    [],
  );
  // The chat's row slots. Stable while nothing they read changes (rowActions, toolRenderers), so a row whose message did
  // not change is not drawn again when the chat renders for another reason (thread.tsx, MemoMessageRow).
  const slots = useMemo<ThreadRowSlots>(
    () => ({
      renderMessage: (message, renderNested) => {
        const branchSummary = branchSummaryOfRow(message);
        if (branchSummary !== undefined)
          return <BranchSummaryRow message={message} summary={branchSummary} />;
        const compactionSummary = compactionSummaryOfRow(message);
        if (compactionSummary !== undefined)
          return <CompactionSummaryRow message={message} summary={compactionSummary} />;
        const { ompCustomType, ompCustomDetails } = message.metadata.custom;
        if (ompCustomType === "lsp-late-diagnostic")
          return (
            <div data-message-id={message.id}>
              <LateDiagnosticsCard
                identity={message.id}
                snapshot={{ customType: ompCustomType, details: ompCustomDetails }}
              />
            </div>
          );
        return (
          <>
            <CacheMissRow message={message} />
            <MessageParts
              message={message}
              actions={rowActions(message)}
              renderNested={(part) =>
                part.messages === undefined
                  ? undefined
                  : renderNested?.(part.messages, part.toolCallId, part.toolName)
              }
              toolRenderers={toolRenderers}
            />
          </>
        );
      },
      renderNested: (messages, taskId, toolName) => {
        const parsedTaskId = ToolCallId.safeParse(taskId);
        return (
          <NestedTranscript
            depth={0}
            key={taskId}
            messages={messages}
            parentTaskId={parsedTaskId.success ? parsedTaskId.data : undefined}
            taskName={toolName}
            toolRenderers={toolRenderers}
          />
        );
      },
    }),
    [rowActions, toolRenderers],
  );
  return { todoModel, rulesController, slots };
}
