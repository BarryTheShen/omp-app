import {
  type CapabilityMap,
  type ChatSessionClient,
  ChatSessionPort,
  PasteFileStore,
  ProviderErrorPort,
  RpcSessionPort,
  SessionFileStore,
  type ThreadId,
} from "@omp-app/contracts";
import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useThreadAgents } from "@/app/agents/thread-agents-scope";
import { useAppConnection } from "@/launch";
import { useSlashTip } from "@/modules/D2/slash/tip";
import { createDiagnosticCommandPort } from "@/modules/D6/reports";
import type { OtherVersion } from "@/modules/P3/runs";
import {
  endNoticeOnPrompt,
  lastSavedUserEntryId,
  type P3EditTarget,
  type P3Runs,
} from "@/modules/P3/runs";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import type { PanelFocusToken } from "@/modules/U5/panel/contract";
import { useShortcutPreferenceError } from "@/shortcuts";
import { composerInput } from "./composer-input";
import { RowActions } from "./row-actions";
import { guardOmpSend } from "./slash-commands";
import type { ActiveThreadProps } from "./thread-props";
import {
  createLastUserVersions,
  type LastUserVersions,
  useOtherVersions,
} from "./use-other-versions";

interface ThreadServicesInput {
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly catalog: ActiveThreadProps["catalog"];
  readonly client: ActiveThreadProps["client"];
  readonly capabilities: CapabilityMap;
  readonly p3Runs: P3Runs;
}

export function useThreadServices({
  store,
  threadId,
  catalog,
  client,
  capabilities,
  p3Runs,
}: ThreadServicesInput) {
  const slashTip = useSlashTip();
  const otherVersions = useOtherVersions(catalog, threadId);
  const [lastUserVersions] = useState(createLastUserVersions);
  const connection = useAppConnection();
  const providerErrors = useMemo(() => client.port(ProviderErrorPort), [client]);
  const resolveProviderError = useCallback(
    (text: string) => providerErrors.parse({ text }),
    [providerErrors],
  );
  const rpc = useMemo(() => client.port(RpcSessionPort), [client]);
  const chat = useMemo(() => client.port(ChatSessionPort) as ChatSessionClient, [client]);
  const guardedSend = useMemo(() => guardOmpSend(rpc.send), [rpc.send]);
  // A prompt the person sends ends a finished run's notice (endNoticeOnPrompt); other sends are unchanged.
  const messageSend = useMemo(
    () => endNoticeOnPrompt(guardedSend, p3Runs.status),
    [guardedSend, p3Runs.status],
  );
  const sessionFiles = useMemo(() => client.port(SessionFileStore), [client]);
  const pasteFiles = useMemo(() => client.port(PasteFileStore), [client]);
  const savePasteFile = useCallback(
    async (text: string) => (await pasteFiles.save({ threadId, text })).reference,
    [pasteFiles, threadId],
  );
  // A text file attached in the composer is saved into the chat's `local` folder at send, and cited by its reference (issue 2658).
  const saveTextAttachment = useCallback(
    async (name: string, text: string) =>
      (await pasteFiles.saveFile({ threadId, name, text })).reference,
    [pasteFiles, threadId],
  );
  const agents = useThreadAgents({
    threadId,
    store,
    session: chat,
    files: sessionFiles,
    capabilities,
  });
  return {
    slashTip,
    otherVersions,
    lastUserVersions,
    connection,
    resolveProviderError,
    rpc,
    guardedSend,
    messageSend,
    savePasteFile,
    saveTextAttachment,
    agents,
  };
}

interface ThreadCommandStatusInput {
  readonly threadId: ThreadId;
  readonly client: ActiveThreadProps["client"];
}

