import { CheckpointChanged, CheckpointStore } from "@omp-app/contracts";
import type { PortRegistration } from "../../../registry/ports";
import type { A1PortContext } from "./context";
import { assertNotAborted, createA1PortRegistration } from "./helper";

export function createCheckpointStoreRegistration(context: A1PortContext): PortRegistration {
  const bindings = [
    {
      event: "changed",
      subscribe: (listener: (payload: unknown) => void) =>
        context.checkpointStore.onChanged((record, kind, workspace) =>
          listener(CheckpointChanged.parse({ workspace, snapshotId: record.snapshotId, kind })),
        ),
      scope: (payload: unknown) => CheckpointChanged.parse(payload).workspace,
    },
  ];
  return createA1PortRegistration(
    CheckpointStore,
    {
      snapshot: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.checkpointStore.snapshot(args);
      },
      list: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.checkpointStore.list(args);
      },
      diff: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.checkpointStore.diff(args);
      },
      planRestore: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.checkpointStore.planRestore(args);
      },
      restore: async (args, handlerContext) => {
        assertNotAborted(handlerContext);
        return context.checkpointStore.restore(args);
      },
    },
    context.publish,
    bindings,
    context.watchStreamActivity,
  );
}
