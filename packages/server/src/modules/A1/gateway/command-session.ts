/**
 * What the command gateway needs of one chat (SDK plan H5.3e): omp's command list, a prompt with its admission and its
 * outcome, and the chat's command events. A0 gives it from the chat host (`ChatSessionPortRuntime.commandSessionFor`)
 * or, until H5.6 removes omp's RPC, from an `RpcSession` (`rpcCommandSession`).
 */
import type {
  AbortSignalLike,
  CommandModelUpdate,
  ConfigInfoUpdate,
  OmpWire,
  RpcSessionEvent,
} from "@omp-app/contracts";
import type { CommandFuture, RpcSession } from "@omp-app/omp-rpc";

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

/** Gives a prompt's outcome its admission, as `CommandFuture` has it. */
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

/** omp's RPC session as a command session, until H5.6 removes the RPC path. */
export function rpcCommandSession(session: RpcSession): CommandSession {
  return {
    async availableCommands(signal) {
      return (await session.send({ type: "get_available_commands" }, { signal })).commands;
    },

    prompt(text, signal) {
      let result: OmpWire.PromptResultEvent | undefined;
      const unsubscribe = session.onEvent((event: RpcSessionEvent) => {
        if (event.kind === "prompt_result") result = event.event;
      });
      let future: CommandFuture<OmpWire.PromptAck, OmpWire.PromptAck>;
      try {
        future = session.send({ type: "prompt", message: text }, { signal });
      } catch (cause) {
        unsubscribe();
        throw cause;
      }
      // omp answers an admitted prompt (and a local command such as an idle `/fresh`) with `{ success: true }` and no
      // `data`, so the acknowledgement can be `undefined`: the prompt reached the agent unless omp says otherwise.
      const admitted = future.admitted.then((ack: OmpWire.PromptAck | undefined) => ({
        agentInvoked: ack?.agentInvoked ?? true,
      }));
      const outcome = future
        .then((ack: OmpWire.PromptAck | undefined): CommandPromptOutcome => {
          const agentInvoked = ack?.agentInvoked ?? true;
          return {
            agentInvoked,
            status: result?.status === "aborted" ? "aborted" : "completed",
            promptSettled: agentInvoked ? (result?.sessionSettled ?? false) : true,
          };
        })
        .finally(unsubscribe);
      return withAdmission(outcome, admitted);
    },

    onEvent(listener) {
      return session.onEvent((event: RpcSessionEvent) => {
        if (event.kind === "session_settled") {
          listener({ type: "session_settled" });
          return;
        }
        if (event.kind !== "notification") return;
        const { frame } = event;
        if (frame.type === "command_output") {
          listener({ type: "command_output", text: frame.text });
        } else if (frame.type === "session_info_update") {
          listener({
            type: "session_info_update",
            sessionId: frame.sessionId,
            ...(frame.title === undefined ? {} : { title: frame.title }),
          });
        } else if (frame.type === "config_update") {
          listener({
            type: "config_update",
            ...(frame.model === undefined ? {} : { model: frame.model }),
            ...(frame.thinkingLevel === undefined ? {} : { thinkingLevel: frame.thinkingLevel }),
          });
        }
      });
    },
  };
}
