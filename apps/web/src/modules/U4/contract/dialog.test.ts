import type { OmpWire, UiRequestId } from "@omp-app/contracts";
import { AppFailure, CapabilityKey } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  ASK_DIALOG_CAPABILITY,
  AskDialogRequestSchema,
  ConfirmDialogRequestSchema,
  classifyExtensionUiMethod,
  DIALOG_CAPABILITY,
  DialogRequestSchema,
  EditorDialogRequestSchema,
  InputDialogRequestSchema,
  SelectDialogRequestSchema,
  toDialogRequest,
} from "./dialog";

const id = "req-1" as UiRequestId;

describe("capability constants", () => {
  test("name the two capabilities the dialog grammar gates on", () => {
    expect(CapabilityKey.safeParse(DIALOG_CAPABILITY).success).toBe(true);
    expect(CapabilityKey.safeParse(ASK_DIALOG_CAPABILITY).success).toBe(true);
    expect(DIALOG_CAPABILITY).toBe("omp.ui");
    expect(ASK_DIALOG_CAPABILITY).toBe("omp.cmd.set_ask_dialog");
  });
});

describe("classifyExtensionUiMethod", () => {
  test("buckets every wire method into modal, presentation or cancel", () => {
    expect(classifyExtensionUiMethod("select")).toBe("modal");
    expect(classifyExtensionUiMethod("confirm")).toBe("modal");
    expect(classifyExtensionUiMethod("input")).toBe("modal");
    expect(classifyExtensionUiMethod("editor")).toBe("modal");
    expect(classifyExtensionUiMethod("ask")).toBe("modal");
    expect(classifyExtensionUiMethod("cancel")).toBe("cancel");
    expect(classifyExtensionUiMethod("notify")).toBe("presentation");
    expect(classifyExtensionUiMethod("setStatus")).toBe("presentation");
    expect(classifyExtensionUiMethod("setWidget")).toBe("presentation");
    expect(classifyExtensionUiMethod("setTitle")).toBe("presentation");
    expect(classifyExtensionUiMethod("set_editor_text")).toBe("presentation");
    expect(classifyExtensionUiMethod("open_url")).toBe("presentation");
  });
});

