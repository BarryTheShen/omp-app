/**
 * What the command gateway needs of one chat (SDK plan H5.3e): omp's command list, a prompt with its admission and its
 * outcome, and the chat's command events. A0 gives it from the chat host (`ChatSessionPortRuntime.commandSessionFor`).
 */
import type { AbortSignalLike, CommandModelUpdate, ConfigInfoUpdate } from "@omp-app/contracts";

export interface CommandSession {
  /** omp's slash commands for the chat, by name and alias. */
  availableCommands(signal?: AbortSignalLike): Promise<readonly CommandListing[]>;
  /**
   * Sends a prompt: `admitted` resolves once omp has taken it in, and the future settles with its outcome. An aborted
   * signal gives up the wait, not omp's run.
   */
  prompt(text: string, signal?: AbortSignalLike): CommandPromptFuture;
  /** The chat's command events, until the returned function is called. */
  onEvent(listener: (event: CommandSessionEvent) => void): () => void;
}

export interface CommandListing {
  readonly name: string;
  readonly aliases?: readonly string[];
}

export interface CommandPromptOutcome {
  /** False when omp handled the prompt without the model: a built-in command, or an extension's command. */
  readonly agentInvoked: boolean;
  readonly status: "completed" | "aborted";
  /** Whether the session was done when the prompt's result was written; true when the model never ran. */
  readonly promptSettled: boolean;
}

export interface CommandPromptFuture extends Promise<CommandPromptOutcome> {
  readonly admitted: Promise<{ readonly agentInvoked: boolean }>;
}

/**
 * A chat's command events as plain data: what a built-in command printed, a title or configuration it changed, and the
 * end of a stretch of activity. The gateway reads them into its typed results.
 */
export type CommandSessionEvent =
  | { readonly type: "command_output"; readonly text: string }
  | { readonly type: "session_info_update"; readonly sessionId: string; readonly title?: string }
  | {
      readonly type: "config_update";
      /** omp's whole model: the gateway keeps only its safe fields. */
      readonly model?: CommandModelUpdate;
      readonly thinkingLevel?: ConfigInfoUpdate["thinkingLevel"];
    }
  | { readonly type: "session_settled" };

/** Gives a prompt's outcome its admission (`CommandPromptFuture`). */
export function withAdmission(
  outcome: Promise<CommandPromptOutcome>,
  admitted: Promise<{ readonly agentInvoked: boolean }>,
): CommandPromptFuture {
  // A caller that never reads the admission must not see its rejection as unhandled.
  void admitted.catch(() => undefined);
  Object.defineProperty(outcome, "admitted", {
    configurable: false,
    enumerable: false,
    value: admitted,
  });
  return outcome as CommandPromptFuture;
}
