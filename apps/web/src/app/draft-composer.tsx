import { useAui, useAuiState } from "@assistant-ui/react";
import type { CapabilityMap } from "@omp-app/contracts";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
import {
  type P3PreviousMessageSelectorControllerModel,
  PreviousMessageSelectorView,
} from "@/modules/P3/selector";
import { type AttachmentManager, attachmentHoldReason } from "@/modules/U2/attachments";
import { ComposerSurface } from "@/modules/U2/composer";
import type { PromptIntent, SubmitPolicy } from "@/modules/U2/contract";
import {
  composerDraftForLifecycle,
  type DraftController,
  DraftNotice,
  useComposerDraft,
} from "@/modules/U2/drafts";
import { useIsRecalledPrompt } from "@/modules/U2/history";
import { useComposerDraftOwner } from "./draft-owner";

export function DraftComposer({
  chat,
  hold,
  controller,
  capabilities,
  submit,
  cancel,
  policy,
  toolbar,
  voice,
  footer,
  footerOpen,
  editing,
  manager,
  onRetry,
  onResolve,
  switching,
  onDoubleLeftArrow,
  sendBlockedReason,
  savePasteFile,
  saveTextAttachment,
  placeholder,
}: {
  readonly controller: DraftController;
  /** The chat the draft belongs to (see `useChatDraft`): a different one once the person switches chats. */
  readonly chat: object;
  /** Holds the chat's draft while a send settles (see `useChatDraft`'s `hold`). */
  readonly hold: () => () => void;
  readonly capabilities: CapabilityMap;
  readonly submit: (intent: PromptIntent) => Promise<void>;
  readonly cancel: () => Promise<void>;
  readonly policy: SubmitPolicy;
  readonly toolbar: ReactNode;
  readonly voice: ReactNode;
  readonly footer: ReactNode;
  readonly footerOpen: boolean;
  readonly editing: boolean;
  readonly manager: AttachmentManager;
  /** Runs the step that failed again: the composer's Retry. */
  readonly onRetry: () => void;
  /** Keeps this tab's text, or takes the other tab's, for a draft conflict. */
  readonly onResolve: (choice: "local" | "remote") => Promise<void>;
  readonly switching: boolean;
  /** Why the composer cannot send right now; the text stays in the composer while it is set. */
  readonly sendBlockedReason?: string;
  /** Saves a large paste's full text as a file the chat's agent reads; the composer puts the reference in the box. */
  readonly savePasteFile?: (text: string) => Promise<string>;
  /** Saves a text file attached in the composer as a file the chat's agent reads; the send cites its reference (issue 2658). */
  readonly saveTextAttachment?: (name: string, text: string) => Promise<string>;
  readonly placeholder: string | undefined;
  readonly onDoubleLeftArrow: () => void;
}) {
  const aui = useAui();
  const snapshot = useSyncExternalStore(
    (listener) => controller.subscribe(listener),
    () => controller.getSnapshot(),
    () => controller.getSnapshot(),
  );
  const attachmentState = useSyncExternalStore(
    (listener) => manager.subscribe(listener),
    () => manager.getState(),
    () => manager.getState(),
  );

  const text = useAuiState((state) => state.composer.text);
  const lifecycleText = useRef(text);
  lifecycleText.current = text;
  const inputElement = useRef<HTMLTextAreaElement | null>(null);
  const setInputElement = useCallback((element: HTMLTextAreaElement | null) => {
    inputElement.current = element;
  }, []);
  const isRecalledPrompt = useIsRecalledPrompt();
  const lifecycleReader = useMemo(
    () => ({
      read: () =>
        composerDraftForLifecycle(
          controller,
          inputElement.current?.value ?? lifecycleText.current,
          manager.toDraftRefs(),
          isRecalledPrompt,
        ),
    }),
    [controller, isRecalledPrompt, manager],
  );
  useLayoutEffect(() => {
    controller.setLifecycleReader(lifecycleReader);
    return () => controller.setLifecycleReader(undefined);
  }, [controller, lifecycleReader]);
  useComposerDraftOwner(controller);
  const { beginSend, endSend, citeTextFiles } = useComposerDraft({
    chat,
    controller,
    switching,
    text,
    composer: aui.composer,
    attachments: manager,
    isRecalledPrompt,
    hold,
  });
  const holdDraft = useMemo(
    () => ({ begin: beginSend, end: endSend, cite: citeTextFiles }),
    [beginSend, endSend, citeTextFiles],
  );
  // assistant-ui keeps its own composer attachment list in the runtime. Clear that list when the draft owner changes,
  // before a New chat can submit it; U2's attachment manager is restored separately by useComposerDraft.
  const previousChat = useRef(chat);
  useEffect(() => {
    if (previousChat.current === chat) return;
    previousChat.current = chat;
    void aui.composer.reset();
  }, [aui.composer, chat]);
  return (
    <ComposerSurface
      capabilities={capabilities}
      onInputRef={setInputElement}
      cancel={cancel}
      disabled={snapshot.status === "error"}
      replaced={editing}
      attachmentManager={manager}
      policy={policy}
      attachmentHoldReason={attachmentHoldReason(attachmentState)}
      sendBlockedReason={sendBlockedReason}
      submitPrompt={submit}
      holdDraft={holdDraft}
      savePasteFile={savePasteFile}
      saveTextAttachment={saveTextAttachment}
      toolbar={toolbar}
      voice={voice}
      onDoubleLeftArrow={onDoubleLeftArrow}
      placeholder={placeholder}
    >
      <DraftNotice
        onResolve={onResolve}
        onResolveReplaced={(choice) => controller.resolveReplaced(choice)}
        onRetry={onRetry}
        snapshot={snapshot}
      />
      {footerOpen ? footer : null}
    </ComposerSurface>
  );
}

export function RuntimeAwarePreviousMessageSelector({
  controller,
}: {
  readonly controller: P3PreviousMessageSelectorControllerModel;
}) {
  const running = useAuiState((state) => state.thread.isRunning);
  const onRunningChange = controller.onRunningChange;
  useLayoutEffect(() => {
    onRunningChange(running);
  }, [onRunningChange, running]);
  return (
    <PreviousMessageSelectorView
      actions={controller.actions}
      running={running}
      viewModel={controller.viewModel}
    />
  );
}

/** Keeps the composer's running flag, thread.isRunning (the flag that picks steer or follow-up), for the busy test. */
export function ThreadRunningFlag({ flag }: { readonly flag: { current: boolean } }) {
  const running = useAuiState((state) => state.thread.isRunning);
  useLayoutEffect(() => {
    flag.current = running;
  }, [flag, running]);
  return null;
}
