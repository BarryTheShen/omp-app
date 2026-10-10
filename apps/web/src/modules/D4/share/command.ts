import { AppFailure } from "@omp-app/contracts";
import type { ShareController } from "./controller";
import { describeShareOutcome } from "./outcome";

/**
 * Typed `/share` runs the same flow as the palette command: the question first, then the upload. A failure is thrown
 * as the AppFailure it carries, so the composer shows omp's own words.
 */
export async function runShareCommand(
  controller: ShareController,
): Promise<{ readonly message: string }> {
  const outcome = await controller.share();
  if (outcome.outcome === "failed") throw new AppFailure(outcome.error);
  return { message: describeShareOutcome(outcome) };
}
