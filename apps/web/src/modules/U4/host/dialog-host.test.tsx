import type { CapabilityMap, OmpWire, ThreadId, UiRequestId } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OverlayHost, type OverlayHostApi, useOverlayHost } from "@/overlay";
import type { DialogHostOpenOptions, DialogRequest, DialogResponse } from "../contract";
import { DialogHostController } from "./dialog-host";

afterEach(cleanup);

const threadA = "thread-a" as ThreadId;
const threadB = "thread-b" as ThreadId;
const ompUiCapabilities: CapabilityMap = {
  "omp.ui": { state: "available", via: "rpc" },
};

function request(
  kind: "confirm" | "select" = "confirm",
  id = "request-1",
  timeoutMs?: number,
): DialogRequest {
  if (kind === "select") {
    return {
      kind,
      id: id as UiRequestId,
      title: id,
      options: ["Approve", "Deny"],
      timeoutMs,
    };
  }
  return { kind, id: id as UiRequestId, title: id, message: "Continue?", timeoutMs };
}

interface HarnessState {
  controller: DialogHostController | undefined;
  overlay: OverlayHostApi | undefined;
  answers: OmpWire.ExtensionUiResponse[];
  answer: ((response: DialogResponse) => Promise<void>) | undefined;
  deadlines: Record<string, number | undefined>;
}

function Harness({
  state,
  capabilities,
}: {
  readonly state: HarnessState;
  readonly capabilities: CapabilityMap;
}) {
  const overlay = useOverlayHost();
  const controllerRef = useRef<DialogHostController | null>(null);
  if (controllerRef.current === null) {
    controllerRef.current = new DialogHostController({
      overlay,
      capabilities,
      answerExtensionUi: async (response) => {
        state.answers.push(response);
      },
      render: (dialogRequest, context) => {
        state.answer = context.answer;
        state.deadlines[dialogRequest.id] = context.deadlineAt;
        return (
          <div data-testid={`body-${dialogRequest.id}`}>
            <p>
              {dialogRequest.kind === "ask"
                ? dialogRequest.questions[0]?.question
                : dialogRequest.title}
            </p>
            <button
              type="button"
              onClick={() => {
                const response: DialogResponse =
                  dialogRequest.kind === "confirm"
                    ? { kind: "confirm", confirmed: true }
                    : { kind: "select", value: "Approve" };
                void context.answer(response);
              }}
            >
              Approve
            </button>
            <button type="button" onClick={() => void context.cancel()}>
              Cancel
            </button>
          </div>
        );
      },
    });
  }
  const controller = controllerRef.current;
  useEffect(() => {
    state.controller = controller;
    return () => controller.dispose();
  }, [controller, state]);
  useEffect(() => {
    state.overlay = overlay;
  }, [overlay, state]);
  return <button type="button">Opener</button>;
}

function renderHarness(capabilities = ompUiCapabilities) {
  const state: HarnessState = {
    controller: undefined,
    overlay: undefined,
    answers: [],
    answer: undefined,
    deadlines: {},
  };
  render(
    <OverlayHost>
      <Harness state={state} capabilities={capabilities} />
    </OverlayHost>,
  );
  return state;
}

async function controllerFrom(state: HarnessState): Promise<DialogHostController> {
  await waitFor(() => expect(state.controller).toBeDefined());
  return state.controller as DialogHostController;
}

function open(
  controller: DialogHostController,
  dialogRequest: DialogRequest,
  threadId = threadA,
  extra: Pick<DialogHostOpenOptions, "signal" | "restoreFocus" | "origin"> = {},
): Promise<unknown> {
  let pending!: Promise<unknown>;
  act(() => {
    pending = controller.open(dialogRequest, { threadId, ...extra });
  });
  return pending;
}

