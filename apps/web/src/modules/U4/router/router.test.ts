import type { HostCallId, ThreadId, UiRequestId } from "@omp-app/contracts";
import type { HostDialogRequest } from "@omp-app/contracts/chat-host";
import { describe, expect, test, vi } from "vitest";
import { uiEvent } from "@/modules/R0/store/session-events";
import type { OverlayHostApi, OverlayOpenOptions, OverlayOpenResult } from "@/overlay";
import { NotificationProjector } from "../../N1/notifications";
import { OmpRuntimeStore } from "../../R0/store";
import type { DialogRequest } from "../contract/dialog";
import type { DialogHost, DialogHostOpenOptions } from "../contract/dialog-host";
import type { HostRequestAnswer, HostRequestAnswerAdapter } from "../contract/host-answers";
import type { DialogResult, DialogResultFor } from "../contract/responses";
import {
  ExtensionUiRequestRouterController,
  type PresentationSink,
  subscribeNonModalExtensionUi,
} from "./router";

const threadId = "router-thread" as ThreadId;

class FakeDialogHost implements DialogHost {
  readonly opened: DialogRequest[] = [];
  readonly cancelled: string[] = [];
  private readonly gates = new Map<
    string,
    ReturnType<typeof Promise.withResolvers<DialogResult>>
  >();

  public open<R extends DialogRequest>(
    request: R,
    _options: DialogHostOpenOptions,
  ): Promise<DialogResultFor<R>> {
    this.opened.push(request);
    const gate = Promise.withResolvers<DialogResult>();
    this.gates.set(String(request.id), gate);
    return gate.promise as Promise<DialogResultFor<R>>;
  }

  public resolve(id: string, result: DialogResult): void {
    this.gates.get(id)?.resolve(result);
  }

  public cancel(requestId: UiRequestId): void {
    this.cancelled.push(String(requestId));
    this.resolve(String(requestId), { outcome: "cancelled", kind: "confirm", timedOut: false });
  }

  public confirm(
    _request: Extract<DialogRequest, { kind: "confirm" }>,
    _options: DialogHostOpenOptions,
  ): Promise<boolean> {
    return Promise.resolve(false);
  }
}

class FakeOverlay implements OverlayHostApi {
  readonly opened: Array<{ id: string; options: OverlayOpenOptions }> = [];
  readonly closed: string[] = [];
  private sequence = 0;
  public overlays = [];

  public open(options: OverlayOpenOptions): OverlayOpenResult {
    this.sequence += 1;
    const id = `overlay-${this.sequence}`;
    const gate = Promise.withResolvers<"programmatic">();
    this.opened.push({ id, options });
    return { id, closed: gate.promise };
  }
  public close(id: string): void {
    this.closed.push(id);
  }
  public closeTopmost(): void {}
  public update(): void {}
}

class FakeHostAnswers implements HostRequestAnswerAdapter {
  readonly submitted: HostRequestAnswer[] = [];
  readonly cancelled: Array<{ requestId: HostCallId; reason: string }> = [];
  public async submit(answer: HostRequestAnswer): Promise<void> {
    this.submitted.push(answer);
  }
  public async cancel(requestId: HostCallId, reason: string): Promise<void> {
    this.cancelled.push({ requestId, reason });
  }
}

function selectRequest(id: string, options = ["A", "B"]): HostDialogRequest {
  return { id, method: "ui.select", params: { title: "Pick", options } };
}

const CANCELLED: DialogResult = { outcome: "cancelled", kind: "select", timedOut: false };

