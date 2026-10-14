import type { AppClient } from "@omp-app/client";
import type { CapabilityMap, FolderPath, ThreadId } from "@omp-app/contracts";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  StatusBarController,
  type StatusBarSnapshot,
  type StatusRoster,
  type StatusRuntime,
} from "./controller";

export interface StatusBarInputs {
  readonly client: Pick<AppClient, "port">;
  readonly runtime: StatusRuntime;
  readonly threadId: ThreadId;
  readonly folder: FolderPath | null;
  readonly capabilities: CapabilityMap;
  readonly roster: StatusRoster | null;
  /** Must be stable for the life of the page: the controller is built once per chat. */
  readonly reportFailure: (error: unknown) => void;
}

/**
 * The bar's segments for one open chat. The controller lives as long as the chat's client, runtime store
 * and thread. The folder, the capabilities and the roster reach it through setters, so a change to any of
 * them never rebuilds it or cancels a read for an unrelated reason.
 */
export function useStatusBar(inputs: StatusBarInputs): StatusBarSnapshot {
  const { client, runtime, threadId, reportFailure, folder, capabilities, roster } = inputs;
  const controller = useMemo(
    () => new StatusBarController({ client, runtime, threadId, reportFailure }),
    [client, runtime, threadId, reportFailure],
  );
  useEffect(() => {
    controller.start();
    return () => {
      controller.stop();
    };
  }, [controller]);
  useEffect(() => {
    controller.setFolder(folder);
  }, [controller, folder]);
  useEffect(() => {
    controller.setCapabilities(capabilities);
  }, [controller, capabilities]);
  useEffect(() => {
    controller.setRoster(roster);
  }, [controller, roster]);
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
}
