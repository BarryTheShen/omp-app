import { AppFailure } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentRef, FocusedAgentRuntime } from "@/modules/P1/contract";
import { CANCEL_REFUSED_MESSAGE } from "@/modules/P1/panels/model";
import { NestedWorkerControls } from "../nested-controls";
import { agentRef, transcriptPage } from "./fixtures";

afterEach(() => cleanup());

const CANCEL_NAME = "Cancel Probe the transcript";
const WORKER = "Probe the transcript";
const MESSAGE_BOX = `Message to ${WORKER}`;
const SEND_BUTTON = `Send message to ${WORKER}`;

function runtimeFor(
  agent: AgentRef,
  cancel: FocusedAgentRuntime["cancel"],
  steer: FocusedAgentRuntime["steer"] = async () => {},
): FocusedAgentRuntime {
  return {
    agent,
    read: async () => transcriptPage({ fromByte: 0, nextByte: 0 }),
    subscribe: () => () => undefined,
    cancel,
    steer,
  };
}

describe("the controls under a nested worker's transcript", () => {
  test("a running worker has a Cancel button named for it, and a message box that is on", () => {
    render(
      <NestedWorkerControls runtime={runtimeFor(agentRef(), async () => ({ cancelled: true }))} />,
    );
    expect(screen.getByRole("button", { name: CANCEL_NAME })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: MESSAGE_BOX }).hasAttribute("disabled")).toBe(false);
  });

  test("a message typed under a running worker reaches the worker through its runtime", async () => {
    const steer = vi.fn(async () => {});
    render(
      <NestedWorkerControls
        runtime={runtimeFor(agentRef(), async () => ({ cancelled: true }), steer)}
      />,
    );
    const box = screen.getByRole("textbox", { name: MESSAGE_BOX });
    fireEvent.change(box, { target: { value: "Drop the glob." } });
    fireEvent.keyDown(box, { key: "Enter" });
    await act(async () => {});
    expect(steer).toHaveBeenCalledWith("Drop the glob.");
  });

  test("pressing Cancel shows Cancelling…, then the sent notice once omp accepts it", async () => {
    const { promise, resolve } = Promise.withResolvers<{ cancelled: boolean }>();
    render(<NestedWorkerControls runtime={runtimeFor(agentRef(), () => promise)} />);
    fireEvent.click(screen.getByRole("button", { name: CANCEL_NAME }));
    expect(screen.getByRole("button", { name: "Cancelling…" }).hasAttribute("disabled")).toBe(true);
    await act(async () => resolve({ cancelled: true }));
    expect(screen.getByText("Cancel sent. Waiting for the worker to stop.")).toBeTruthy();
  });

  test("a refused cancel keeps the worker's Cancel button and says omp could not stop it now", async () => {
    const refused = new AppFailure({
      code: "conflict",
      message: "omp did not stop the worker",
      retryable: true,
    });
    render(
      <NestedWorkerControls runtime={runtimeFor(agentRef(), () => Promise.reject(refused))} />,
    );
    fireEvent.click(screen.getByRole("button", { name: CANCEL_NAME }));
    expect(await screen.findByText(CANCEL_REFUSED_MESSAGE)).toBeTruthy();
    expect(screen.getByRole("button", { name: CANCEL_NAME })).toBeTruthy();
  });

  test("a finished worker has no Cancel button, and its message box is off", () => {
    render(
      <NestedWorkerControls
        runtime={runtimeFor(agentRef({ status: "completed" }), async () => ({ cancelled: true }))}
      />,
    );
    expect(screen.queryByRole("button", { name: /^Cancel / })).toBeNull();
    expect(screen.getByRole("textbox", { name: MESSAGE_BOX }).hasAttribute("disabled")).toBe(true);
  });

  test("the message box and its Send button are named for their worker, as its Cancel button is", () => {
    render(
      <>
        <NestedWorkerControls runtime={runtimeFor(agentRef(), async () => ({ cancelled: true }))} />
        <NestedWorkerControls
          runtime={runtimeFor(
            agentRef({ id: "worker-2", description: "Read the diff" }),
            async () => ({ cancelled: true }),
          )}
        />
      </>,
    );
    expect(screen.getByRole("textbox", { name: MESSAGE_BOX })).toBeTruthy();
    expect(screen.getByRole("button", { name: SEND_BUTTON })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Message to Read the diff" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send message to Read the diff" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });

  test("Escape with nothing typed in the box reaches the view around it, so the view can leave", () => {
    const viewKeyDown = vi.fn();
    document.addEventListener("keydown", viewKeyDown);
    try {
      render(
        <NestedWorkerControls
          runtime={runtimeFor(agentRef(), async () => ({ cancelled: true }))}
        />,
      );
      fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
      expect(viewKeyDown).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", viewKeyDown);
    }
  });

  test("Escape with text in the box clears it, and the view around it does not see the key", () => {
    const viewKeyDown = vi.fn();
    document.addEventListener("keydown", viewKeyDown);
    try {
      render(
        <NestedWorkerControls
          runtime={runtimeFor(agentRef(), async () => ({ cancelled: true }))}
        />,
      );
      const box = screen.getByRole("textbox");
      fireEvent.change(box, { target: { value: "half a thought" } });
      fireEvent.keyDown(box, { key: "Escape" });
      expect((box as HTMLTextAreaElement).value).toBe("");
      expect(viewKeyDown).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", viewKeyDown);
    }
  });
});
