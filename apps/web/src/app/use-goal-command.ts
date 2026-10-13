import { AppFailure, type CapabilityMap, type ThreadId } from "@omp-app/contracts";
import { useCallback, useMemo } from "react";
import type { SlashAppCommand } from "@/modules/D2/slash";
import type { GoalRpcArgs, GoalRpcResult } from "@/modules/D8/contract";
import {
  createAutonomyPort,
  type GoalRpcSender,
  type GoalRuntimeStore,
} from "@/modules/D8/goal/runtime";
import { reportClientError } from "./client-errors";
import { goalSlashCommand } from "./slash-commands";

const CHANGE_FAILED = "The goal could not be changed. Try again.";

export interface GoalCommandOptions {
  readonly capabilities: CapabilityMap;
  readonly rpc: { readonly send: GoalRpcSender };
  readonly store: GoalRuntimeStore;
  readonly threadId: ThreadId;
  /** The header line for what omp now has. */
  readonly notify: (text: string | null) => void;
  /** The header line for a refusal or a failure. */
  readonly fail: (text: string | null) => void;
}

export interface GoalCommands {
  /** The typed `/goal` command, for the chat's slash list. */
  readonly command: SlashAppCommand;
  /** The palette's goal commands: "" shows the goal; "pause", "resume" and "drop" act on it. */
  readonly runFromPalette: (args: string) => void;
}

/**
 * omp's goal over its RPC, for the typed `/goal` and the palette's goal commands. The D8 autonomy port sends each
 * request for the chat on screen only. A chat whose omp has no `goal` command is refused before anything is sent.
 */
export function useGoalCommands({
  capabilities,
  rpc,
  store,
  threadId,
  notify,
  fail,
}: GoalCommandOptions): GoalCommands {
  const autonomy = useMemo(() => createAutonomyPort({ rpc: rpc.send, store }), [rpc.send, store]);
  const sendGoal = useCallback(
    async (args: GoalRpcArgs): Promise<GoalRpcResult> => {
      if (capabilities["omp.cmd.goal"]?.state !== "available") {
        throw new AppFailure({
          code: "unavailable",
          message: "Goals are unavailable in this omp session.",
          retryable: false,
        });
      }
      try {
        return await autonomy.goal(threadId, args);
      } catch (error) {
        if (error instanceof AppFailure) throw error;
        // omp's reply could not be read, or the request failed in the page: the person gets a plain reason, and
        // the debug log keeps the detail.
        reportClientError({
          kind: "error",
          message: `The goal request failed: ${error instanceof Error ? error.message : "unknown error"}`,
        });
        throw new AppFailure({ code: "internal", message: CHANGE_FAILED, retryable: true });
      }
    },
    [autonomy, capabilities, threadId],
  );
  const command = useMemo(() => goalSlashCommand({ sendGoal }), [sendGoal]);
  const runFromPalette = useCallback(
    (args: string) => {
      fail(null);
      notify(null);
      void command.run({ args }).then(
        (outcome) => notify(outcome.message ?? null),
        (error: unknown) =>
          fail(error instanceof AppFailure ? error.appError.message : CHANGE_FAILED),
      );
    },
    [command, fail, notify],
  );
  return { command, runFromPalette };
}
