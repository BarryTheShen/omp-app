import type { UiRequestId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import { HOST_METHOD_ANSWERS } from "@omp-app/contracts/chat-host";
import { describe, expect, test } from "vitest";
import type { AskDialogRequest, AskQuestion, ConfirmDialogRequest } from "./dialog";
import {
  AskAnswerValueSchema,
  DialogResponseSchema,
  DialogResultSchema,
  defaultAskAnswers,
  defaultDialogResult,
  resolveConfirm,
  toHostDialogAnswer,
  validateAskAnswers,
} from "./responses";

const id = "req-1" as UiRequestId;

describe("DialogResponseSchema", () => {
  test("accepts a representative value for each of the five kinds", () => {
    expect(DialogResponseSchema.safeParse({ kind: "select", value: "Alpha" }).success).toBe(true);
    expect(DialogResponseSchema.safeParse({ kind: "confirm", confirmed: false }).success).toBe(
      true,
    );
    expect(DialogResponseSchema.safeParse({ kind: "input", value: "" }).success).toBe(true);
    expect(DialogResponseSchema.safeParse({ kind: "editor", value: "text" }).success).toBe(true);
    expect(
      DialogResponseSchema.safeParse({
        kind: "ask",
        answers: [{ id: "q1", selectedOptions: ["A"] }],
      }).success,
    ).toBe(true);
  });

  test("rejects an empty select value and an empty ask answers array", () => {
    expect(DialogResponseSchema.safeParse({ kind: "select", value: "" }).success).toBe(false);
    expect(DialogResponseSchema.safeParse({ kind: "ask", answers: [] }).success).toBe(false);
  });
});

describe("AskAnswerValueSchema", () => {
  test("accepts an option answer, a custom-text-only answer, and an empty selection the request may allow", () => {
    expect(AskAnswerValueSchema.safeParse({ id: "q1", selectedOptions: ["A"] }).success).toBe(true);
    expect(
      AskAnswerValueSchema.safeParse({ id: "q1", selectedOptions: [], customInput: "free text" })
        .success,
    ).toBe(true);
    expect(AskAnswerValueSchema.safeParse({ id: "q1", selectedOptions: [] }).success).toBe(true);
  });

  test("rejects a duplicate selected option and a non-trimmed customInput", () => {
    expect(AskAnswerValueSchema.safeParse({ id: "q1", selectedOptions: ["A", "A"] }).success).toBe(
      false,
    );
    expect(
      AskAnswerValueSchema.safeParse({ id: "q1", selectedOptions: ["A"], customInput: " padded " })
        .success,
    ).toBe(false);
  });
});

describe("DialogResultSchema", () => {
  test("accepts an answered and a cancelled result, rejects an unknown cancelled kind", () => {
    expect(
      DialogResultSchema.safeParse({
        outcome: "answered",
        response: { kind: "confirm", confirmed: true },
      }).success,
    ).toBe(true);
    expect(
      DialogResultSchema.safeParse({ outcome: "cancelled", kind: "select", timedOut: true })
        .success,
    ).toBe(true);
    expect(
      DialogResultSchema.safeParse({ outcome: "cancelled", kind: "notify", timedOut: false })
        .success,
    ).toBe(false);
  });
});

describe("resolveConfirm", () => {
  test("resolves true only for an explicit confirmed answer", () => {
    expect(
      resolveConfirm({ outcome: "answered", response: { kind: "confirm", confirmed: true } }),
    ).toBe(true);
  });

  test("resolves false for an explicit No, a cancellation, and a timeout (deny is always the default)", () => {
    expect(
      resolveConfirm({ outcome: "answered", response: { kind: "confirm", confirmed: false } }),
    ).toBe(false);
    expect(resolveConfirm({ outcome: "cancelled", kind: "confirm", timedOut: false })).toBe(false);
    expect(resolveConfirm({ outcome: "cancelled", kind: "confirm", timedOut: true })).toBe(false);
  });
});

describe("defaultDialogResult", () => {
  const select: Parameters<typeof defaultDialogResult>[0] = {
    kind: "select",
    id,
    title: "Pick",
    options: ["A", "B"],
  };
  const confirm: ConfirmDialogRequest = {
    kind: "confirm",
    id,
    title: "Continue?",
    message: "Sure?",
  };
  const ask: AskDialogRequest = {
    kind: "ask",
    id,
    questions: [
      { id: "q1", question: "Which?", options: [{ label: "A" }, { label: "B" }], recommended: 1 },
      { id: "q2", question: "Other?", options: [{ label: "X" }] },
    ],
  };

  test("select/input/editor/confirm have no value on cancellation or timeout", () => {
    expect(defaultDialogResult(select, { timedOut: false })).toEqual({
      outcome: "cancelled",
      kind: "select",
      timedOut: false,
    });
    expect(defaultDialogResult(select, { timedOut: true })).toEqual({
      outcome: "cancelled",
      kind: "select",
      timedOut: true,
    });
    expect(defaultDialogResult(confirm, { timedOut: false })).toEqual({
      outcome: "cancelled",
      kind: "confirm",
      timedOut: false,
    });
    expect(defaultDialogResult(confirm, { timedOut: true })).toEqual({
      outcome: "cancelled",
      kind: "confirm",
      timedOut: true,
    });
  });

  test("ask has no value on an explicit cancel, but answers recommended-or-first only on a timeout", () => {
    expect(defaultDialogResult(ask, { timedOut: false })).toEqual({
      outcome: "cancelled",
      kind: "ask",
      timedOut: false,
    });
    expect(defaultDialogResult(ask, { timedOut: true })).toEqual({
      outcome: "answered",
      response: {
        kind: "ask",
        answers: [
          { id: "q1", selectedOptions: ["B"] },
          { id: "q2", selectedOptions: ["X"] },
        ],
      },
    });
  });
});

describe("defaultAskAnswers", () => {
  test("picks the recommended option, or the first when no recommendation is given", () => {
    const questions: AskQuestion[] = [
      { id: "q1", question: "Q1", options: [{ label: "A" }, { label: "B" }], recommended: 1 },
      { id: "q2", question: "Q2", options: [{ label: "X" }, { label: "Y" }] },
    ];
    expect(defaultAskAnswers(questions)).toEqual([
      { id: "q1", selectedOptions: ["B"] },
      { id: "q2", selectedOptions: ["X"] },
    ]);
  });

  test("throws AppFailure(internal) when a question's options is empty, the one case the schema already forbids", () => {
    const malformed = [{ id: "q1", question: "Q1", options: [] }] as unknown as AskQuestion[];
    expect(() => defaultAskAnswers(malformed)).toThrow(AppFailure);
    try {
      defaultAskAnswers(malformed);
      throw new Error("expected defaultAskAnswers to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppFailure);
      expect((error as AppFailure).appError.code).toBe("internal");
    }
  });
});

describe("validateAskAnswers", () => {
  const request: AskDialogRequest = {
    kind: "ask",
    id,
    questions: [
      { id: "q1", question: "Single?", options: [{ label: "A" }, { label: "B" }] },
      { id: "q2", question: "Multi?", options: [{ label: "X" }, { label: "Y" }], multi: true },
    ],
  };

  test("accepts answers that match question order, ids and option labels", () => {
    expect(
      validateAskAnswers(request, [
        { id: "q1", selectedOptions: ["A"] },
        { id: "q2", selectedOptions: ["X", "Y"] },
      ]),
    ).toEqual({ ok: true });
  });

  test("rejects a length mismatch, an id out of order, and an unknown option label", () => {
    expect(validateAskAnswers(request, [{ id: "q1", selectedOptions: ["A"] }]).ok).toBe(false);
    expect(
      validateAskAnswers(request, [
        { id: "q2", selectedOptions: ["X"] },
        { id: "q1", selectedOptions: ["A"] },
      ]).ok,
    ).toBe(false);
    expect(
      validateAskAnswers(request, [
        { id: "q1", selectedOptions: ["Z"] },
        { id: "q2", selectedOptions: [] },
      ]).ok,
    ).toBe(false);
  });

  test("rejects a single-select question answered with two options, or an option combined with custom text", () => {
    expect(
      validateAskAnswers(request, [
        { id: "q1", selectedOptions: ["A", "B"] },
        { id: "q2", selectedOptions: [] },
      ]).ok,
    ).toBe(false);
    expect(
      validateAskAnswers(request, [
        { id: "q1", selectedOptions: ["A"], customInput: "note" },
        { id: "q2", selectedOptions: [] },
      ]).ok,
    ).toBe(false);
  });

  test("a single-select question needs an answer, and a checkbox question may be answered with none", () => {
    expect(
      validateAskAnswers(request, [
        { id: "q1", selectedOptions: [] },
        { id: "q2", selectedOptions: [] },
      ]).ok,
    ).toBe(false);
    expect(
      validateAskAnswers(request, [
        { id: "q1", selectedOptions: ["A"] },
        { id: "q2", selectedOptions: [] },
      ]),
    ).toEqual({ ok: true });
  });

  test("allows a multi-select question to combine options with custom text", () => {
    expect(
      validateAskAnswers(request, [
        { id: "q1", selectedOptions: ["A"] },
        { id: "q2", selectedOptions: ["X"], customInput: "plus a note" },
      ]),
    ).toEqual({ ok: true });
  });
});

describe("toHostDialogAnswer", () => {
  test("builds the host's answer for each answered kind, one the host takes for its dialog", () => {
    const value = toHostDialogAnswer({
      outcome: "answered",
      response: { kind: "select", value: "A" },
    });
    expect(value).toEqual({ value: "A" });
    expect(HOST_METHOD_ANSWERS["ui.select"].safeParse(value).success).toBe(true);
    const confirmed = toHostDialogAnswer({
      outcome: "answered",
      response: { kind: "confirm", confirmed: true },
    });
    expect(confirmed).toEqual({ confirmed: true });
    expect(HOST_METHOD_ANSWERS["ui.confirm"].safeParse(confirmed).success).toBe(true);
    const asked = toHostDialogAnswer({
      outcome: "answered",
      response: {
        kind: "ask",
        answers: [
          { id: "q1", selectedOptions: ["A"] },
          { id: "q2", selectedOptions: [], customInput: "mine" },
        ],
      },
    });
    expect(asked).toEqual({
      answers: [
        { id: "q1", selectedOptions: ["A"] },
        { id: "q2", selectedOptions: [], customInput: "mine" },
      ],
    });
    expect(HOST_METHOD_ANSWERS["ui.ask"].safeParse(asked).success).toBe(true);
    const approved = toHostDialogAnswer({
      outcome: "answered",
      response: { kind: "approve", answer: { grant: "folder", always: true } },
    });
    expect(approved).toEqual({ grant: "folder", always: true });
    expect(HOST_METHOD_ANSWERS["ui.approve"].safeParse(approved).success).toBe(true);
  });

  test("a closed dialog is cancelled, timed out when the countdown closed it; a closed approval is denied", () => {
    expect(toHostDialogAnswer({ outcome: "cancelled", kind: "input", timedOut: false })).toEqual({
      cancelled: true,
    });
    expect(toHostDialogAnswer({ outcome: "cancelled", kind: "ask", timedOut: true })).toEqual({
      cancelled: true,
      timedOut: true,
    });
    expect(toHostDialogAnswer({ outcome: "cancelled", kind: "approve", timedOut: true })).toBe(
      "deny",
    );
  });
});
