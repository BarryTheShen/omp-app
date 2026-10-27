import {
  AppFailure,
  type CapabilityMap,
  CapabilityStatus,
  type ChatSessionEvent,
  type ChatSessionRequest,
  ThreadId,
} from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../store/store";
import { createOmpRuntime } from "./runtime";

const threadId = ThreadId.parse("thread-stop-restore");
const restoring: CapabilityMap = {
  "omp.cmd.abort": CapabilityStatus.parse({ state: "available", via: "rpc" }),
  "omp.cmd.abort_and_restore_queue": CapabilityStatus.parse({ state: "available", via: "rpc" }),
};

function queuedStore(): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId });
  const event = {
    type: "queue_update",
    steering: ["steer first"],
    followUp: ["follow second"],
  };
  store.ingest({ kind: "event", event } as unknown as ChatSessionEvent, 1);
  return store;
}

describe("Stop with queued input on the plain-abort paths", () => {
  test("without the restoring command in the capabilities, Stop sends plain abort and hands nothing back", async () => {
    const commands: unknown[] = [];
    const handedBack: unknown[] = [];
    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      return undefined as never;
    };
    const controller = createOmpRuntime({
      store: queuedStore(),
      send,
      capabilities: { "omp.cmd.abort": CapabilityStatus.parse({ state: "available", via: "rpc" }) },
      onQueueRestored: (stopped) => handedBack.push(stopped),
    });
    await controller.cancel();
    expect(commands).toEqual([{ method: "abort", params: {} }]);
    expect(handedBack).toEqual([]);
  });

  test("when omp rejects the restoring command, Stop reports the failure, sends no plain abort, and keeps the queue", async () => {
    const commands: unknown[] = [];
    const handedBack: unknown[] = [];
    const send: ChatSessionRequest = async ({ method, params }) => {
      commands.push({ method, params });
      throw new AppFailure({
        code: "omp_error",
        message: "omp refused the command",
        retryable: false,
      });
    };
    const controller = createOmpRuntime({
      store: queuedStore(),
      send,
      capabilities: restoring,
      onQueueRestored: (stopped) => handedBack.push(stopped),
    });
    await expect(controller.cancel()).rejects.toThrow(AppFailure);
    expect(commands).toEqual([{ method: "abort_and_restore_queue", params: {} }]);
    expect(handedBack).toEqual([]);
  });
});