describe("DialogHostController", () => {
  test("presents same-thread requests FIFO and advances after the first closes", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const first = open(controller, request("confirm", "first"));
    const second = open(controller, request("confirm", "second"));

    expect(await screen.findByRole("dialog", { name: "first" })).toBeTruthy();
    expect(screen.getByTestId("body-first")).toBeTruthy();
    expect(screen.queryByTestId("body-second")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(first).resolves.toEqual({
      outcome: "cancelled",
      kind: "confirm",
      timedOut: false,
    });
    expect(state.answers).toEqual([
      { type: "extension_ui_response", id: "first", cancelled: true },
    ]);

    await waitFor(() => expect(screen.getByTestId("body-second")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await expect(second).resolves.toEqual({
      outcome: "answered",
      response: { kind: "confirm", confirmed: true },
    });
  });

  test("a timed request gives its dialog the time the host will settle it, and a queued one keeps the time it was received", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const first = open(controller, request("confirm", "untimed"));
    await screen.findByRole("dialog", { name: "untimed" });
    expect(state.deadlines.untimed).toBeUndefined();

    const beforeQueued = Date.now();
    const queued = open(controller, request("confirm", "timed-later", 15_000));
    await state.answer?.({ kind: "confirm", confirmed: false });
    await first;
    await screen.findByRole("dialog", { name: "timed-later" });
    expect(state.deadlines["timed-later"]).toBeGreaterThanOrEqual(beforeQueued + 15_000);
    expect(state.deadlines["timed-later"]).toBeLessThanOrEqual(Date.now() + 15_000);
    await state.answer?.({ kind: "confirm", confirmed: true });
    await queued;
  });

  test("a dialog is named by its visible heading: the question of a select, the fixed heading of an ask", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const select = open(controller, {
      kind: "select",
      id: "which-database" as UiRequestId,
      title: "Which database?",
      options: ["SQLite", "Postgres"],
    });
    const question = await screen.findByRole("dialog", { name: "Which database?" });
    fireEvent.keyDown(question, { key: "Escape" });
    await expect(select).resolves.toMatchObject({ outcome: "cancelled" });

    const ask = open(controller, {
      kind: "ask",
      id: "ask-database" as UiRequestId,
      questions: [{ id: "q1", question: "Which database?", options: [{ label: "SQLite" }] }],
    });
    const asked = await screen.findByRole("dialog", { name: "Answer questions" });
    fireEvent.keyDown(asked, { key: "Escape" });
    await expect(ask).resolves.toMatchObject({ outcome: "cancelled" });
  });

  test("aborting while open sends one cancellation and restores the injected focus target", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const abortController = new AbortController();
    const restored: string[] = [];
    const pending = open(controller, request("select", "abort-me"), threadA, {
      signal: abortController.signal,
      restoreFocus: () => restored.push("restored"),
    });
    await screen.findByTestId("body-abort-me");

    abortController.abort();
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "select",
      timedOut: false,
    });
    expect(state.answers).toEqual([
      { type: "extension_ui_response", id: "abort-me", cancelled: true },
    ]);
    // The restore runs once the dialog has unmounted and released its focus trap, so the check waits for it.
    await waitFor(() => expect(restored).toEqual(["restored"]));
  });
  test("with restoreFocus, closing the dialog leaves focus on that element, not back inside the dialog", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    // Another element has focus when the dialog opens, so the overlay's own return cannot stand in for the target.
    const elsewhere = document.createElement("button");
    elsewhere.textContent = "Elsewhere";
    document.body.appendChild(elsewhere);
    try {
      elsewhere.focus();
      const target = screen.getByRole("button", { name: "Opener" });
      const pending = open(controller, request("confirm", "restore-focus"), threadA, {
        restoreFocus: () => target.focus(),
      });
      await screen.findByTestId("body-restore-focus");
      fireEvent.click(screen.getByRole("button", { name: "Approve" }));
      await expect(pending).resolves.toMatchObject({ outcome: "answered" });
      await waitFor(() => expect(document.activeElement).toBe(target));
    } finally {
      elsewhere.remove();
    }
  });
  test("app confirms settle locally without requiring omp.ui or answering omp", async () => {
    const state = renderHarness({});
    const controller = await controllerFrom(state);
    const accepted = controller.confirm(
      request("confirm", "app-confirm") as Extract<DialogRequest, { kind: "confirm" }>,
      { threadId: threadA, origin: "app" },
    );
    await screen.findByTestId("body-app-confirm");
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await expect(accepted).resolves.toBe(true);

    const cancelled = controller.confirm(
      request("confirm", "app-cancel") as Extract<DialogRequest, { kind: "confirm" }>,
      { threadId: threadA, origin: "app" },
    );
    await screen.findByTestId("body-app-cancel");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(cancelled).resolves.toBe(false);
    expect(state.answers).toEqual([]);
  });

  test("app confirmation cancellation and timeout settle locally", async () => {
    const state = renderHarness(ompUiCapabilities);
    const controller = await controllerFrom(state);
    const cancelled = open(controller, request("confirm", "app-cancelled"), threadA, {
      origin: "app",
    });
    await screen.findByTestId("body-app-cancelled");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(cancelled).resolves.toEqual({
      outcome: "cancelled",
      kind: "confirm",
      timedOut: false,
    });

    const timedOut = controller.confirm(
      request("confirm", "app-timeout", 10) as Extract<DialogRequest, { kind: "confirm" }>,
      { threadId: threadA, origin: "app" },
    );
    await expect(timedOut).resolves.toBe(false);
    expect(state.answers).toEqual([]);
  });

  test("requires app-owned ids to use the app prefix", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    await expect(
      open(controller, request("confirm", "missing-prefix"), threadA, { origin: "app" }),
    ).rejects.toMatchObject({ appError: { code: "invalid_args" } });
    expect(state.answers).toEqual([]);
  });

  test("confirm timeout resolves false and sends timedOut cancellation", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const timeoutRequest = request("confirm", "timeout", 10) as Extract<
      DialogRequest,
      { kind: "confirm" }
    >;
    const pending = controller.confirm(timeoutRequest, { threadId: threadA });

    await expect(pending).resolves.toBe(false);
    expect(state.answers).toEqual([
      { type: "extension_ui_response", id: "timeout", cancelled: true, timedOut: true },
    ]);
    await waitFor(() => expect(screen.queryByTestId("body-timeout")).toBeNull());
  });

  test("thread switch cancels the old presentation without answering it", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const pending = open(controller, request("confirm", "old-thread"), threadA);
    await screen.findByTestId("body-old-thread");

    controller.switchThread(threadB);
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "confirm",
      timedOut: false,
    });
    expect(state.answers).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId("body-old-thread")).toBeNull());
  });
  test("rejects a stale answer with a typed conflict after external cancellation", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const pending = open(controller, request("confirm", "stale"), threadA);
    await screen.findByTestId("body-stale");
    const answer = state.answer as (response: DialogResponse) => Promise<void>;

    controller.cancel("stale" as UiRequestId);
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "confirm",
      timedOut: false,
    });
    await expect(answer({ kind: "confirm", confirmed: true })).rejects.toMatchObject({
      appError: { code: "conflict" },
    });
  });

  test("dispose settles an active request and clears its timer without answering", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const pending = open(controller, request("confirm", "dispose", 10_000));
    await screen.findByTestId("body-dispose");

    controller.dispose();
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "confirm",
      timedOut: false,
    });
    expect(state.answers).toEqual([]);
    await waitFor(() => expect(screen.queryByTestId("body-dispose")).toBeNull());
  });

  test("rejects when omp.ui is unavailable instead of faking a dialog", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const unavailable = new DialogHostController({
      overlay: state.overlay as OverlayHostApi,
      capabilities: {},
      answerExtensionUi: async () => {},
      render: () => null,
    });

    await expect(unavailable.open(request(), { threadId: threadA })).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "omp.ui" },
    });
    unavailable.dispose();
    controller.dispose();
  });

  test("reads capabilities when a request arrives, so a replaced map takes effect without a new host", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    let current: CapabilityMap = {};
    const lazy = new DialogHostController({
      overlay: state.overlay as OverlayHostApi,
      capabilities: () => current,
      answerExtensionUi: async () => {},
      render: () => <p>Question</p>,
    });

    await expect(lazy.open(request(), { threadId: threadA })).rejects.toMatchObject({
      appError: { code: "unavailable", capability: "omp.ui" },
    });
    // The map is replaced (a reconnect reloads it); the same host now presents omp's questions.
    current = ompUiCapabilities;
    const shown = open(lazy, request("confirm", "later"));
    await screen.findByText("Question");
    lazy.dispose();
    await expect(shown).resolves.toMatchObject({ outcome: "cancelled" });
    controller.dispose();
  });
});

