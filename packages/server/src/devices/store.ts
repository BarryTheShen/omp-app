/**
 * The paired devices (`<app data>/devices.json`, owner-only): each device's name, kind and times, and the SHA-256 of its
 * key, never the key itself. Only this server writes the file. A key is checked in memory, so a connection's sign-in
 * reads no file.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DeviceKind, DeviceName, type PairedDevice } from "@omp-app/contracts";
import { z } from "zod";
import type { Logger } from "../logging";
import { writeFileAtomic } from "../modules/A1/fs/atomic-file";

const FILE_NAME = "devices.json";
/** A device's last connection is saved at most this often: the list shows it in minutes. */
const SEEN_SAVE_MS = 60_000;

const SavedDevice = z.object({
  id: z.string().min(1),
  name: DeviceName,
  kind: DeviceKind,
  keyHash: z.string().regex(/^[0-9a-f]{64}$/),
  pairedAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
type SavedDevice = z.infer<typeof SavedDevice>;

const Saved = z.object({ version: z.literal(1), devices: z.array(SavedDevice) });

/** The SHA-256 of a device key, as the file keeps it. */
export function deviceKeyHash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A new device key: 32 random bytes in base64url. */
export function newDeviceKey(): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

const shown = ({ id, name, kind, pairedAt, lastSeenAt }: SavedDevice): PairedDevice => ({
  id,
  name,
  kind,
  pairedAt,
  lastSeenAt,
});

export interface DeviceStoreOptions {
  readonly appDataDir: string;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

export class DeviceStore {
  readonly filePath: string;
  readonly #devices = new Map<string, SavedDevice>();
  readonly #idByHash = new Map<string, string>();
  readonly #listeners = new Set<() => void>();
  readonly #removedListeners = new Set<(deviceId: string) => void>();
  readonly #now: () => Date;
  readonly #logger: Logger | undefined;
  #writing: Promise<void> = Promise.resolve();

  private constructor(options: DeviceStoreOptions) {
    this.filePath = join(options.appDataDir, FILE_NAME);
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
  }

  /** The store with the devices the file lists; a damaged file is logged and pairs no device (each pairs again). */
  static async open(options: DeviceStoreOptions): Promise<DeviceStore> {
    const store = new DeviceStore(options);
    let text: string;
    try {
      text = await readFile(store.filePath, "utf8");
    } catch (error) {
      if (isMissing(error)) return store;
      throw error;
    }
    let parsed: ReturnType<typeof Saved.safeParse> | undefined;
    try {
      parsed = Saved.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || !parsed.success) {
      store.#logger?.warn("devices.damaged", { path: store.filePath });
      return store;
    }
    for (const device of parsed.data.devices) {
      store.#devices.set(device.id, device);
      store.#idByHash.set(device.keyHash, device.id);
    }
    return store;
  }

  /** The device a key belongs to; undefined for a key no device has (never paired, or removed). */
  deviceForKey(key: string): PairedDevice | undefined {
    const id = this.#idByHash.get(deviceKeyHash(key));
    const device = id === undefined ? undefined : this.#devices.get(id);
    return device === undefined ? undefined : shown(device);
  }

  /** The devices, first paired first. */
  list(): PairedDevice[] {
    return [...this.#devices.values()]
      .sort((a, b) => a.pairedAt.localeCompare(b.pairedAt))
      .map(shown);
  }

  /** Pairs a device: its key is returned once, and only its hash is kept. Rejects when the file cannot be written. */
  async add(name: string, kind: DeviceKind): Promise<{ device: PairedDevice; key: string }> {
    const key = newDeviceKey();
    const device: SavedDevice = {
      id: randomUUID(),
      name: DeviceName.parse(name),
      kind,
      keyHash: deviceKeyHash(key),
      pairedAt: this.#now().toISOString(),
      lastSeenAt: null,
    };
    this.#devices.set(device.id, device);
    this.#idByHash.set(device.keyHash, device.id);
    await this.#save();
    this.#changed();
    return { device: shown(device), key };
  }

  /** False when no device has that id. */
  async rename(deviceId: string, name: string): Promise<boolean> {
    const device = this.#devices.get(deviceId);
    if (device === undefined) return false;
    this.#devices.set(deviceId, { ...device, name: DeviceName.parse(name) });
    await this.#save();
    this.#changed();
    return true;
  }

  /** The device's key stops working at once; false when no device has that id. */
  async remove(deviceId: string): Promise<boolean> {
    const device = this.#devices.get(deviceId);
    if (device === undefined) return false;
    this.#devices.delete(deviceId);
    this.#idByHash.delete(device.keyHash);
    for (const listener of this.#removedListeners) listener(deviceId);
    await this.#save();
    this.#changed();
    return true;
  }

  /** Notes a device's connection; saved when the last saved time is a minute old or more. */
  seen(deviceId: string): void {
    const device = this.#devices.get(deviceId);
    if (device === undefined) return;
    const now = this.#now();
    const last = device.lastSeenAt === null ? 0 : Date.parse(device.lastSeenAt);
    if (now.getTime() - last < SEEN_SAVE_MS) return;
    this.#devices.set(deviceId, { ...device, lastSeenAt: now.toISOString() });
    this.#save().catch(() => undefined);
    this.#changed();
  }

  /** Hears every change to the list; the returned function stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Hears each removal, before the file is saved, so the device's connections close at once. */
  onRemoved(listener: (deviceId: string) => void): () => void {
    this.#removedListeners.add(listener);
    return () => this.#removedListeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  /** Writes the list after the writes before it; a failed write is logged and rejects this save only. */
  #save(): Promise<void> {
    const write = this.#writing.then(() =>
      writeFileAtomic(
        this.filePath,
        `${JSON.stringify({ version: 1, devices: [...this.#devices.values()] }, null, 2)}\n`,
      ).then(() => undefined),
    );
    this.#writing = write.catch((error: unknown) => {
      this.#logger?.warn("devices.save_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return write;
  }
}
