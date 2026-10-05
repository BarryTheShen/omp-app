import type { HostCallId, OmpWire, ThreadId, UiRequestId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import type { OverlayHostApi, OverlayOpenOptions, OverlayOpenResult } from "@/overlay";
import type { DialogRequest } from "../contract/dialog";
import type { DialogHost, DialogHostOpenOptions } from "../contract/dialog-host";
import type { HostRequestAnswer, HostRequestAnswerAdapter } from "../contract/host-answers";
import type { DialogResult, DialogResultFor } from "../contract/responses";
import { ExtensionUiRequestRouterController, type PresentationSink } from "./router";

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

function selectRequest(id: string, options = ["A", "B"]): OmpWire.SelectUiRequest {
  return { type: "extension_ui_request", id, method: "select", title: "Pick", options };
}

describe("ExtensionUiRequestRouterController", () => {
  test("routes modal requests to DialogHost and presentation requests to the sink", async () => {
    const dialogHost = new FakeDialogHost();
    const handoffs: OmpWire.ExtensionUiRequest["method"][] = [];
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

    const modal = router.routeExtensionUi(
      { request: selectRequest("select-1"), receivedSeq: 1 },
      context,
    );
    expect(dialogHost.opened[0]).toMatchObject({ id: "select-1", kind: "select" });
    dialogHost.resolve("select-1", { outcome: "cancelled", kind: "select", timedOut: false });
    await modal;
    await router.routeExtensionUi(
      {
        request: {
          type: "extension_ui_request",
          id: "notify-1",
          method: "notify",
          message: "Hello",
        },
        receivedSeq: 2,
      },
      context,
    );
    expect(handoffs).toEqual(["notify"]);
  });

  test("rejects unsafe OAuth schemes and keeps valid full URLs out of the visible prompt", async () => {
    const overlay = new FakeOverlay();
    const router = new ExtensionUiRequestRouterController({
      dialogHost: new FakeDialogHost(),
      overlay,
      hostAnswers: new FakeHostAnswers(),
    });
    await expect(
      router.routeExtensionUi(
        {
          request: {
            type: "extension_ui_request",
            id: "bad",
            method: "open_url",
            url: "javascript:alert(1)",
          },
          receivedSeq: 1,
        },
        { threadId },
      ),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    const valid = router.routeExtensionUi(
      {
        request: {
          type: "extension_ui_request",
          id: "oauth",
          method: "open_url",
          url: "https://accounts.example/authorize?token=ephemeral",
          launchUrl: "https://localhost/callback",
          instructions: "Complete sign-in in the provider window.",
        },
        receivedSeq: 2,
      },
      { threadId },
    );
    expect(overlay.opened).toHaveLength(1);
    const content = overlay.opened[0]?.options.content;
    expect(typeof content).toBe("function");
    await valid;
  });

  test("omp cancellation closes the presentation without answering", async () => {
    const dialogHost = new FakeDialogHost();
    const router = new ExtensionUiRequestRouterController({
      dialogHost,
      overlay: new FakeOverlay(),
      hostAnswers: new FakeHostAnswers(),
    });
    const pending = router.routeExtensionUi(
      { request: selectRequest("cancel-me"), receivedSeq: 1 },
      { threadId },
    );
    await Promise.resolve();
    await router.routeExtensionUi(
      {
        request: {
          type: "extension_ui_request",
          id: "cancel-frame",
          method: "cancel",
          targetId: "cancel-me",
        },
        receivedSeq: 2,
      },
      { threadId },
    );
    expect(dialogHost.cancelled).toEqual(["cancel-me"]);
    await pending;
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

  test("sync routes pending records in received-sequence order", async () => {
    const dialogHost = new FakeDialogHost();
    const handoffs: string[] = [];
    const router = new ExtensionUiRequestRouterController({
      dialogHost,
      overlay: new FakeOverlay(),
      hostAnswers: new FakeHostAnswers(),
      presentations: { present: (handoff) => void handoffs.push(handoff.kind) },
    });
    await router.sync(
      {
        extensionUi: {
          late: {
            request: {
              type: "extension_ui_request",
              id: "late",
              method: "notify",
              message: "late",
            },
            receivedSeq: 3,
          },
          early: {
            request: {
              type: "extension_ui_request",
              id: "early",
              method: "notify",
              message: "early",
            },
            receivedSeq: 1,
          },
        },
        hostTools: {},
        hostUris: {},
      },
      { threadId },
    );
    expect(handoffs).toEqual(["notify", "notify"]);
  });
});
