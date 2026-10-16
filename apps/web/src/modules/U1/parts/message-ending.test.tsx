import type { AppError } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { endingOf, failureShownUnderAnswer, MessageEndingNote } from "./message-ending";

afterEach(() => cleanup());

const assistant = (status: { type: string; reason?: string; error?: unknown }) => ({
  role: "assistant",
  status,
});

describe("endingOf", () => {
  test("a provider error never returns omp's raw words when there is no typed result", () => {
    expect(
      endingOf(assistant({ type: "incomplete", reason: "error", error: "404 not found" })),
    ).toEqual({ kind: "error", text: undefined });
    expect(endingOf(assistant({ type: "incomplete", reason: "error" }))).toEqual({
      kind: "error",
      text: undefined,
    });
  });

  test("uses the provider text and save-failure reason only after the typed result arrives", () => {
    expect(
      endingOf(
        assistant({ type: "incomplete", reason: "error", error: "raw-http-request=/local/path" }),
        {
          message: "400 bad request",
          requestLogSaveFailureReason: "EACCES: permission denied",
        },
      ),
    ).toEqual({
      kind: "error",
      text: "400 bad request",
      details: "The request log could not be saved: EACCES: permission denied",
    });
  });

  test("a stop is an interruption and the length limit is its own ending", () => {
    expect(endingOf(assistant({ type: "incomplete", reason: "cancelled" }))).toEqual({
      kind: "interrupted",
    });
    expect(endingOf(assistant({ type: "incomplete", reason: "length" }))).toEqual({
      kind: "length",
    });
  });

  test("a finished or running answer, another incomplete reason, and a message that is not an answer have none", () => {
    expect(endingOf(assistant({ type: "complete", reason: "stop" }))).toBeUndefined();
    expect(endingOf(assistant({ type: "running" }))).toBeUndefined();
    expect(endingOf(assistant({ type: "incomplete", reason: "other" }))).toBeUndefined();
    expect(
      endingOf({ role: "user", status: { type: "incomplete", reason: "error" } }),
    ).toBeUndefined();
    expect(endingOf({ role: "assistant" })).toBeUndefined();
  });

  test("a refused key remains typed; other text waits for the server result", () => {
    expect(
      endingOf(
        assistant({
          type: "incomplete",
          reason: "error",
          error: {
            text: "401 Invalid API key",
            httpStatus: 401,
            provider: "openai",
            model: "gpt-6-luna",
          },
        }),
      ),
    ).toEqual({
      kind: "credential",
      failure: {
        httpStatus: 401,
        provider: "openai",
        model: "gpt-6-luna",
        text: "401 Invalid API key",
      },
    });
    expect(
      endingOf(assistant({ type: "incomplete", reason: "error", error: "404 not found" })),
    ).toEqual({ kind: "error", text: undefined });
  });
});

describe("MessageEndingNote", () => {
  test("an error says so with its reason, as an alert", () => {
    render(
      <MessageEndingNote ending={{ kind: "error", text: "model: claude-opus-5-5 not found" }} />,
    );
    expect(screen.getByRole("alert").textContent).toContain("The model stopped with an error");
    expect(screen.getByRole("alert").textContent).toContain("model: claude-opus-5-5 not found");
  });

  test("an error with no words still says it stopped", () => {
    render(<MessageEndingNote ending={{ kind: "error", text: undefined }} />);
    expect(screen.getByRole("alert").textContent).toBe("The model stopped with an error");
  });

  test("a long reason is cut, not dumped", () => {
    render(<MessageEndingNote ending={{ kind: "error", text: "x".repeat(2_000) }} />);
    const text = screen.getByRole("alert").textContent ?? "";
    expect(text.length).toBeLessThan(700);
    expect(text.endsWith("…")).toBe(true);
  });

  test("an interruption and the length limit are calm lines, not alerts", () => {
    render(<MessageEndingNote ending={{ kind: "interrupted" }} />);
    expect(screen.getByText("Interrupted")).toBeTruthy();
    cleanup();
    render(<MessageEndingNote ending={{ kind: "length" }} />);
    expect(screen.getByText("Cut off at the length limit")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a refused key is said in plain words, with its way out, and omp's words only under Show details", () => {
    render(
      <MessageEndingNote
        ending={{
          kind: "credential",
          failure: {
            httpStatus: 401,
            provider: "openai",
            model: "gpt-6-luna",
            text: "401 Invalid API key",
          },
        }}
      />,
    );
    expect(screen.getByText("The model could not sign in")).toBeTruthy();
    expect(screen.getByText(/openai did not accept the sign-in/)).toBeTruthy();
    expect(screen.getByText("Show details").closest("details")?.open).toBe(false);
  });
});

describe("failureShownUnderAnswer", () => {
  const promptError = (httpStatus: number | undefined): AppError =>
    ({
      code: "omp_error",
      message: "400 fake provider failure",
      retryable: false,
      omp: httpStatus === undefined ? {} : { httpStatus },
    }) as AppError;
  const erroredAnswer = (errorStatus: number, extra: Record<string, unknown> = {}) => ({
    role: "assistant",
    stopReason: "error",
    errorStatus,
    ...extra,
  });

  test("a provider failure that the answer which stopped already says is not said again", () => {
    expect(failureShownUnderAnswer(promptError(400), erroredAnswer(400))).toBe(true);
  });

  test("another status, another kind of error, a plain answer or no answer keeps the banner's words", () => {
    expect(failureShownUnderAnswer(promptError(400), erroredAnswer(500))).toBe(false);
    expect(
      failureShownUnderAnswer({ ...promptError(400), code: "unavailable" }, erroredAnswer(400)),
    ).toBe(false);
    expect(
      failureShownUnderAnswer(promptError(400), { role: "assistant", stopReason: "stop" }),
    ).toBe(false);
    expect(failureShownUnderAnswer(promptError(400), undefined)).toBe(false);
    expect(failureShownUnderAnswer(promptError(undefined), erroredAnswer(400))).toBe(false);
    expect(failureShownUnderAnswer(null, erroredAnswer(400))).toBe(false);
  });

  test("an answer omp retried into a later answer shows no failure, so the banner keeps its words", () => {
    const retried = erroredAnswer(400, { retryRecovery: { status: "recovered" } });
    expect(failureShownUnderAnswer(promptError(400), retried)).toBe(false);
  });
});
