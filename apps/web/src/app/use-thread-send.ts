import type { CapabilityMap, OmpCommandGateway, PortClient, ThreadId } from "@omp-app/contracts";
import { type Dispatch, type SetStateAction, useCallback, useLayoutEffect, useMemo } from "react";
import { startWorkerStream } from "@/app/agents/thread-agents";
import type { NoSwitchNote } from "@/app/rewind/no-switch-notice";
import { showNoSwitchNote } from "@/app/rewind/no-switch-notice";
import type { AppConnectionSnapshot } from "@/launch";
import { SEND_BLOCKED_TEXT } from "@/launch";
import type { SlashCommandProvider } from "@/modules/D2/slash/provider";
import type { SlashAppCommand } from "@/modules/D2/slash/routing";
import type { CredentialActions } from "@/modules/D3/auth/credential-actions";
import { readProviderSignIns } from "@/modules/D3/auth/sign-in";
import type { NotificationProjector } from "@/modules/N1/notifications/projection";
import type { OmpRuntime } from "@/modules/R0/runtime";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import type { ThreadScrollController } from "@/modules/U1/scroll/thread-scroll-controller";
import type { AttachmentManager } from "@/modules/U2/attachments";
import { isCitedTextRef, withPastedText } from "@/modules/U2/attachments";
import type { PromptIntent } from "@/modules/U2/contract";
import type { UseChatDraftResult } from "@/modules/U2/drafts/use-chat-draft";
import type { OverlayHostApi } from "@/overlay";
import type { ThreadAgents } from "./agents/thread-agents";
import type { CommandReport } from "./command-report/command-report";
import { perfMark } from "./perf-trace";
import { openProviderSignIn } from "./provider-login-section";
import { openSessionModelDialog } from "./session-controls";
import { routeSubmit, runSlashRoute } from "./slash-commands";
import type { ActiveThreadProps, SendAttachments } from "./thread-props";

interface ThreadSendInput {
  readonly agents: ThreadAgents | null;
  readonly slashTip: {
    readonly placeholder: string | undefined;
    readonly recordSlashSend: () => void;
  };
  readonly connection: AppConnectionSnapshot;
  readonly appSlashCommands: readonly SlashAppCommand[];
  readonly slashProvider: SlashCommandProvider | null;
  readonly showCommandOutput: (report: CommandReport) => void;
  readonly runtimeController: OmpRuntime["controller"];
  readonly scrollController: ThreadScrollController;
  readonly attachmentManager: AttachmentManager;
  readonly chatDraft: UseChatDraftResult;
  readonly notificationProjector: NotificationProjector;
  readonly commandGateway: PortClient<typeof OmpCommandGateway>;
  readonly overlay: OverlayHostApi;
  readonly claimReloadTarget: ActiveThreadProps["claimReloadTarget"];
  readonly registerLiveChat: ActiveThreadProps["registerLiveChat"];
  readonly deliverToOpenChat: ActiveThreadProps["deliverToOpenChat"];
  readonly onPromptSent: ActiveThreadProps["onPromptSent"];
  readonly newChatTicketNow: ActiveThreadProps["newChatTicketNow"];
  readonly onRefreshAfterCommand: ActiveThreadProps["onRefreshAfterCommand"];
  readonly history: ActiveThreadProps["history"];
  readonly threadId: ThreadId;
  readonly client: ActiveThreadProps["client"];
  readonly store: OmpRuntimeStore;
  readonly capabilities: CapabilityMap;
  readonly folder: ActiveThreadProps["folder"];
  readonly setCommandStatus: Dispatch<SetStateAction<string | null>>;
}

