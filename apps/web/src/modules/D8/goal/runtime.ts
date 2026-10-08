import type { OmpCommandMap, PortCallOptions, SendCommandArgs, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { OmpRuntimeStore } from "../../R0/store";
import type { AutonomyPort } from "../contract";
import { GoalRpcResultSchema, GoalUpdatedEventSchema } from "../contract";

export type GoalRpcSender = (
  args: SendCommandArgs<"goal">,
  options?: PortCallOptions,
) => Promise<OmpCommandMap["goal"]["result"]>;
export type GoalRuntimeStore = Pick<
  OmpRuntimeStore,
  "getSnapshot" | "subscribe" | "subscribeNotifications"
>;

function requireCurrentThread(store: GoalRuntimeStore, threadId: ThreadId): void {
  if (store.getSnapshot().threadId !== threadId) {
    throw new AppFailure({
      code: "conflict",
      message: "The selected conversation changed before the goal request could run.",
      retryable: true,
    });
  }
}

/** Connects the released goal command to A0 and forwards R0's already-ordered goal updates. */
export function createAutonomyPort(options: {
  readonly rpc: GoalRpcSender;
  readonly store: GoalRuntimeStore;
}): AutonomyPort {
  return {
    async goal(threadId, args, callOptions) {
      requireCurrentThread(options.store, threadId);
      const result = await options.rpc(
        { threadId, command: { type: "goal", ...args } },
        callOptions,
      );
      return GoalRpcResultSchema.parse(result);
    },
    subscribeGoal(threadId, listener) {
      if (options.store.getSnapshot().threadId !== threadId) return () => {};
      return options.store.subscribeNotifications(["goal_updated"], (frame) => {
        const event = GoalUpdatedEventSchema.safeParse(frame);
        listener(event.success ? event.data : null);
      });
    },
  };
}
