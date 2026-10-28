import {
  AppFailure,
  type CapabilityMap,
  type ChatSessionRequest,
  type ThreadId,
} from "@omp-app/contracts";
import { useCallback, useMemo } from "react";
import type { SlashAppCommand } from "@/modules/D2/slash";
import type { GoalArgs, GoalResult } from "@/modules/D8/contract";
import { createAutonomyPort, type GoalRuntimeStore } from "@/modules/D8/goal/runtime";
import { reportClientError } from "./client-errors";
import { goalSlashCommand } from "./slash-commands";

const CHANGE_FAILED = "The goal could not be changed. Try again.";

export interface GoalCommandOptions {
  readonly capabilities: CapabilityMap;
  /** The chat session port's requests. */
  readonly request: ChatSessionRequest;
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

/** Waits for the selected chat's process to be ready before a goal request runs. */
function waitForGoalProcess(store: GoalRuntimeStore): Promise<void> {
  const status = store.getSnapshot().process.status;
  if (status === "ready" || status === "running") return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const check = (): void => {
      const current = store.getSnapshot().process.status;
      if (current === "ready" || current === "running") {
        unsubscribe();
        resolve();
      } else if (current === "stopped" || current === "exited" || current === "error") {
        unsubscribe();
        reject(
          new AppFailure({
            code: "unavailable",
            message:
              "omp stopped before the goal command could run. The text is still in the message box.",
            retryable: true,
          }),
        );
      }
    };
    unsubscribe = store.subscribe(check);
    check();
  });
}

/**
 * omp's goal on the chat host, for the typed `/goal` and the palette's goal commands. The D8 autonomy port sends each
 * request for the chat on screen only. A chat whose omp has no `goal` command is refused before anything is sent.
 */
export function useGoalCommands({
  capabilities,
  request,
  store,
  threadId,
  notify,
  fail,
}: GoalCommandOptions): GoalCommands {
  const autonomy = useMemo(() => createAutonomyPort({ request, store }), [request, store]);
  const sendGoal = useCallback(
    async (args: GoalArgs): Promise<GoalResult> => {
      if (capabilities["omp.cmd.goal"]?.state !== "available") {
        throw new AppFailure({
          code: "unavailable",
          message: "Goals are unavailable in this omp session.",
          retryable: false,
        });
      }
      const status = store.getSnapshot().process.status;
      const waiting = status !== "ready" && status !== "running";
      if (waiting) notify("Waiting for the chat to start…");
      try {
        await waitForGoalProcess(store);
        try {
          return await autonomy.goal(threadId, args);
        } catch (error) {
          if (error instanceof AppFailure) throw error;
          reportClientError({
            kind: "error",
            message: `The goal request failed: ${error instanceof Error ? error.message : "unknown error"}`,
          });
          throw new AppFailure({ code: "internal", message: CHANGE_FAILED, retryable: true });
        }
      } finally {
        if (waiting) notify(null);
      }
    },
    [autonomy, capabilities, notify, store, threadId],
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
