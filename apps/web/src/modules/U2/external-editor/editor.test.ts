import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { EXTERNAL_EDITOR_CAPABILITY, ExternalEditorController } from "./editor";

describe("U2.5 ExternalEditorController", () => {
  test("is visibly unavailable without an injected host adapter", async () => {
    const controller = new ExternalEditorController({});
    expect(controller.availability()).toMatchObject({ available: false });
    await expect(controller.open("draft")).rejects.toMatchObject({
      appError: { code: "unavailable", capability: EXTERNAL_EDITOR_CAPABILITY },
    });
  });

  test("round-trips host editor text and preserves typed failures", async () => {
    const controller = new ExternalEditorController({
      adapter: { open: async ({ initialText }) => `${initialText} edited` },
      capabilities: { [EXTERNAL_EDITOR_CAPABILITY]: { state: "available", via: "host" } },
    });
    await expect(controller.open("draft")).resolves.toBe("draft edited");
    const failure = new AppFailure({
      code: "cancelled",
      message: "Editor cancelled",
      retryable: false,
    });
    const cancelled = new ExternalEditorController({
      adapter: {
        open: async () => {
          throw failure;
        },
      },
    });
    await expect(cancelled.open("draft")).rejects.toBe(failure);
  });
});
