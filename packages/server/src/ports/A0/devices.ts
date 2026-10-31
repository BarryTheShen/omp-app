import {
  AppFailure,
  type DeviceList,
  type DeviceOverview,
  DevicesPort,
  type PairingCode,
  type StreamKey,
  streamKey,
} from "@omp-app/contracts";
import type { DevicePairing } from "../../devices";
import type { Logger } from "../../logging";
import type { PortHandlerContext, PortRegistration } from "../../registry/ports";

export interface DevicesPortContext {
  readonly pairing: DevicePairing;
  /** Publishes an event into the replay hub: every paired page hears the list change. */
  readonly publish: (stream: StreamKey, payload: unknown) => unknown;
  /** What to open on a new device: the Tailscale address, else the loopback one. */
  readonly address: () => string;
  readonly logger?: Logger;
}

const notFound = (message: string): AppFailure =>
  new AppFailure({ code: "not_found", message, retryable: false });

/**
 * Paired devices for the pages of paired devices (and of the launch link): the list with the requests waiting, a name
 * changed, a device removed, a request allowed or turned down, a one-time code. Every change reaches every page as
 * `changed`.
 */
export function createDevicesPortRegistration(context: DevicesPortContext): PortRegistration {
  const { store, desk, connections } = context.pairing;
  const list = (): DeviceList => ({ devices: store.list(), requests: desk.waiting() });
  const overview = (call: PortHandlerContext): DeviceOverview => ({
    ...list(),
    thisDeviceId: connections.deviceOf(call.connectionId),
  });
  const changed = streamKey(DevicesPort.name, "changed");
  const publish = () => context.publish(changed, list());
  store.subscribe(publish);
  desk.subscribe(publish);
  return {
    port: DevicesPort,
    context,
    handlers: {
      list: (_args: unknown, call: PortHandlerContext) => overview(call),
      rename: async (args: unknown, call: PortHandlerContext) => {
        const { deviceId, name } = args as { deviceId: string; name: string };
        if (!(await store.rename(deviceId, name))) throw notFound("That device is not paired.");
        return overview(call);
      },
      remove: async (args: unknown, call: PortHandlerContext) => {
        const { deviceId } = args as { deviceId: string };
        if (!(await store.remove(deviceId))) throw notFound("That device is not paired.");
        context.logger?.info("device.removed", { device: deviceId.slice(0, 8) });
        return overview(call);
      },
      allow: (args: unknown, call: PortHandlerContext) => {
        const { requestId } = args as { requestId: string };
        if (!desk.allow(requestId)) throw notFound("That request has ended.");
        return overview(call);
      },
      deny: (args: unknown, call: PortHandlerContext) => {
        const { requestId } = args as { requestId: string };
        if (!desk.deny(requestId)) throw notFound("That request has ended.");
        return overview(call);
      },
      newCode: (): PairingCode => {
        const made = desk.newCode();
        return {
          code: made.code,
          expiresAt: new Date(made.expiresAt).toISOString(),
          address: context.address(),
        };
      },
    },
  };
}
