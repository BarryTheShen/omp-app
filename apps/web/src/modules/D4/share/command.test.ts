import { AppFailure } from "@omp-app/contracts";
import { describe, expect, test, vi } from "vitest";
import { runShareCommand } from "./command";
import type { ShareController, ShareOutcome } from "./controller";

const LINK = { url: "https://my.omp.sh/s/abc1234567#key", truncated: false };

function controllerReturning(outcome: ShareOutcome): ShareController {
  return { share: vi.fn(async () => outcome) };
}

describe("typed /share", () => {
  test("a copied link reports one plain sentence for the status line", async () => {
    await expect(
      runShareCommand(controllerReturning({ outcome: "copied", result: LINK })),
    ).resolves.toEqual({ message: "Share link copied. Anyone with the link can read this chat." });
  });

  test("a question answered no reports that nothing was shared", async () => {
    await expect(runShareCommand(controllerReturning({ outcome: "not-shared" }))).resolves.toEqual({
      message: "Nothing was shared.",
    });
  });

  test("a failed share is thrown as the AppFailure it carries, with omp's own words", async () => {
    const error = {
      code: "unavailable",
      message: "omp could not share this chat. Try again in a moment.",
      retryable: true,
    } as const;
    const thrown = await runShareCommand(controllerReturning({ outcome: "failed", error })).catch(
      (reason: unknown) => reason,
    );
    expect(thrown).toBeInstanceOf(AppFailure);
    expect(thrown).toMatchObject({ appError: error });
  });

  test("the command asks the controller once, and runs no other path", async () => {
    const controller = controllerReturning({ outcome: "not-shared" });
    await runShareCommand(controller);
    expect(controller.share).toHaveBeenCalledTimes(1);
  });
});
