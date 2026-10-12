import type { AppError } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { emptyStateCopy } from "./empty-state";

const failure: AppError = {
  code: "omp_exited",
  message: "omp stopped before it could open a chat.",
  retryable: true,
};

describe("emptyStateCopy", () => {
  test("while a New chat opens, says omp is starting and does not ask for a folder or a session", () => {
    expect(emptyStateCopy({ opening: true, error: null })).toEqual({
      title: "Opening session…",
      detail: "omp is starting. This can take a few seconds.",
      composer: "Starting a new chat…",
    });
  });

  test("when a chat failed to open, says why in the error's own words", () => {
    expect(emptyStateCopy({ opening: false, error: failure })).toEqual({
      title: "Ready when you are",
      detail: "omp stopped before it could open a chat.",
      composer: null,
    });
  });

  test("a saved chat whose model is gone says so in plain words, without the ready title", () => {
    const modelGone: AppError = {
      code: "model_unavailable",
      message:
        "This chat used fake/gone-model, which is not available any more. Pick another model to open it.",
      retryable: false,
    };
    expect(emptyStateCopy({ opening: false, error: modelGone })).toEqual({
      title: "This chat could not open",
      detail:
        "This chat used fake/gone-model, which is not available any more. Pick another model to open it.",
      composer: null,
    });
  });

  test("with nothing happening, asks for a folder and a session, and leaves the composer's own text", () => {
    expect(emptyStateCopy({ opening: false, error: null })).toEqual({
      title: "Ready when you are",
      detail: "Choose a workspace folder and start a new session.",
      composer: null,
    });
  });

  test("a startup failure with a typed reason says what happened and the next step, in plain words", () => {
    const startupFailure = {
      code: "omp_exited",
      message: "The omp RPC transport closed before ready",
      retryable: true,
    } as const;
    for (const [startup, words] of [
      ["no_model", "omp stopped because no model is set up. Open a terminal, run `omp`"],
      ["no_credentials", "omp stopped because it cannot sign in to a model."],
      ["other", "omp stopped before the chat could start."],
    ] as const) {
      const copy = emptyStateCopy({ opening: false, error: { ...startupFailure, startup } });
      expect(copy.detail).toContain(words);
      expect(copy.detail).not.toMatch(/RPC transport/);
    }
  });
});
