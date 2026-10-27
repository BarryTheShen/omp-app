import type { HostCallId, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { useEffect, useMemo } from "react";
import type { NotificationProjector } from "@/modules/N1/notifications";
import type { QueueController } from "@/modules/R0/actions";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import {
  cancelledHostToolResult,
  cancelledHostUriResult,
  type HostRequestAnswer,
} from "@/modules/U4/contract/host-answers";
import type { DialogHostController } from "@/modules/U4/host";
import {
  ExtensionUiRequestRouterController,
  optIntoRichAsk,
  subscribeNonModalExtensionUi,
} from "@/modules/U4/router";
import { useStableOverlayHost } from "@/overlay";
import { reportClientError } from "./client-errors";

export function RouterBridge({
  store,
  threadId,
  queueController,
  dialogHost,
  notificationProjector,
  askDialogOffered,
  switching,
  send,
}: {
  readonly store: OmpRuntimeStore;
  readonly threadId: ThreadId;
  readonly queueController: QueueController;
  readonly dialogHost: DialogHostController;
  readonly notificationProjector: NotificationProjector;
  readonly askDialogOffered: boolean;
  readonly switching: boolean;
  readonly send: RpcSessionSend;
}) {
  // Stable: the router must not be rebuilt every time some overlay opens or closes.
  const overlay = useStableOverlayHost();
  const hostAnswers = useMemo(() => {
    const submit = async (
      answer: HostRequestAnswer,
      options?: { readonly signal?: AbortSignal },
    ): Promise<void> => {
      const id = answer.requestId;
      if (answer.kind === "uri-result") {
        await queueController.answerHostUri(
          { type: "host_uri_result", id, ...answer.result },
          options,
        );
      } else if (answer.kind === "tool-update") {
        await queueController.answerHostTool(
          { type: "host_tool_update", id, partialResult: answer.partialResult },
          options,
        );
      } else {
        await queueController.answerHostTool(
          { type: "host_tool_result", id, result: answer.result, isError: answer.result.isError },
          options,
        );
      }
    };
    return {
      submit,
      cancel: (
        requestId: HostCallId,
        reason: string,
        options?: { readonly signal?: AbortSignal },
      ) =>
        submit(
          store.getSnapshot().pending.hostUris[requestId]
            ? cancelledHostUriResult(requestId, reason)
            : cancelledHostToolResult(requestId, reason),
          options,
        ),
    };
  }, [queueController, store]);
  const router = useMemo(
    () =>
      new ExtensionUiRequestRouterController({
        dialogHost,
        overlay,
        hostAnswers,
        presentations: notificationProjector,
      }),
    [dialogHost, hostAnswers, notificationProjector, overlay],
  );
  useEffect(() => {
    const sync = () => {
      const pending = store.getSnapshot().pending;
      void router
        .sync(
          {
            dialogs: pending.dialogs,
            hostTools: pending.hostTools,
            hostUris: pending.hostUris,
          },
          { threadId },
        )
        .catch(() =>
          notificationProjector.present(
            { kind: "notify", message: "An omp update could not be shown.", notifyType: "error" },
            { threadId },
          ),
        );
    };
    const unsubscribe = store.subscribe(sync);
    sync();
    return () => {
      unsubscribe();
    };
  }, [router, store, threadId, notificationProjector.present]);
  useEffect(
    () => subscribeNonModalExtensionUi(store, router, { threadId }),
    [router, store, threadId],
  );

  // omp asks each question as a select list until this session opts in to rich `ask` requests. A page sends the opt-in
  // each time it shows the chat, once no switch to it is pending: the server keeps it for the chat and re-sends it to every
  // new omp (rpc-session.ts, #respawn). A chat picked from a list is shown at the click, before omp opens it (issue 2212),
  // so the opt-in waits for that switch to end. It ends too when the chat's load fails, and the opt-in restarts omp then.
  useEffect(() => {
    if (!askDialogOffered || switching) return;
    void optIntoRichAsk(send, threadId).catch((error: unknown) =>
      reportClientError({
        kind: "error",
        message: `Rich ask questions could not be turned on: ${error instanceof Error ? error.message : "unknown error"}`,
      }),
    );
  }, [askDialogOffered, send, switching, threadId]);
  return null;
}
