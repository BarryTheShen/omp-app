import {
  type AccessActivity,
  type AccessMachine,
  AppFailure,
  DeviceAccessPort,
  type StreamKey,
  streamKey,
} from "@omp-app/contracts";
import type { DeviceAccess } from "../../devices/access/routes";
import type { Logger } from "../../logging";
import type { PortRegistration } from "../../registry/ports";

export interface DeviceAccessPortContext {
  readonly access: DeviceAccess;
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  readonly logger?: Logger;
}

const notFound = (): AppFailure =>
  new AppFailure({ code: "not_found", message: "That machine is not enrolled.", retryable: false });

/** The keys pages hear the machines and their activity on. */
export const DEVICE_ACCESS_CHANGED = streamKey(DeviceAccessPort.name, "changed");
export const DEVICE_ACCESS_ACTIVITY = streamKey(DeviceAccessPort.name, "activity");

/** Publishes what the hub hears to every paired page. */
export function deviceAccessPublishers(publish: DeviceAccessPortContext["publish"]): {
  readonly machinesChanged: (machines: AccessMachine[]) => void;
  readonly activity: (activity: AccessActivity) => void;
} {
  return {
    machinesChanged: (machines) => publish(DEVICE_ACCESS_CHANGED, { machines }),
    activity: (activity) => publish(DEVICE_ACCESS_ACTIVITY, activity),
  };
}

/**
 * Agent access for the pages (#20): the machines, what ran on them, turning one off, forgetting one. Nothing here turns
 * a machine on: that happens only on the machine.
 */
export function createDeviceAccessPortRegistration(
  context: DeviceAccessPortContext,
): PortRegistration {
  const { access } = context;
  return {
    port: DeviceAccessPort,
    context,
    handlers: {
      list: () => ({ machines: access.hub.machines() }),
      history: async (args: unknown) => {
        const { machineId, before, limit } = args as {
          machineId: string;
          before?: number;
          limit?: number;
        };
        if (access.store.byId(machineId) === undefined) throw notFound();
        return { activity: await access.activity.history(machineId, before, limit) };
      },
      off: (args: unknown) => {
        const { machineId } = args as { machineId: string };
        if (access.store.byId(machineId) === undefined) throw notFound();
        const sent = access.hub.off(machineId);
        context.logger?.info("device_access.off_asked", { sent });
        return { sent };
      },
      remove: async (args: unknown) => {
        const { machineId } = args as { machineId: string };
        if (!(await access.store.remove(machineId))) throw notFound();
        return { machines: access.hub.machines() };
      },
    },
  };
}
