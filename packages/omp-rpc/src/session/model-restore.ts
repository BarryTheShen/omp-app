import { AppFailure } from "@omp-app/contracts";

/**
 * omp 18.6.3 and later refuse a chat whose saved model cannot be restored, instead of carrying on with another
 * model. The refusal names the model, `Could not restore model <provider/id>`: on stderr when omp exits at start-up,
 * and in the reply to `open_session` or `switch_session`.
 */
/** A model id is letters, digits and `._:@/-`: a refusal names the model with no quote, bracket or space around it. */
const REFUSAL = /Could not restore model ([\w.:@/-]+)/g;

/**
 * The saved model (`provider/modelId`) that omp could not restore, or undefined when the text is not that refusal.
 * Bun prints the source line that threw above omp's error line, and that line quotes the message as a template, so
 * the last match is the one omp reports.
 */
export function savedModelFromOmpText(text: string): string | undefined {
  let named: string | undefined;
  for (const match of text.matchAll(REFUSAL)) {
    const model = match[1]?.replace(/\.+$/, "");
    if (model) named = model;
  }
  return named;
}

/** The plain-words failure for a chat whose saved model is gone. It names the model and the next step. */
export function modelUnavailableFailure(model: string): AppFailure {
  return new AppFailure({
    code: "model_unavailable",
    message: `This chat used ${model}, which is not available any more. Pick another model to open it.`,
    retryable: false,
  });
}
