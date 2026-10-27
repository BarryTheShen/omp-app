import type { UiRequestId } from "@omp-app/contracts";
import { CapabilityKey } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  ASK_DIALOG_CAPABILITY,
  AskDialogRequestSchema,
  approvalChoices,
  ConfirmDialogRequestSchema,
  DIALOG_CAPABILITY,
  DialogRequestSchema,
  EditorDialogRequestSchema,
  InputDialogRequestSchema,
  SelectDialogRequestSchema,
  toDialogRequest,
} from "./dialog";

const id = "req-1" as UiRequestId;

/** omp's approval prompt with both grants and a session answer, as omp's `tools/approval.ts` builds it. */
const PROMPT = {
  full: "Allow write to src/a.ts?",
  compact: "Allow write?",
  session: "Approve write for this session",
  grants: [
    { scope: "folder", label: "Allow this folder", alwaysLabel: "Always allow this folder" },
    { scope: "target", label: "Allow this file", alwaysLabel: "Always allow this file" },
  ],
} as const;

describe("capability constants", () => {
  test("name the two capabilities the dialog grammar gates on", () => {
    expect(CapabilityKey.safeParse(DIALOG_CAPABILITY).success).toBe(true);
    expect(CapabilityKey.safeParse(ASK_DIALOG_CAPABILITY).success).toBe(true);
    expect(DIALOG_CAPABILITY).toBe("omp.ui");
    expect(ASK_DIALOG_CAPABILITY).toBe("omp.cmd.set_ask_dialog");
  });
});

describe("approvalChoices", () => {
  test("lists omp's choices in omp's order, each with the answer omp takes for it", () => {
    expect(approvalChoices(PROMPT)).toEqual([
      { label: "Allow this folder", answer: { grant: "folder", always: false } },
      { label: "Allow this file", answer: { grant: "target", always: false } },
      { label: "Always allow this folder", answer: { grant: "folder", always: true } },
      { label: "Always allow this file", answer: { grant: "target", always: true } },
      { label: "Approve Once", answer: "once" },
      { label: "Approve write for this session", answer: "session" },
      { label: "Deny", answer: "deny" },
    ]);
  });

  test("without grants or a session answer, this call is plain Approve, beside Deny", () => {
    expect(approvalChoices({ full: "Run ls?", compact: "ls" })).toEqual([
      { label: "Approve", answer: "once" },
      { label: "Deny", answer: "deny" },
    ]);
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

  test("accepts a read-only flag and rejects a non-boolean one", () => {
    expect(
      EditorDialogRequestSchema.safeParse({ kind: "editor", id, title: "Copy", readOnly: true })
        .success,
    ).toBe(true);
    expect(
      EditorDialogRequestSchema.safeParse({ kind: "editor", id, title: "Copy", readOnly: "yes" })
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
  test("discriminates all six modal kinds and rejects an unknown kind", () => {
    for (const candidate of [
      { kind: "select", id, title: "T", options: ["A"] },
      { kind: "confirm", id, title: "T", message: "M" },
      { kind: "input", id, title: "T" },
      { kind: "editor", id, title: "T" },
      { kind: "ask", id, questions: [{ id: "q", question: "Q", options: [{ label: "A" }] }] },
      { kind: "approve", id, title: "T", choices: [{ label: "Deny", answer: "deny" }] },
    ]) {
      expect(DialogRequestSchema.safeParse(candidate).success).toBe(true);
    }
    expect(DialogRequestSchema.safeParse({ kind: "notify", id, message: "hi" }).success).toBe(
      false,
    );
    expect(
      DialogRequestSchema.safeParse({
        kind: "approve",
        id,
        title: "T",
        choices: [{ label: "Allow", answer: "Approve Once" }],
      }).success,
    ).toBe(false);
  });
});

describe("toDialogRequest", () => {
  test("converts each of the host's dialogs, branding id and keeping omp's field values", () => {
    expect(
      toDialogRequest({
        id: "host-1",
        method: "ui.select",
        params: { title: "Pick", options: ["A", "B"], timeout: 2_000 },
      }),
    ).toEqual({
      kind: "select",
      id: "host-1",
      title: "Pick",
      options: ["A", "B"],
      optionDetails: undefined,
      timeoutMs: 2_000,
    });
    expect(
      toDialogRequest({
        id: "host-2",
        method: "ui.confirm",
        params: { title: "Continue?", message: "Sure?" },
      }),
    ).toEqual({
      kind: "confirm",
      id: "host-2",
      title: "Continue?",
      message: "Sure?",
      timeoutMs: undefined,
    });
    expect(
      toDialogRequest({
        id: "host-3",
        method: "ui.input",
        params: { title: "Name", placeholder: "Jane" },
      }),
    ).toEqual({
      kind: "input",
      id: "host-3",
      title: "Name",
      placeholder: "Jane",
      timeoutMs: undefined,
    });
    expect(
      toDialogRequest({
        id: "host-4",
        method: "ui.editor",
        params: { title: "Edit", prefill: "hello", promptStyle: true },
      }),
    ).toEqual({
      kind: "editor",
      id: "host-4",
      title: "Edit",
      prefill: "hello",
      promptStyle: true,
    });
    expect(
      toDialogRequest({
        id: "host-5",
        method: "ui.ask",
        params: {
          questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }] }],
          timeout: 10_000,
        },
      }),
    ).toEqual({
      kind: "ask",
      id: "host-5",
      questions: [{ id: "q1", question: "Which?", options: [{ label: "A" }] }],
      timeoutMs: 10_000,
    });
  });

  test("an approval becomes a dialog of its own, with omp's prompt and its typed choices", () => {
    const approval = toDialogRequest({
      id: "host-6",
      method: "ui.approve",
      params: { prompt: PROMPT, timeout: 60_000 },
    });
    expect(approval).toEqual({
      kind: "approve",
      id: "host-6",
      title: PROMPT.full,
      choices: approvalChoices(PROMPT),
      timeoutMs: 60_000,
    });
    expect(DialogRequestSchema.safeParse(approval).success).toBe(true);
  });
});