export function useThreadCommandStatus({ threadId, client }: ThreadCommandStatusInput) {
  const [commandError, setCommandError] = useState<string | null>(null);
  const [commandStatus, setCommandStatus] = useState<string | null>(null);
  useEffect(() => {
    if (threadId === undefined) return;
    setCommandStatus(null);
    setCommandError(null);
  }, [threadId]);
  const [diagnosticPanel, setDiagnosticPanel] = useState<"reports" | "security" | null>(null);
  const [diagnosticPanelOpen, setDiagnosticPanelOpen] = useState(false);
  const [diagnosticPanelReveal, setDiagnosticPanelReveal] = useState(0);
  const diagnosticPort = useMemo(() => createDiagnosticCommandPort(client), [client]);
  const diagnosticFocusToken: PanelFocusToken = `d6-panel-${diagnosticPanelReveal}`;
  const restoreDiagnosticPanelFocus = useCallback(
    (token: PanelFocusToken) => {
      if (token === diagnosticFocusToken) composerInput()?.focus({ preventScroll: true });
    },
    [diagnosticFocusToken],
  );
  const closeDiagnosticPanel = useCallback(() => {
    restoreDiagnosticPanelFocus(diagnosticFocusToken);
    setDiagnosticPanelOpen(false);
    setDiagnosticPanel(null);
  }, [diagnosticFocusToken, restoreDiagnosticPanelFocus]);
  useEffect(() => {
    if (diagnosticPanel !== null) setDiagnosticPanelOpen(true);
  }, [diagnosticPanel]);
  const shortcutPreferenceError = useShortcutPreferenceError();
  return {
    commandError,
    setCommandError,
    commandStatus,
    setCommandStatus,
    diagnosticPanel,
    setDiagnosticPanel,
    diagnosticPanelOpen,
    setDiagnosticPanelOpen,
    diagnosticPanelReveal,
    setDiagnosticPanelReveal,
    diagnosticPort,
    diagnosticFocusToken,
    restoreDiagnosticPanelFocus,
    closeDiagnosticPanel,
    shortcutPreferenceError,
  };
}

interface ThreadMessageActionsInput {
  readonly store: OmpRuntimeStore;
  readonly capabilities: CapabilityMap;
  readonly lastUserVersions: LastUserVersions;
  readonly otherVersions: readonly OtherVersion[];
  readonly openThread: ActiveThreadProps["openThread"];
}

export function useThreadMessageActions({
  store,
  capabilities,
  lastUserVersions,
  otherVersions,
  openThread,
}: ThreadMessageActionsInput) {
  // The message being edited, and the row button that opened the editor (focus returns to it on cancel).
  const [editing, setEditing] = useState<P3EditTarget | null>(null);
  // Edit and Regenerate need omp's branch command, and a row omp has saved: a streaming row has no entry yet.
  const branchAvailable = capabilities["omp.cmd.branch"]?.state === "available";
  const currentSnapshot = store.getSnapshot();
  const lastUserEntryId = lastSavedUserEntryId(
    currentSnapshot.messageOrder.map((key) => {
      const row = currentSnapshot.messages[key];
      return {
        role: row?.message.role ?? "",
        entryId:
          row?.entryId !== undefined &&
          currentSnapshot.transcript.entries[row.entryId] !== undefined
            ? row.entryId
            : null,
      };
    }),
  );
  // The last user message and its other versions, published after the chat draws: a layout effect, so no row shows them
  // late. Each row reads its own answer from the store (RowActions), so a change draws two rows, not the transcript.
  useLayoutEffect(() => {
    lastUserVersions.publish(lastUserEntryId, otherVersions);
  }, [lastUserEntryId, lastUserVersions, otherVersions]);
  const rowActions = useCallback(
    (row: { readonly id: string; readonly role: string }): ReactNode => {
      if (!branchAvailable) return undefined;
      return (
        <RowActions
          onEdit={(entryId, trigger) => setEditing({ entryId, trigger })}
          onOpenOtherVersion={(otherThreadId) => void openThread(otherThreadId)}
          role={row.role}
          rowId={row.id}
          store={store}
          versions={lastUserVersions}
        />
      );
    },
    [branchAvailable, lastUserVersions, openThread, store],
  );
  return { editing, setEditing, branchAvailable, rowActions };
}
