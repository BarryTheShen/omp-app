import type { CapabilityMap, OmpWire, ThreadId, UiRequestId } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { OverlayHost, type OverlayHostApi, useOverlayHost } from "@/overlay";
import type { DialogHostOpenOptions, DialogRequest, DialogResponse } from "../contract";
import { DialogHostController } from "./dialog-host";

afterEach(cleanup);

const threadA = "thread-a" as ThreadId;
const threadB = "thread-b" as ThreadId;
const capabilities: CapabilityMap = {
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
}

function Harness({ state }: { state: HarnessState }) {
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

function renderHarness() {
  const state: HarnessState = {
    controller: undefined,
    overlay: undefined,
    answers: [],
    answer: undefined,
  };
  render(
    <OverlayHost>
      <Harness state={state} />
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
  extra: Pick<DialogHostOpenOptions, "signal" | "restoreFocus"> = {},
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

    expect(await screen.findByRole("dialog", { name: "confirm" })).toBeTruthy();
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
    expect(restored).toEqual(["restored"]);
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
});
