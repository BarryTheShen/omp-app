/// <reference types="node" />
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  CapabilityMap,
  Fixture,
  ExtensionUiResponse as PortExtensionUiResponse,
  RpcSessionSend,
  ThreadId,
} from "@omp-app/contracts";
import { AppFailure, parseFixture } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { OverlayHost, useOverlayHost } from "@/overlay";
import { FixtureSession } from "../../../../../../packages/omp-rpc/src/fixtures";
import type { RpcDuplex } from "../../../../../../packages/omp-rpc/src/session";
import { RpcSession } from "../../../../../../packages/omp-rpc/src/session";
import { QueueController } from "../../R0/actions/actions";
import { sessionEventOfRpc } from "../../R0/store/session-events";
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
 * The replay test waits on events that the fixture and the dialog produce. RTL's 1 s default is shorter than a stall of a
 * loaded worker (issue 2271), so each of its waits allows 5 s. Every wait still ends on its event; nothing is slept.
 */
const EVENT_WAIT = { timeout: 5000 } as const;

afterEach(cleanup);

function fixture(): Fixture {
  const text = readFileSync(
    resolve(process.cwd(), "../../packages/omp-rpc/fixtures/ui-round-trip.fixture.jsonl"),
    "utf8",
  );
  const parsed = parseFixture(text);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return parsed.value;
}

interface FixtureHarness {
  readonly session: RpcSession;
  readonly store: OmpRuntimeStore;
  readonly queue: QueueController;
  readonly threadId: ThreadId;
  close(): Promise<void>;
}

async function openFixtureHarness(): Promise<FixtureHarness> {
  const replay = new FixtureSession({ fixture: fixture() });
  const duplex: RpcDuplex = {
    writeLine: (line) => replay.writeLine(line),
    onChunk: (listener) => replay.onChunk((chunk) => listener(Uint8Array.from(chunk))),
    onClose: (listener) => replay.onClose(listener),
    close: () => replay.close(),
  };
  const session = new RpcSession(duplex);
  let sequence = 0;
  const store = new OmpRuntimeStore({
    threadId,
    transport: {
      // The fixture is a recorded omp-rpc session until H5.6: the host's answer is omp's RPC response with the same
      // fields.
      answer: async ({ id, answer }) => {
        await session.answerExtensionUi({
          type: "extension_ui_response",
          id,
          ...(answer as object),
        } as unknown as PortExtensionUiResponse);
        return null;
      },
    },
  });
  session.onEvent((event) => {
    sequence += 1;
    store.ingest(sessionEventOfRpc(event), sequence);
  });
  await session.start();
  const send: RpcSessionSend = (args, options) => session.send(args.command, options) as never;
  const queue = new QueueController({ store, send, capabilities });
  await session.send({ type: "set_ask_dialog", enabled: true });
  const prompt = session.send({ type: "prompt", message: "ask_user" });
  void prompt.catch(() => undefined);
  return {
    session,
    store,
    queue,
    threadId,
    close: async () => {
      try {
        await session.close();
      } catch (error) {
        if (!(error instanceof AppFailure) || error.appError.code !== "cancelled") throw error;
      }
    },
  };
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

describe("U4.7 W3/CC7 fixture-backed gate", () => {
  test("replays ui-round-trip through R0.1/R0.5, router, DialogHost and Ask renderer", async () => {
    const harness = await openFixtureHarness();
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
        throw new Error("fixture did not produce ask request");
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
      await harness.close();
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
