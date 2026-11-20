/**
 * Agent access on the server (#20): the enrolled machines, each one's live link, the streams the agents' `ssh` opens
 * through `device-ssh`, the files that `ssh` reads, and what the pages hear. One link per machine: a new one that checks
 * out replaces the old.
 */
import type { AccessActivity, AccessMachine, ServerAccessFrame } from "@omp-app/contracts";
import type { Logger } from "../../logging";
import type { ActivityLog } from "./activity";
import { AccessLink, LINK_CLOSE, type StreamHandle, type StreamSink } from "./link";
import type { SshFiles } from "./ssh-files";
import type { AccessStore } from "./store";

export interface AccessHubDeps {
  readonly store: AccessStore;
  readonly activity: ActivityLog;
  readonly files: SshFiles;
  /** This server's address, as machines enrolled with it. */
  readonly serverOrigin: string;
  /** The chat a chat process's systemd scope id belongs to (`omp-app-chat-<id>.scope`), or null. */
  readonly threadOfScope: (scopeId: string) => string | null;
  /** A chat's name, for the machine's person to recognise it (PLAN §7f); null when unknown. */
  readonly chatName?: (threadId: string) => Promise<string | null>;
  readonly onMachinesChanged: (machines: AccessMachine[]) => void;
  readonly onActivity: (activity: AccessActivity) => void;
  readonly logger?: Logger;
}

export class AccessHub {
  readonly #deps: AccessHubDeps;
  /** Live, checked-out links by machine id. */
  readonly #links = new Map<string, AccessLink>();

  private constructor(deps: AccessHubDeps) {
    this.#deps = deps;
  }

  static async open(deps: AccessHubDeps): Promise<AccessHub> {
    const hub = new AccessHub(deps);
    await deps.files.write(deps.store.list());
    deps.store.subscribe(() => {
      void deps.files.write(deps.store.list()).catch((error: unknown) => hub.#warn("files", error));
      hub.#changed();
    });
    deps.store.onRemoved((machineId) => {
      hub.#links.get(machineId)?.end(LINK_CLOSE.removed, "removed");
      void deps.activity.remove(machineId);
    });
    return hub;
  }

  /** A machine's link socket opened: the link challenges it at once. */
  attach(
    send: (frame: ServerAccessFrame) => void,
    close: (code: number, reason: string) => void,
  ): AccessLink {
    const link = new AccessLink({
      send,
      close,
      machine: (id) => this.#deps.store.byId(id),
      serverOrigin: this.#deps.serverOrigin,
      lastSeq: (id) => this.#deps.activity.lastSeq(id),
      openRuns: (id) => this.#deps.activity.openRuns(id),
      onAuthenticated: (authed) => {
        const machine = authed.machine;
        if (machine === null) return;
        const old = this.#links.get(machine.id);
        this.#links.set(machine.id, authed);
        old?.end(LINK_CLOSE.removed, "replaced by a newer link");
        this.#deps.store.seen(machine.id);
        this.#deps.logger?.info("device_access.linked", { machine: machine.alias });
        this.#changed();
      },
      onState: (changed) => {
        const machine = changed.machine;
        if (machine === null) return;
        void this.#deps.files
          .setKey(machine.alias, changed.state.on ? changed.sessionKey : null)
          .catch((error: unknown) => this.#warn("key", error));
        this.#deps.logger?.info("device_access.state", {
          machine: machine.alias,
          on: changed.state.on,
        });
        this.#changed();
      },
      onActivity: (_link, activity) => {
        void this.#deps.activity
          .append(activity)
          .catch((error: unknown) => this.#warn("activity", error));
        if (!activity.verified) {
          this.#deps.logger?.warn("device_access.unverified_record", {
            machine: activity.record.machineId,
            seq: activity.record.seq,
          });
        }
        this.#deps.onActivity(activity);
      },
      onLeave: (leaving) => {
        const machine = leaving.machine;
        if (machine === null) return;
        this.#deps.logger?.info("device_access.left", { machine: machine.alias });
        // Removing it ends this link (onRemoved above) and forgets its history, as the panel's Remove does.
        void this.#deps.store
          .remove(machine.id)
          .catch((error: unknown) => this.#warn("leave", error));
      },
    });
    link.start();
    return link;
  }

  /** The link's socket closed. */
  detached(link: AccessLink): void {
    link.ended();
    const machine = link.machine;
    if (machine === null || this.#links.get(machine.id) !== link) return;
    this.#links.delete(machine.id);
    void this.#deps.files
      .setKey(machine.alias, null)
      .catch((error: unknown) => this.#warn("key", error));
    this.#changed();
  }

  machines(): AccessMachine[] {
    return this.#deps.store.list().map((machine) => {
      const link = this.#links.get(machine.id);
      return {
        id: machine.id,
        alias: machine.alias,
        enrolledAt: machine.enrolledAt,
        lastSeenAt: machine.lastSeenAt,
        state: link?.state ?? { on: false },
        reviewPending: link?.reviewPending ?? false,
        reach: [...(link?.reach ?? [])],
      };
    });
  }

  /** Asks the machine to turn off; false when it has no link (then it is off already). */
  off(machineId: string): boolean {
    const link = this.#links.get(machineId);
    if (link === undefined) return false;
    link.off();
    return true;
  }

  /**
   * Opens a session for an agent's `ssh <alias>`, from a chat process's scope (or none); a reason when refused. The
   * chat's name goes with it, so a machine that keeps chat grants can name the chat to its person.
   */
  async openStream(
    alias: string,
    scopeId: string | null,
    sink: StreamSink,
  ): Promise<StreamHandle | string> {
    const machine = this.#deps.store.byAlias(alias);
    if (machine === undefined) return `${alias}: no machine has that name`;
    const threadId = scopeId === null ? null : this.#deps.threadOfScope(scopeId);
    const chat =
      threadId === null ? null : await (this.#deps.chatName?.(threadId) ?? Promise.resolve(null));
    // Looked up after the name: the link may have gone meanwhile.
    const link = this.#links.get(machine.id);
    if (link === undefined) return `${alias}: agent access is off`;
    const handle = link.openStream(threadId, sink, chat ?? undefined);
    return typeof handle === "string" ? `${alias}: ${handle}` : handle;
  }

  #changed(): void {
    this.#deps.onMachinesChanged(this.machines());
  }

  #warn(what: string, error: unknown): void {
    this.#deps.logger?.warn("device_access.write_failed", {
      what,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
