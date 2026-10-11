import type { AppError } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import {
  credentialFailureFromError,
  credentialFailureFromMessage,
  credentialFailureFromStatusError,
  latestErroredAnswer,
} from "./credential";

const RAW = "401 Invalid API key\nInvalid API key (type=INVALID_API_KEY)";

/** An answer omp ended with an error, as omp writes it in the session file. */
function refusedAnswer(overrides: Record<string, unknown> = {}): unknown {
  return {
    role: "assistant",
    stopReason: "error",
    errorMessage: RAW,
    errorStatus: 401,
    provider: "openai",
    model: "gpt-6-luna",
    ...overrides,
  };
}

describe("credentialFailureFromMessage", () => {
  test("a refused key (401 or 403) on an answer that ended with an error is a credential failure", () => {
    expect(credentialFailureFromMessage(refusedAnswer())).toEqual({
      httpStatus: 401,
      provider: "openai",
      model: "gpt-6-luna",
      text: RAW,
    });
    expect(credentialFailureFromMessage(refusedAnswer({ errorStatus: 403 }))?.httpStatus).toBe(403);
  });

  test("other statuses, answers that did not error, and answers omp retried are not credential failures", () => {
    expect(credentialFailureFromMessage(refusedAnswer({ errorStatus: 404 }))).toBeNull();
    expect(credentialFailureFromMessage(refusedAnswer({ errorStatus: undefined }))).toBeNull();
    expect(credentialFailureFromMessage(refusedAnswer({ stopReason: "stop" }))).toBeNull();
    expect(credentialFailureFromMessage(refusedAnswer({ role: "user" }))).toBeNull();
    expect(
      credentialFailureFromMessage(refusedAnswer({ retryRecovery: { status: "recovered" } })),
    ).toBeNull();
    expect(credentialFailureFromMessage(null)).toBeNull();
  });

  test("a missing provider or model is left out, not invented", () => {
    const failure = credentialFailureFromMessage(
      refusedAnswer({ provider: undefined, model: "   " }),
    );
    expect(failure?.provider).toBeUndefined();
    expect(failure?.model).toBeUndefined();
    expect(failure?.httpStatus).toBe(401);
  });
});

describe("credentialFailureFromError", () => {
  function promptError(omp: AppError["omp"]): AppError {
    return { code: "omp_error", message: RAW, retryable: false, omp };
  }

  test("a failed prompt that carries a 401 or 403 is a credential failure, named by provider and model", () => {
    expect(
      credentialFailureFromError(
        promptError({ error: RAW, provider: "openai", model: "gpt-6-luna", httpStatus: 401 }),
      ),
    ).toEqual({ httpStatus: 401, provider: "openai", model: "gpt-6-luna", text: RAW });
  });

  test("no error, a failure without a status, and another status are not credential failures", () => {
    expect(credentialFailureFromError(null)).toBeNull();
    expect(credentialFailureFromError(promptError({ error: RAW }))).toBeNull();
    expect(credentialFailureFromError(promptError({ error: RAW, httpStatus: 500 }))).toBeNull();
  });
});

describe("credentialFailureFromStatusError", () => {
  test("reads back the failure the message status carries, and nothing else", () => {
    const status = { text: RAW, httpStatus: 403, provider: "openai" };
    expect(credentialFailureFromStatusError(status)).toEqual({
      httpStatus: 403,
      provider: "openai",
      model: undefined,
      text: RAW,
    });
    expect(credentialFailureFromStatusError(RAW)).toBeNull();
    expect(credentialFailureFromStatusError({ text: RAW, httpStatus: 404 })).toBeNull();
    expect(credentialFailureFromStatusError(undefined)).toBeNull();
  });
});

describe("latestErroredAnswer", () => {
  test("the most recent answer omp ended with an error, whatever came after it", () => {
    const failed = refusedAnswer({ errorStatus: 400, errorMessage: "400 bad request" });
    const later = { role: "assistant", stopReason: "stop" };
    expect(latestErroredAnswer([{ role: "user" }, failed, later, { role: "user" }])).toBe(failed);
  });

  test("none when no answer ended with an error", () => {
    expect(latestErroredAnswer([])).toBeUndefined();
    expect(
      latestErroredAnswer([{ role: "user" }, { role: "assistant", stopReason: "stop" }]),
    ).toBeUndefined();
  });
});
