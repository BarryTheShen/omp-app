/**
 * Device pairing on the server: the paired devices (`store.ts`), pairing in progress (`pairing.ts`), which device each
 * connection is (`connections.ts`), the key's cookie (`cookie.ts`) and the `/pair/*` routes (`http.ts`).
 */
import type { Logger } from "../logging";
import { DeviceConnections } from "./connections";
import { PairingDesk, type PairingDeskOptions } from "./pairing";
import { DeviceStore } from "./store";

export interface DevicePairing {
  readonly store: DeviceStore;
  readonly desk: PairingDesk;
  readonly connections: DeviceConnections;
}

export interface DevicePairingOptions extends Omit<PairingDeskOptions, "framedBefore"> {
  readonly appDataDir: string;
  readonly logger?: Logger;
}

/** The server's pairing state, with the paired devices read from the app data folder. */
export async function openDevicePairing(options: DevicePairingOptions): Promise<DevicePairing> {
  const store = await DeviceStore.open({
    appDataDir: options.appDataDir,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  // A request from a panel says whether a device paired from the same app before: the store knows.
  const desk = new PairingDesk({
    ...options,
    framedBefore: (framedBy) => store.namedFramedBy(framedBy),
  });
  const connections = new DeviceConnections();
  // A removed device's open pages are disconnected at once.
  store.onRemoved((deviceId) => connections.closeDevice(deviceId));
  return { store, desk, connections };
}

export { DeviceConnections } from "./connections";
export { deviceCookie, deviceKeyOf, deviceKeyOfProtocols, offeredProtocols } from "./cookie";
export { pairingRoute } from "./http";
export { createMachineNames, type MachineNamer, tailscaleWhois } from "./machine";
export { PairingDesk } from "./pairing";
export { DeviceStore, deviceKeyHash } from "./store";