describe("SelectDialogRequestSchema", () => {
  test("accepts a representative select request", () => {
    const parsed = SelectDialogRequestSchema.safeParse({
      kind: "select",
      id,
      title: "Pick one",
      options: ["Alpha", "Beta"],
      optionDetails: [{ description: "first" }, {}],
      timeoutMs: 30_000,
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects an empty options list, an empty id, and an unknown field", () => {
    expect(
      SelectDialogRequestSchema.safeParse({ kind: "select", id, title: "Pick", options: [] })
        .success,
    ).toBe(false);
    expect(
      SelectDialogRequestSchema.safeParse({ kind: "select", id: "", title: "Pick", options: ["A"] })
        .success,
    ).toBe(false);
    expect(
      SelectDialogRequestSchema.safeParse({
        kind: "select",
        id,
        title: "Pick",
        options: ["A"],
        extra: true,
      }).success,
    ).toBe(false);
  });
});

describe("ConfirmDialogRequestSchema", () => {
  test("accepts a representative confirm request and rejects a missing message", () => {
    expect(
      ConfirmDialogRequestSchema.safeParse({
        kind: "confirm",
        id,
        title: "Continue?",
        message: "Sure?",
      }).success,
    ).toBe(true);
    expect(
      ConfirmDialogRequestSchema.safeParse({ kind: "confirm", id, title: "Continue?" }).success,
    ).toBe(false);
  });
});

describe("InputDialogRequestSchema", () => {
  test("accepts with and without a placeholder, rejects a negative timeout", () => {
    expect(InputDialogRequestSchema.safeParse({ kind: "input", id, title: "Name" }).success).toBe(
      true,
    );
    expect(
      InputDialogRequestSchema.safeParse({
        kind: "input",
        id,
        title: "Name",
        placeholder: "Jane",
        timeoutMs: 5_000,
      }).success,
    ).toBe(true);
    expect(
      InputDialogRequestSchema.safeParse({ kind: "input", id, title: "Name", timeoutMs: -1 })
        .success,
    ).toBe(false);
  });
});

describe("EditorDialogRequestSchema", () => {
  test("accepts an empty prefill (a blank editor) and rejects a non-boolean promptStyle", () => {
    expect(
      EditorDialogRequestSchema.safeParse({ kind: "editor", id, title: "Edit", prefill: "" })
        .success,
    ).toBe(true);
    expect(
      EditorDialogRequestSchema.safeParse({ kind: "editor", id, title: "Edit", promptStyle: "yes" })
        .success,
    ).toBe(false);
  });
});

describe("AskDialogRequestSchema", () => {
  const question = {
    id: "q1",
    question: "Which?",
    options: [{ label: "A" }, { label: "B", description: "second" }],
    recommended: 1,
  };

  test("accepts a representative ask request", () => {
    expect(
      AskDialogRequestSchema.safeParse({
        kind: "ask",
        id,
        questions: [question],
        timeoutMs: 10_000,
      }).success,
    ).toBe(true);
  });

  test("rejects a question with zero options and a non-integer recommended index", () => {
    expect(
      AskDialogRequestSchema.safeParse({
        kind: "ask",
        id,
        questions: [{ ...question, options: [] }],
      }).success,
    ).toBe(false);
    expect(
      AskDialogRequestSchema.safeParse({
        kind: "ask",
        id,
        questions: [{ ...question, recommended: 1.5 }],
      }).success,
    ).toBe(false);
  });
});

describe("DialogRequestSchema", () => {
  test("discriminates all five modal kinds and rejects an unknown kind", () => {
    for (const candidate of [
      { kind: "select", id, title: "T", options: ["A"] },
      { kind: "confirm", id, title: "T", message: "M" },
      { kind: "input", id, title: "T" },
      { kind: "editor", id, title: "T" },
      { kind: "ask", id, questions: [{ id: "q", question: "Q", options: [{ label: "A" }] }] },
    ]) {
      expect(DialogRequestSchema.safeParse(candidate).success).toBe(true);
    }
    expect(DialogRequestSchema.safeParse({ kind: "notify", id, message: "hi" }).success).toBe(
      false,
    );
  });
});

describe("toDialogRequest", () => {
  test("converts each modal wire request, branding id and keeping field names exact", () => {
    const select = toDialogRequest({
      type: "extension_ui_request",
      id: "wire-1",
      method: "select",
      title: "Pick",
      options: ["A", "B"],
      timeout: 2_000,
    } satisfies OmpWire.ExtensionUiRequest);
    expect(select).toEqual({
      kind: "select",
      id: "wire-1",
      title: "Pick",
      options: ["A", "B"],
      optionDetails: undefined,
      timeoutMs: 2_000,
    });

    const confirm = toDialogRequest({
      type: "extension_ui_request",
      id: "wire-2",
      method: "confirm",
      title: "Continue?",
      message: "Sure?",
    } satisfies OmpWire.ExtensionUiRequest);
    expect(confirm).toEqual({
      kind: "confirm",
      id: "wire-2",
      title: "Continue?",
      message: "Sure?",
      timeoutMs: undefined,
    });

    const input = toDialogRequest({
      type: "extension_ui_request",
      id: "wire-3",
      method: "input",
      title: "Name",
      placeholder: "Jane",
    } satisfies OmpWire.ExtensionUiRequest);
    expect(input).toEqual({
      kind: "input",
      id: "wire-3",
      title: "Name",
      placeholder: "Jane",
      timeoutMs: undefined,
    });

    const editor = toDialogRequest({
      type: "extension_ui_request",
      id: "wire-4",
      method: "editor",
      title: "Edit",
      prefill: "hello",
      promptStyle: true,
    } satisfies OmpWire.ExtensionUiRequest);
    expect(editor).toEqual({
      kind: "editor",
      id: "wire-4",
      title: "Edit",
      prefill: "hello",
      promptStyle: true,
    });

    const ask = toDialogRequest({
      type: "extension_ui_request",
      id: "wire-5",
      method: "ask",
      questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }] }],
      timeout: 10_000,
    } satisfies OmpWire.ExtensionUiRequest);
    expect(ask).toEqual({
      kind: "ask",
      id: "wire-5",
      questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }] }],
      timeoutMs: 10_000,
    });
  });

  test("throws AppFailure(internal) for a non-modal method", () => {
    expect(() =>
      toDialogRequest({
        type: "extension_ui_request",
        id: "wire-6",
        method: "notify",
        message: "hi",
      } satisfies OmpWire.ExtensionUiRequest),
    ).toThrow(AppFailure);
    try {
      toDialogRequest({
        type: "extension_ui_request",
        id: "wire-7",
        method: "cancel",
        targetId: "wire-1",
      } satisfies OmpWire.ExtensionUiRequest);
      throw new Error("expected toDialogRequest to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppFailure);
      expect((error as AppFailure).appError.code).toBe("internal");
    }
  });
});
