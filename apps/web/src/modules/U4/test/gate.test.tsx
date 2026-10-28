import type { CapabilityMap, ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { OverlayHost, useOverlayHost } from "@/overlay";
import { QueueController } from "../../R0/actions/actions";
import { playRecording, type RecordedSession } from "../../R0/fixtures/recorded-session";
import { UI_ROUND_TRIP } from "../../R0/fixtures/recordings";
import { OmpRuntimeStore, type RuntimeSnapshot } from "../../R0/store/store";
import { renderDialogRequest } from "../dialogs";
import { DialogHostController } from "../host";
import { ExtensionUiRequestRouterController } from "../router";

const threadId = "u4-gate-thread" as ThreadId;
const capabilities: CapabilityMap = {
  "omp.ui": { state: "available", via: "rpc" },
  "omp.cmd.set_ask_dialog": { state: "available", via: "rpc" },
};

/**
 * The replay test waits on events that the recording and the dialog produce. RTL's 1 s default is shorter than a stall of
 * a loaded worker (issue 2271), so each of its waits allows 5 s. Every wait still ends on its event; nothing is slept.
 */
const EVENT_WAIT = { timeout: 5000 } as const;

afterEach(cleanup);

interface RecordingHarness {
  readonly session: RecordedSession;
  readonly store: OmpRuntimeStore;
  readonly queue: QueueController;
  readonly threadId: ThreadId;
}

/** R0's store on the recorded ask round trip: the rich ask dialog switched on, then the prompt that asks. */
async function openRecordingHarness(): Promise<RecordingHarness> {
  const session = playRecording(UI_ROUND_TRIP);
  const store = new OmpRuntimeStore({ threadId, transport: { answer: session.answer } });
  session.onEvent((event, seq) => store.ingest(event, seq));
  const queue = new QueueController({ store, send: session.request, capabilities });
  await session.request({ threadId, method: "set_ask_dialog", params: { enabled: true } });
  void session
    .request({ threadId, method: "prompt", params: { text: "ask_user" } })
    .catch(() => undefined);
  return { session, store, queue, threadId };
}

function waitForSnapshot(
  store: OmpRuntimeStore,
  predicate: (snapshot: RuntimeSnapshot) => boolean,
  options: { readonly timeout: number },
) {
  return waitFor(() => {
    const snapshot = store.getSnapshot();
    expect(predicate(snapshot)).toBe(true);
    return snapshot;
  }, options);
}

interface U4HarnessState {
  host: DialogHostController | undefined;
  router: ExtensionUiRequestRouterController | undefined;
}

function RealU4Harness({ state, queue }: { state: U4HarnessState; queue: QueueController }) {
  const overlay = useOverlayHost();
  const hostRef = useRef<DialogHostController | null>(null);
  const routerRef = useRef<ExtensionUiRequestRouterController | null>(null);
  if (hostRef.current === null) {
    hostRef.current = new DialogHostController({
      overlay,
      capabilities,
      answerDialog: (id, answer, options) => queue.answerDialog(id, answer, options),
      render: renderDialogRequest,
    });
    routerRef.current = new ExtensionUiRequestRouterController({
      dialogHost: hostRef.current,
      overlay,
      hostAnswers: { submit: async () => {}, cancel: async () => {} },
    });
  }
  const host = hostRef.current;
  const router = routerRef.current;
  useEffect(() => {
    state.host = host;
    state.router = router ?? undefined;
    return () => host.dispose();
  }, [host, router, state]);
  return null;
}

describe("U4.7 W3/CC7 recording-backed gate", () => {
  test("replays ui-round-trip through R0.1/R0.5, router, DialogHost and Ask renderer", async () => {
    const harness = await openRecordingHarness();
    const state: U4HarnessState = { host: undefined, router: undefined };
    render(
      <OverlayHost>
        <RealU4Harness state={state} queue={harness.queue} />
      </OverlayHost>,
    );
    try {
      await waitForSnapshot(
        harness.store,
        (snapshot) => Object.keys(snapshot.pending.dialogs).length > 0,
        EVENT_WAIT,
      );
      const pending = Object.values(harness.store.getSnapshot().pending.dialogs)[0];
      if (pending?.request.method !== "ui.ask")
        throw new Error("the recording did not produce its ask request");
      await waitFor(() => {
        expect(state.router).toBeDefined();
        expect(state.host).toBeDefined();
      }, EVENT_WAIT);
      const router = state.router;
      if (!router) throw new Error("U4 router did not initialize");
      const routing = router.routeDialog(
        { request: pending.request, receivedSeq: pending.receivedSeq },
        { threadId: harness.threadId },
      );
      await screen.findByTestId("ask-question-db", {}, EVENT_WAIT);
      fireEvent.click(screen.getByRole("radio", { name: "SQLite" }));
      fireEvent.click(screen.getByRole("button", { name: "Review" }));
      fireEvent.click(screen.getByRole("button", { name: "Submit" }));
      await routing;
      await waitForSnapshot(
        harness.store,
        (snapshot) => Object.keys(snapshot.pending.dialogs).length === 0,
        EVENT_WAIT,
      );
      expect(harness.store.getSnapshot().pending.dialogs).toEqual({});
    } finally {
      harness.session.close();
    }
  }, 30_000);

  test("real DialogHost abort sends deny-by-default cancellation and restores focus", async () => {
    const answers: unknown[] = [];
    let host!: DialogHostController;
    const restore = () => answers.push("restored");
    function Harness() {
      const overlay = useOverlayHost();
      if (!host) {
        host = new DialogHostController({
          overlay,
          capabilities,
          answerDialog: async (id, answer) => {
            answers.push({ id, answer });
          },
          render: renderDialogRequest,
        });
      }
      useEffect(() => () => host.dispose(), []);
      return <button type="button">Opener</button>;
    }
    render(
      <OverlayHost>
        <Harness />
      </OverlayHost>,
    );
    const controller = new AbortController();
    const opener = screen.getByRole("button", { name: "Opener" });
    opener.focus();
    const pending = host.open(
      {
        kind: "confirm",
        id: "gate-confirm" as never,
        title: "Continue?",
        message: "Proceed?",
      },
      { threadId, signal: controller.signal, restoreFocus: restore },
    );
    await screen.findByRole("dialog", { name: "Continue?" });
    controller.abort();
    await expect(pending).resolves.toMatchObject({
      outcome: "cancelled",
      kind: "confirm",
      timedOut: false,
    });
    // The restore runs once the dialog has unmounted and released its focus trap, so the check waits for it.
    await waitFor(() =>
      expect(answers).toEqual([{ id: "gate-confirm", answer: { cancelled: true } }, "restored"]),
    );
  });

  test("secret input never appears in the DOM or result text", async () => {
    const secret = "runtime-only-secret";
    render(
      <OverlayHost>
        <div data-testid="secret-test">
          {renderDialogRequest(
            {
              kind: "input",
              id: "gate-secret" as never,
              title: "Secret input",
              secret: true,
            } as never,
            {
              request: {
                kind: "input",
                id: "gate-secret" as never,
                title: "Secret input",
              },
              threadId,
              signal: new AbortController().signal,
              answer: async () => {},
              cancel: async () => {},
              keepDraft: () => undefined,
            },
          )}
        </div>
      </OverlayHost>,
    );
    const input = screen.getByLabelText("Secret input");
    fireEvent.change(input, { target: { value: secret } });
    expect(input.getAttribute("type")).toBe("password");
    expect(screen.queryByText(secret)).toBeNull();
    expect(screen.getByTestId("secret-test").textContent).not.toContain(secret);
  });

  test("an optional app input submits blank as a skip; a required one refuses blank", async () => {
    const answers: unknown[] = [];
    const context = (optional: boolean) => ({
      request: { kind: "input" as const, id: "gate-optional" as never, title: "SSH user" },
      threadId,
      signal: new AbortController().signal,
      answer: async (response: unknown) => {
        answers.push({ optional, response });
      },
      cancel: async () => {},
      keepDraft: () => undefined,
    });
    const { unmount } = render(
      <OverlayHost>
        {renderDialogRequest(
          { kind: "input", id: "gate-optional" as never, title: "SSH user", optional: true },
          context(true),
        )}
      </OverlayHost>,
    );
    expect(screen.getByText("Leave blank to skip.")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("SSH user"), { target: { value: "   " } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await waitFor(() =>
      expect(answers).toEqual([{ optional: true, response: { kind: "input", value: "" } }]),
    );
    unmount();

    render(
      <OverlayHost>
        {renderDialogRequest(
          { kind: "input", id: "gate-required" as never, title: "SSH host" },
          context(false),
        )}
      </OverlayHost>,
    );
    expect(screen.queryByText("Leave blank to skip.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText("Enter a value before continuing.")).toBeTruthy();
    expect(answers).toHaveLength(1);
  });
});
