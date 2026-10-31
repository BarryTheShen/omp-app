/**
 * Which device each open connection belongs to: the devices port says which device is asking, and a removed device's
 * open pages are disconnected at once.
 */
export type CloseConnection = (code: number, reason: string) => void;

export class DeviceConnections {
  readonly #connections = new Map<
    string,
    { readonly deviceId: string; readonly close: CloseConnection }
  >();

  add(connectionId: string, deviceId: string, close: CloseConnection): void {
    this.#connections.set(connectionId, { deviceId, close });
  }

  remove(connectionId: string): void {
    this.#connections.delete(connectionId);
  }

  /** The device of a connection; null for one opened with the launch link. */
  deviceOf(connectionId: string): string | null {
    return this.#connections.get(connectionId)?.deviceId ?? null;
  }

  /** Closes every connection of a device, as a refused sign-in closes one; returns how many. */
  closeDevice(deviceId: string): number {
    let closed = 0;
    for (const [connectionId, connection] of [...this.#connections]) {
      if (connection.deviceId !== deviceId) continue;
      this.#connections.delete(connectionId);
      connection.close(4401, "not paired");
      closed += 1;
    }
    return closed;
  }
}
