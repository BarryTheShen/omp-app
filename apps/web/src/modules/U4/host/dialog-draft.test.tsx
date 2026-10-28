import type { CapabilityMap, ThreadId, UiRequestId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useRef } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { OverlayHost, useOverlayHost } from "@/overlay";
import type { DialogRequest } from "../contract";
import type { DialogHostOpenOptions } from "../contract/dialog-host";
import { toHostDialogAnswer } from "../contract/responses";
import { renderDialogRequest } from "../dialogs/renderer";
import { DialogHostController } from "./dialog-host";

afterEach(cleanup);

const threadA = "thread-a" as ThreadId;
const threadB = "thread-b" as ThreadId;
const ompUi: CapabilityMap = { "omp.ui": { state: "available", via: "omp" } };
const appOptions: DialogHostOpenOptions = { threadId: threadA, origin: "app" };

function editor(id: string, title: string, prefill?: string): DialogRequest {
  return { kind: "editor", id: id as UiRequestId, title, prefill };
}

function input(id: string, title: string): DialogRequest {
  return { kind: "input", id: id as UiRequestId, title };
}

/** A host with the real dialog renderers and the real overlay, and the answers it sends to omp. */
function renderHost() {
  const answers: { readonly id: string; readonly answer: unknown }[] = [];
  let made: DialogHostController | undefined;
  function Probe() {
    const overlay = useOverlayHost();
    const ref = useRef<DialogHostController | null>(null);
    if (ref.current === null) {
      ref.current = new DialogHostController({
        overlay,
        capabilities: ompUi,
        answerDialog: async (id, answer) => {
          answers.push({ id, answer });
        },
        render: renderDialogRequest,
      });
    }
    made = ref.current;
    useEffect(() => () => ref.current?.dispose(), []);
    return null;
  }
  render(
    <OverlayHost>
      <Probe />
    </OverlayHost>,
  );
  if (made === undefined) throw new Error("The dialog host did not start.");
  return { controller: made, answers };
}

/** The dimmed backdrop behind an open dialog: a press here is a press outside it. */
function dimmedArea(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[data-slot="dialog-overlay"]');
  if (!element) throw new Error("expected the dimmed backdrop to be on the screen");
  return element;
}

describe("a cancelled editor hands back the text it held", () => {
  test("Cancel returns the text as the person left it", async () => {
    const { controller } = renderHost();
    const pending = controller.open(editor("app-cancel-editor", "Goal text", "Start"), appOptions);
    fireEvent.change(await screen.findByRole("textbox", { name: "Goal text" }), {
      target: { value: "Start, then the person's edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "editor",
      timedOut: false,
      draft: "Start, then the person's edit",
    });
  });

  test("Escape returns the text as the person left it", async () => {
    const { controller } = renderHost();
    const pending = controller.open(editor("app-escape-editor", "Goal text", "Start"), appOptions);
    fireEvent.change(await screen.findByRole("textbox", { name: "Goal text" }), {
      target: { value: "Typed, then Escape" },
    });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Goal text" }), { key: "Escape" });
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "editor",
      timedOut: false,
      draft: "Typed, then Escape",
    });
  });

  test("a press outside an app dialog returns the text as the person left it", async () => {
    const { controller } = renderHost();
    const pending = controller.open(editor("app-outside-editor", "Goal text", "Start"), appOptions);
    fireEvent.change(await screen.findByRole("textbox", { name: "Goal text" }), {
      target: { value: "Typed, then a press outside" },
    });
    fireEvent.pointerDown(dimmedArea());
    fireEvent.pointerUp(dimmedArea());
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "editor",
      timedOut: false,
      draft: "Typed, then a press outside",
    });
  });

  test("an editor that was never typed in hands back its prefill", async () => {
    const { controller } = renderHost();
    const pending = controller.open(editor("app-prefill-editor", "Goal text", "Start"), appOptions);
    await screen.findByRole("textbox", { name: "Goal text" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "editor",
      timedOut: false,
      draft: "Start",
    });
  });
});

describe("a cancelled input hands back the text it held", () => {
  test("Cancel returns the typed text", async () => {
    const { controller } = renderHost();
    const pending = controller.open(input("app-cancel-input", "Token budget"), appOptions);
    fireEvent.change(await screen.findByRole("textbox", { name: "Token budget" }), {
      target: { value: "50" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "input",
      timedOut: false,
      draft: "50",
    });
  });

  test("Escape returns the typed text", async () => {
    const { controller } = renderHost();
    const pending = controller.open(input("app-escape-input", "Token budget"), appOptions);
    fireEvent.change(await screen.findByRole("textbox", { name: "Token budget" }), {
      target: { value: "12k" },
    });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Token budget" }), { key: "Escape" });
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "input",
      timedOut: false,
      draft: "12k",
    });
  });

  test("a press outside returns the typed text", async () => {
    const { controller } = renderHost();
    const pending = controller.open(input("app-outside-input", "Token budget"), appOptions);
    fireEvent.change(await screen.findByRole("textbox", { name: "Token budget" }), {
      target: { value: "7" },
    });
    fireEvent.pointerDown(dimmedArea());
    fireEvent.pointerUp(dimmedArea());
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "input",
      timedOut: false,
      draft: "7",
    });
  });
});

describe("the host closing a dialog with text in it keeps that text", () => {
  test("dispose hands back the text of an open editor", async () => {
    const { controller } = renderHost();
    const pending = controller.open(editor("app-dispose-editor", "Goal text", "Start"), appOptions);
    fireEvent.change(await screen.findByRole("textbox", { name: "Goal text" }), {
      target: { value: "Typed before dispose" },
    });
    controller.dispose();
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "editor",
      timedOut: false,
      draft: "Typed before dispose",
    });
  });

  test("switching chats hands back the text of the other chat's open input", async () => {
    const { controller } = renderHost();
    const pending = controller.open(input("app-switch-input", "Token budget"), appOptions);
    fireEvent.change(await screen.findByRole("textbox", { name: "Token budget" }), {
      target: { value: "900" },
    });
    controller.switchThread(threadB);
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "input",
      timedOut: false,
      draft: "900",
    });
  });
});

describe("the text never reaches omp, and other kinds carry no text", () => {
  test("an omp question cancelled from its editor tells omp only that it was cancelled", async () => {
    const { controller, answers } = renderHost();
    const pending = controller.open(editor("omp-wire-editor", "Commit message", "Fix"), {
      threadId: threadA,
    });
    fireEvent.change(await screen.findByRole("textbox", { name: "Commit message" }), {
      target: { value: "Fix the parser" },
    });
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Commit message" }), { key: "Escape" });
    await expect(pending).resolves.toEqual({
      outcome: "cancelled",
      kind: "editor",
      timedOut: false,
      draft: "Fix the parser",
    });
    expect(answers).toEqual([{ id: "omp-wire-editor", answer: { cancelled: true } }]);
  });

  test("a cancelled confirmation has no draft field at all", async () => {
    const { controller } = renderHost();
    const pending = controller.open(
      {
        kind: "confirm",
        id: "app-confirm-no-draft" as UiRequestId,
        title: "Create this goal?",
        message: "Confirm creates the goal.",
      },
      appOptions,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    const result = await pending;
    expect(result).toEqual({ outcome: "cancelled", kind: "confirm", timedOut: false });
    expect("draft" in result).toBe(false);
  });

  test("the host's answer for a cancelled editor never carries its draft", () => {
    const result = {
      outcome: "cancelled" as const,
      kind: "editor" as const,
      timedOut: false,
      draft: "Typed text",
    };
    expect(toHostDialogAnswer(result)).toEqual({ cancelled: true });
  });
});