describe("DialogHostController ownership", () => {
  test("an app dialog for a chat the host is not showing is refused, not left waiting", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    open(controller, request("confirm", "shown"), threadA);
    const refused = open(controller, request("confirm", "app-elsewhere"), threadB, {
      origin: "app",
    }).then(
      () => "resolved",
      (error: unknown) => error,
    );
    const outcome = await Promise.race([
      refused,
      new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50)),
    ]);
    expect(outcome).toMatchObject({ appError: { code: "unavailable" } });
  });

  test("a request whose signal is already aborted arms no timeout", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      void open(controller, request("confirm", "app-aborted", 10_000), threadA, {
        origin: "app",
        signal: AbortSignal.abort(),
      });
      expect(timers.mock.calls.filter(([, delay]) => delay === 10_000)).toHaveLength(0);
    } finally {
      timers.mockRestore();
    }
  });
});

describe("DialogHostController outside press", () => {
  function dimmedArea(): HTMLElement {
    const element = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
    if (!element) throw new Error("expected the dimmed backdrop to be on the screen");
    return element;
  }

  test("a press outside leaves omp's question open, and Escape still cancels it", async () => {
    const state = renderHarness();
    const controller = await controllerFrom(state);
    const pending = open(controller, request("select", "omp-question"));
    const question = await screen.findByRole("dialog", { name: "omp-question" });
    fireEvent.pointerDown(dimmedArea());
    fireEvent.pointerUp(dimmedArea());
    expect(screen.getByRole("dialog", { name: "omp-question" })).toBeTruthy();
    expect(state.answers).toEqual([]);
    fireEvent.keyDown(question, { key: "Escape" });
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "select",
      timedOut: false,
    });
    expect(state.answers).toEqual([
      { type: "extension_ui_response", id: "omp-question", cancelled: true },
    ]);
  });

  test("a press outside still closes an app dialog, which settles as cancelled", async () => {
    const state = renderHarness({});
    const controller = await controllerFrom(state);
    const cancelled = controller.confirm(
      request("confirm", "app-outside") as Extract<DialogRequest, { kind: "confirm" }>,
      { threadId: threadA, origin: "app" },
    );
    await screen.findByRole("dialog", { name: "app-outside" });
    fireEvent.pointerDown(dimmedArea());
    fireEvent.pointerUp(dimmedArea());
    await expect(cancelled).resolves.toBe(false);
    expect(state.answers).toEqual([]);
  });
});