export function useThreadSend({
  agents,
  slashTip,
  connection,
  appSlashCommands,
  slashProvider,
  showCommandOutput,
  runtimeController,
  scrollController,
  attachmentManager,
  chatDraft,
  notificationProjector,
  commandGateway,
  overlay,
  claimReloadTarget,
  registerLiveChat,
  deliverToOpenChat,
  onPromptSent,
  newChatTicketNow,
  onRefreshAfterCommand,
  history,
  threadId,
  client,
  store,
  capabilities,
  folder,
  setCommandStatus,
}: ThreadSendInput) {
  // What a send does in the chat it is for: a slash command, or omp's prompt. It is read at the send, so a send that
  // waited for a chat to open runs in the chat on screen, never in the one before it. The attachments are the ones the
  // send carried when Enter was pressed (see `submit`): the chat on screen may be another view, which holds none.
  const deliver = useCallback(
    async (intent: PromptIntent, attachments: SendAttachments): Promise<void> => {
      const route = await routeSubmit({
        intent,
        hasAttachments: attachments.refs.length > 0,
        provider: slashProvider,
        appCommands: appSlashCommands,
      });
      if (route === null) {
        // A worker's end reaches the chat only through a worker stream that is on when the worker ends. The stream is requested
        // here, just before the prompt goes out, and nothing waits for it: a worker can start only after the prompt has been
        // sent and the model has answered.
        if (agents !== null) startWorkerStream(agents);
        const undoClaim = claimReloadTarget();
        try {
          await runtimeController.submitPrompt({
            ...intent,
            // A pasted-text chip sends its full text, from the file the composer held when Enter was pressed.
            text: withPastedText(intent.text, attachments.complete),
            attachmentRefs: attachments.refs,
          });
        } catch (error) {
          undoClaim?.();
          throw error;
        }
      } else {
        await runSlashRoute({
          route,
          intent,
          provider: slashProvider,
          showStatus: setCommandStatus,
          showReport: showCommandOutput,
          runMode: (request, options) => commandGateway.modeChange({ threadId, request }, options),
        });
        slashTip.recordSlashSend();
      }
      perfMark("send_delivered");
    },
    [
      agents,
      appSlashCommands,
      claimReloadTarget,
      commandGateway,
      runtimeController,
      showCommandOutput,
      slashProvider,
      threadId,
      slashTip.recordSlashSend,
      setCommandStatus,
    ],
  );
  // The view for the chat on screen registers how a send reaches it, and how a rewind's note reaches it (see `deliverToOpenChat`).
  const showNote = useCallback(
    (note: NoSwitchNote): void => showNoSwitchNote(notificationProjector, threadId, note),
    [notificationProjector, threadId],
  );
  useLayoutEffect(
    () => registerLiveChat(threadId, deliver, showNote),
    [deliver, registerLiveChat, showNote, threadId],
  );
  const submit = async (intent: PromptIntent): Promise<void> => {
    onPromptSent();
    perfMark("send_accepted");
    // Sending shows the newest message, wherever the reader had scrolled to; the transcript then
    // keeps following by itself because it is at the bottom.
    scrollController.jumpToLatest();
    // The draft keeps the text until the send is admitted. The send goes to the chat that is open when it is delivered,
    // carrying the attachments this composer held at Enter (`holdForSend`, issue 2681), or holds now when no send kept them:
    // that chat's view may be another one, which holds none of them.
    const carried = attachmentManager.takeHeldForSend() ?? {
      refs: attachmentManager.toDraftRefs(),
      complete: attachmentManager.getState().complete,
    };
    // A text file the message cites by reference went into the chat's folder, not with the prompt (issue 2658).
    const attachments: SendAttachments = {
      refs: carried.refs.filter((ref) => !isCitedTextRef(ref)),
      complete: carried.complete,
    };
    // A later New chat waits for this ticket's full draft submission, including clearing or restoring its text.
    const newChatTicket = newChatTicketNow();
    const newChatEnd = newChatTicket?.outcome ?? null;
    // Where a send that is not sent keeps its text: a New chat's text stays in the folder's new-chat box (chat-draft.ts).
    const submission = chatDraft.submit(intent, (sent) =>
      deliverToOpenChat(
        sent,
        attachments,
        newChatEnd,
        chatDraft.controller.getSnapshot().scope.kind === "folder",
      ),
    );
    newChatTicket?.trackSend(submission);
    await submission;
    if (intent.mode === "bash") void onRefreshAfterCommand?.();
    attachmentManager.clearAfterSend();
    scrollController.jumpToLatest();
  };
  const cancel = (): Promise<void> => runtimeController.cancel();
  const queueConnection = {
    state:
      connection.state === "connected"
        ? ("connected" as const)
        : connection.state === "reconnecting"
          ? ("reconnecting" as const)
          : connection.state === "connecting"
            ? ("connecting" as const)
            : ("closed" as const),
    reason: connection.reason,
  };
  // While the app reconnects the chat stays on screen: the composer keeps the text and says it cannot send yet.
  const sendBlockedReason = history.isSwitching
    ? "Opening session… omp is starting. This can take a few seconds."
    : connection.state === "connected"
      ? undefined
      : SEND_BLOCKED_TEXT;
  // What a refused-key notice in the transcript can do: open the model list, open sign-in, and read each
  // provider's sign-in. Built once per open chat; a view only calls these.
  const credentialActions = useMemo<CredentialActions>(
    () => ({
      chooseModel: () =>
        openSessionModelDialog({ overlay, client, store, threadId, capabilities, folder }),
      signIn: () => openProviderSignIn({ overlay, client, threadId, capabilities }),
      readSignIns: () => readProviderSignIns({ client, threadId }),
    }),
    [overlay, client, store, threadId, capabilities, folder],
  );
  return { submit, cancel, queueConnection, sendBlockedReason, credentialActions };
}
