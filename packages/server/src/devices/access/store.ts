/**
 * The enrolled machines (`<app data>/device-access/machines.json`, owner-only): each machine's alias, its identity key
 * (it signs the link's challenge and its records) and its sshd host key (the agents' ssh checks it). Only this server
 * writes the file.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AccessAlias, AccessMachineId, Ed25519PublicKey, SshPublicKey } from "@omp-app/contracts";
import { z } from "zod";
import type { Logger } from "../../logging";
import { writeFileAtomic } from "../../modules/A1/fs/atomic-file";
import { newMachineId } from "./keys";

/** The most machines one server enrolls. */
export const MACHINES_MAX = 32;

const SavedMachine = z.strictObject({
  id: AccessMachineId,
  alias: AccessAlias,
  identityKey: Ed25519PublicKey,
  hostKey: SshPublicKey,
  enrolledAt: z.string(),
  lastSeenAt: z.string().nullable(),
});
export type SavedMachine = z.infer<typeof SavedMachine>;

const Saved = z.strictObject({ version: z.literal(1), machines: z.array(SavedMachine) });

export type EnrollResult =
  | { readonly status: "enrolled"; readonly machine: SavedMachine }
  | { readonly status: "alias-taken" | "too-many" };

export class AccessStore {
  readonly filePath: string;
  readonly #machines = new Map<string, SavedMachine>();
  readonly #listeners = new Set<() => void>();
  readonly #removedListeners = new Set<(machineId: string) => void>();
  readonly #now: () => Date;
  readonly #logger: Logger | undefined;
  #writing: Promise<void> = Promise.resolve();

  private constructor(folder: string, now: () => Date, logger: Logger | undefined) {
    this.filePath = join(folder, "machines.json");
    this.#now = now;
    this.#logger = logger;
  }

  /** The machines the file lists; a damaged file is logged and enrolls none (each enrolls again). */
  static async open(options: {
    readonly folder: string;
    readonly now?: () => Date;
    readonly logger?: Logger;
  }): Promise<AccessStore> {
    const store = new AccessStore(
      options.folder,
      options.now ?? (() => new Date()),
      options.logger,
    );
    const text = await readFile(store.filePath, "utf8").catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
      throw error;
    });
    if (text === null) return store;
    let parsed: ReturnType<typeof Saved.safeParse> | undefined;
    try {
      parsed = Saved.safeParse(JSON.parse(text));
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined || !parsed.success) {
      store.#logger?.warn("device_access.damaged", { path: store.filePath });
      return store;
    }
    for (const machine of parsed.data.machines) store.#machines.set(machine.id, machine);
    return store;
  }

  list(): SavedMachine[] {
    return [...this.#machines.values()].sort((a, b) => a.enrolledAt.localeCompare(b.enrolledAt));
  }

  byId(machineId: string): SavedMachine | undefined {
    return this.#machines.get(machineId);
  }

  byAlias(alias: string): SavedMachine | undefined {
    return [...this.#machines.values()].find((machine) => machine.alias === alias);
  }

  /** Enrolls a machine under a new id; an alias in use, or a full list, is refused. */
  async enroll(
    fields: Pick<SavedMachine, "alias" | "identityKey" | "hostKey">,
  ): Promise<EnrollResult> {
    if (this.byAlias(fields.alias) !== undefined) return { status: "alias-taken" };
    if (this.#machines.size >= MACHINES_MAX) return { status: "too-many" };
    const machine: SavedMachine = {
      id: newMachineId(),
      ...fields,
      enrolledAt: this.#now().toISOString(),
      lastSeenAt: null,
    };
    this.#machines.set(machine.id, machine);
    await this.#save();
    this.#changed();
    return { status: "enrolled", machine };
  }

  /** Forgets a machine: its keys stop working at once. */
  async remove(machineId: string): Promise<boolean> {
    if (!this.#machines.delete(machineId)) return false;
    await this.#save();
    for (const listener of this.#removedListeners) listener(machineId);
    this.#changed();
    return true;
  }

  /** The machine's link answered now; saved with the next change, not on every link. */
  seen(machineId: string): void {
    const machine = this.#machines.get(machineId);
    if (machine === undefined) return;
    this.#machines.set(machineId, { ...machine, lastSeenAt: this.#now().toISOString() });
    void this.#save().catch(() => undefined);
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onRemoved(listener: (machineId: string) => void): () => void {
    this.#removedListeners.add(listener);
    return () => this.#removedListeners.delete(listener);
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }

  #save(): Promise<void> {
    const write = this.#writing.then(() =>
      writeFileAtomic(
        this.filePath,
        `${JSON.stringify({ version: 1, machines: [...this.#machines.values()] }, null, 2)}\n`,
      ).then(() => undefined),
    );
    this.#writing = write.catch((error: unknown) => {
      this.#logger?.warn("device_access.save_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
    });
    return write;
  }
}