describe("ExtensionUiRequestRouterController", () => {
  test("routes the host's dialogs to DialogHost and its UI events to the sink", async () => {
    const dialogHost = new FakeDialogHost();
    const handoffs: string[] = [];
    const presentations: PresentationSink = {
      present: (handoff) => {
        handoffs.push(handoff.kind);
      },
    };
    const router = new ExtensionUiRequestRouterController({
      dialogHost,
      overlay: new FakeOverlay(),
      hostAnswers: new FakeHostAnswers(),
      presentations,
    });
    const context = { threadId };

    const modal = router.routeDialog(
      { request: selectRequest("select-1"), receivedSeq: 1 },
      context,
    );
    expect(dialogHost.opened[0]).toMatchObject({ id: "select-1", kind: "select" });
    dialogHost.resolve("select-1", CANCELLED);
    await modal;
    await router.routeNotification({ type: "ui_notify", message: "Hello" }, 2, context);
    expect(handoffs).toEqual(["notify"]);
  });

  test("bridges R0's UI events to N1 with event ordering", () => {
    const store = new OmpRuntimeStore({ threadId });
    const editorTexts: string[] = [];
    const projector = new NotificationProjector({
      source: store,
      onEditorText: (text) => editorTexts.push(text),
    });
    const overlay = new FakeOverlay();
    const router = new ExtensionUiRequestRouterController({
      dialogHost: new FakeDialogHost(),
      overlay,
      hostAnswers: new FakeHostAnswers(),
      presentations: projector,
    });
    const unsubscribe = subscribeNonModalExtensionUi(store, router, { threadId });

    store.ingest(uiEvent({ type: "ui_notify", message: "Build finished", notifyType: "info" }), 1);
    store.ingest(uiEvent({ type: "ui_notify", message: "Build finished", notifyType: "info" }), 2);
    store.ingest(uiEvent({ type: "ui_status", statusKey: "build", statusText: "Running" }), 3);
    store.ingest(
      uiEvent({
        type: "ui_widget",
        widgetKey: "build-output",
        widgetLines: ["Compiling"],
        widgetPlacement: "belowEditor",
      }),
      4,
    );
    store.ingest(uiEvent({ type: "ui_title", title: "Build session" }), 5);
    store.ingest(uiEvent({ type: "ui_editor_text", text: "draft" }), 6);
    store.ingest(
      uiEvent({
        type: "ui_open_url",
        url: "https://accounts.example/authorize",
        launchUrl: "https://accounts.example/continue",
      }),
      7,
    );

    const notifications = projector
      .getBus()
      .getSnapshot()
      .notifications.filter((item) => item.source === "extension");
    expect(notifications.map((item) => item.message)).toEqual(["Build finished", "Build finished"]);
    expect(notifications[0]?.dedupeKey).not.toBe(notifications[1]?.dedupeKey);
    expect(projector.getSnapshot().statuses).toEqual([
      { statusKey: "build", statusText: "Running" },
    ]);
    expect(projector.getSnapshot().widgets).toEqual([
      expect.objectContaining({
        widgetKey: "build-output",
        placement: "belowEditor",
        lines: ["Compiling"],
      }),
    ]);
    expect(projector.getSnapshot().title).toBe("Build session");
    expect(editorTexts).toEqual(["draft"]);
    expect(overlay.opened).toHaveLength(1);
    unsubscribe();
    projector.dispose();
  });

  test("a UI event that cannot be shown leaves a notice, and later dialogs are still routed", async () => {
    const dialogHost = new FakeDialogHost();
    const overlay = new FakeOverlay();
    const router = new ExtensionUiRequestRouterController({
      dialogHost,
      overlay,
      hostAnswers: new FakeHostAnswers(),
      presentations: {
        present: () => {
          throw new Error("bad presentation");
        },
      },
    });
    await router.routeNotification({ type: "ui_title", title: " " }, 1, { threadId });
    expect(overlay.opened).toHaveLength(1);
    const sync = router.sync(
      {
        dialogs: {
          "confirm-1": {
            request: {
              id: "confirm-1",
              method: "ui.confirm",
              params: { title: "Continue?", message: "Should the task continue?" },
            },
            receivedSeq: 2,
          },
        },
        hostTools: {},
        hostUris: {},
      },
      { threadId },
    );
    await vi.waitFor(() => expect(dialogHost.opened).toHaveLength(1));
    expect(dialogHost.opened[0]).toMatchObject({ kind: "confirm", id: "confirm-1" });
    dialogHost.resolve("confirm-1", { outcome: "cancelled", kind: "confirm", timedOut: false });
    await sync;
  });

  test("an unsafe sign-in page opens no prompt; a valid one keeps its full URL out of the visible prompt", async () => {
    const overlay = new FakeOverlay();
    const router = new ExtensionUiRequestRouterController({
      dialogHost: new FakeDialogHost(),
      overlay,
      hostAnswers: new FakeHostAnswers(),
    });
    await router.routeNotification({ type: "ui_open_url", url: "javascript:alert(1)" }, 1, {
      threadId,
    });
    // Only the notice that an update could not be shown: no sign-in prompt.
    expect(overlay.opened.map(({ options }) => options.kind)).toEqual(["toast"]);
    await router.routeNotification(
      {
        type: "ui_open_url",
        url: "https://accounts.example/authorize?token=ephemeral",
        launchUrl: "https://localhost/callback",
        instructions: "Complete sign-in in the provider window.",
      },
      2,
      { threadId },
    );
    expect(overlay.opened.map(({ options }) => options.kind)).toEqual(["toast", "popover"]);
    expect(typeof overlay.opened[1]?.options.content).toBe("function");
  });

  test("answers host tools once and rejects a duplicate answer", async () => {
    const answers = new FakeHostAnswers();
    const router = new ExtensionUiRequestRouterController({
      dialogHost: new FakeDialogHost(),
      overlay: new FakeOverlay(),
      hostAnswers: answers,
    });
    const request = {
      type: "host_tool_call" as const,
      id: "host-1",
      toolCallId: "tool-1",
      toolName: "workspace.read",
      arguments: {},
    };
    await router.routeHostRequest({ request, receivedSeq: 1 }, { threadId });
    const answer: HostRequestAnswer = {
      kind: "tool-result",
      requestId: "host-1" as HostCallId,
      result: { content: [{ type: "text", text: "done" }] },
    };
    await router.answerHost(answer);
    expect(answers.submitted).toHaveLength(1);
    await expect(router.answerHost(answer)).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
  });

  test("sync shows pending dialogs one at a time, in received-sequence order", async () => {
    const dialogHost = new FakeDialogHost();
    const router = new ExtensionUiRequestRouterController({
      dialogHost,
      overlay: new FakeOverlay(),
      hostAnswers: new FakeHostAnswers(),
    });
    const opened = () => dialogHost.opened.map((request) => String(request.id));
    const sync = router.sync(
      {
        dialogs: {
          late: { request: selectRequest("late"), receivedSeq: 3 },
          early: { request: selectRequest("early"), receivedSeq: 1 },
        },
        hostTools: {},
        hostUris: {},
      },
      { threadId },
    );
    await vi.waitFor(() => expect(opened()).toEqual(["early"]));
    dialogHost.resolve("early", CANCELLED);
    await vi.waitFor(() => expect(opened()).toEqual(["early", "late"]));
    dialogHost.resolve("late", CANCELLED);
    await sync;
  });

  test("a dialog the store drops closes without an answer, newest first, so a queued one is not handed over", async () => {
    const dialogHost = new FakeDialogHost();
    const router = new ExtensionUiRequestRouterController({
      dialogHost,
      overlay: new FakeOverlay(),
      hostAnswers: new FakeHostAnswers(),
    });
    const shown = router.routeDialog(
      { request: selectRequest("q-shown"), receivedSeq: 1 },
      { threadId },
    );
    const queued = router.routeDialog(
      { request: selectRequest("q-queued"), receivedSeq: 2 },
      { threadId },
    );
    expect(dialogHost.opened.map((request) => String(request.id))).toEqual(["q-shown", "q-queued"]);
    // The host gave both up (its cancel, or its process ended), so R0 holds neither. Both close without an answer, and
    // the newer one closes first: the dialog host shows the next queued dialog as soon as the one showing closes.
    await router.sync({ dialogs: {}, hostTools: {}, hostUris: {} }, { threadId });
    expect(dialogHost.cancelled).toEqual(["q-queued", "q-shown"]);
    await Promise.all([shown, queued]);
  });
});
