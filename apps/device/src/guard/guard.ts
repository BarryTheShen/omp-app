/**
 * `omp-app-device-guard` (#20): the root-owned part of agent access on a machine. It owns what a session of the agent
 * account must not be able to undo:
 * - **the switch's deadline:** access turns off at its end time even if the person's agent stops;
 * - **the sessions:** each stream gets its own `sshd -i` as the agent account, all in one systemd slice that `off`
 *   stops, so nothing a session started survives;
 * - **the key:** the turn-on's public key is the only one sshd accepts, removed at off;
 * - **the records:** the wrapper reports each command to the guard, which keeps the log and tells the agent.
 *
 * Two sockets in its run folder: `control.sock` (the person's agent only: owner-only) and `records.sock` (the wrapper,
 * as the agent account). Lines of JSON, then, for `open`, the session's raw bytes.
 */
import { chmod, chown, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { SERVER_NAME } from "../agent/guard-client";
import type { AgentAccount } from "./account";
import { checkFolder, sharedAt } from "./folders";
import { changedSince, type Snapshot, snapshot } from "./persistence";
import type { FolderMounter, SharedFolder, SharedFolders } from "./shared";
import { authorizedKeyLine, sessionConfig } from "./sshd-config";
import type { SudoGrants } from "./sudo";

/** How a session's sshd is started, and how every session is ended. */
export interface SessionLauncher {
  /** Starts `sshd -i -f <config>`; its stdin and stdout carry the session. */
  start(configPath: string): {
    readonly stdin: { write(bytes: Uint8Array): number | Promise<number>; end(): void };
    readonly stdout: ReadableStream<Uint8Array>;
    readonly exited: Promise<number>;
    kill(): void;
  };
  /** Ends every session and whatever they started (the slice). */
  stopAll(): Promise<void>;
  /** Ends every process in the sessions that runs as root (what a sudo grant started); returns how many it ended. */
  endRoot(): Promise<number>;
}

/** What the password is asked for: each its own polkit action (`dev.ompapp.device.<action>`), with its own message. */
export type GuardAction =
  | "turn-on"
  | "extend"
  | "sudo"
  | "acknowledge"
  | "share-folder"
  | "grant-chat";

/**
 * Asks the person, on the machine, for their password for `action`; true once given. `message` is what the dialog
 * says, written by the guard from what it will grant (the length after its limits), never from what was asked for.
 */
export type Verify = (pid: number, action: GuardAction, message: string) => Promise<boolean>;

/** "2 hours", "30 minutes", "1 hour 30 minutes". */
export function lengthText(minutes: number): string {
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const h = hours === 0 ? "" : `${hours} hour${hours === 1 ? "" : "s"}`;
  const m = rest === 0 ? "" : `${rest} minute${rest === 1 ? "" : "s"}`;
  return [h, m].filter((part) => part !== "").join(" ") || "0 minutes";
}

export interface GuardOptions {
  readonly runDir: string;
  readonly account: string;
  readonly hostKey: string;
  readonly wrapper: string;
  readonly sftpServer: string;
  readonly sshdSession?: string;
  readonly sshdAuth?: string;
  readonly launcher: SessionLauncher;
  readonly verify: Verify;
  /** The longest access may last at once. */
  readonly maxOnMs: number;
  /** Where each record line is appended (the log the agent account cannot write). */
  readonly log: (line: string) => void;
  /** Where what must survive a reboot is kept (a review pending). */
  readonly stateDir: string;
  /** The agent account's startup and persistence paths (`persistencePaths`). */
  readonly watchPaths: readonly string[];
  /** The agent account: checked before a turn-on, reset at the guard's start, at turn-on and at off. */
  readonly agentAccount: AgentAccount;
  /** Passwordless sudo for the agent account while a grant lasts (`SudoersFile`). */
  readonly sudo: SudoGrants;
  /** The longest a sudo grant lasts. */
  readonly maxSudoMs?: number;
  /**
   * Takes logind's delay lock on sleep while access is on, so the computer waits (up to logind's
   * `InhibitDelayMaxSec`, 5 s by default) for off to finish before it sleeps; returns what releases it. Watching
   * PrepareForSleep without one is racy (systemd's inhibitor-lock documentation): on a 26.04 VM the kernel suspended
   * 25 ms after the "going to sleep" signal, before the off was written.
   */
  readonly holdSleep?: () => () => void;
  readonly now?: () => number;
  /** Folders of the person's that agents may ask for (PLAN §7d); without it, every request is refused. */
  readonly folders?: FolderSharing;
}

export interface FolderSharing {
  readonly shared: SharedFolders;
  readonly mounter: FolderMounter;
  /** The person whose folders are shared. */
  readonly person: { readonly home: string; readonly uid: number };
  /** Where shared folders are mounted: the guard's own, never in the agent account's home (`sharedAt`). */
  readonly root: string;
  /** How long a request waits for the person: 10 minutes. */
  readonly askMs?: number;
}

/**
 * The server the person's agent is linked to, as its host (and port), named in each password dialog so the person sees
 * whose agents will get the access. From the person's own agent (its record of the link), never from a page; only a
 * host's letters, so nothing else can be written into the dialog.
 */
const ServerName = z.string().max(260).regex(SERVER_NAME);
/** An agent's folder request, as the asking session names it. */
const AskId = z.string().regex(/^[0-9a-f]{16}$/);

/**
 * The longest access may last at once, in minutes: 8 hours, picked at turn-on with the password, as any length is; two
 * hours is the default.
 */
export const LONGEST_ON_MINUTES = 480;

const Control = z.discriminatedUnion("op", [
  z.strictObject({
    op: z.literal("on"),
    /** The agent's process: the password dialog is asked for it. */
    pid: z.number().int().positive(),
    minutes: z.number().int().min(1).max(LONGEST_ON_MINUTES),
    publicKey: z.string().max(200),
    server: ServerName.optional(),
  }),
  z.strictObject({ op: z.literal("off") }),
  z.strictObject({ op: z.literal("state") }),
  z.strictObject({ op: z.literal("open"), stream: z.number().int().min(1) }),
  z.strictObject({ op: z.literal("watch") }),
  /** The person looked at what changed during the last access (on the machine, with their password). */
  z.strictObject({
    op: z.literal("acknowledge"),
    pid: z.number().int().positive(),
    server: ServerName.optional(),
  }),
  /** More time while on (the person's password again). */
  z.strictObject({
    op: z.literal("extend"),
    pid: z.number().int().positive(),
    minutes: z.number().int().min(1).max(LONGEST_ON_MINUTES),
    server: ServerName.optional(),
  }),
  /** Sudo for the agent account while access is on, for `minutes` (the person's password again). */
  z.strictObject({
    op: z.literal("sudo"),
    pid: z.number().int().positive(),
    minutes: z.number().int().min(1).max(30),
    server: ServerName.optional(),
  }),
  /** The person allows an agent's folder request (their password), to read it or also to change it. */
  z.strictObject({
    op: z.literal("allow-folder"),
    pid: z.number().int().positive(),
    id: AskId,
    write: z.boolean(),
    server: ServerName.optional(),
  }),
  z.strictObject({ op: z.literal("deny-folder"), id: AskId }),
  /** Stops sharing a folder: no password, it only takes away. */
  z.strictObject({ op: z.literal("remove-folder"), path: z.string().startsWith("/").max(4_096) }),
  /** The person shares a folder themselves, without an agent's asking (their password), `~/…` or a full path. */
  z.strictObject({
    op: z.literal("share-folder"),
    pid: z.number().int().positive(),
    path: z.string().min(1).max(4_096),
    write: z.boolean(),
    server: ServerName.optional(),
  }),
  /** The person's password for allowing one chat to reach this computer (PLAN §7f); the grant is kept by their agent. */
  z.strictObject({
    op: z.literal("grant-chat"),
    pid: z.number().int().positive(),
    chat: z.string().max(120),
    server: ServerName.optional(),
  }),
]);

/** Who gets the access, as a password dialog says it: the server's agents when the agent named it. */
const whose = (server: string | undefined): string =>
  server === undefined ? "Agents in omp-app" : `Agents of the omp-app server ${server}`;

/** What the password dialog says when a folder is shared, whoever asked for it. */
const shareText = (server: string | undefined, path: string, write: boolean): string =>
  `${whose(server)} will be able to ${write ? "read and change" : "read"} the files in ${path} whenever agent access is on, until you remove it from Shared folders.`;

/** Text an agent wrote, as one line for the person: control and direction characters become spaces. */
const oneLine = (text: string): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
  text.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ");

/** At most `count` of the review's entries, each one line of at most 100 characters, for a password dialog. */
export function reviewText(review: readonly string[], count = 5): string {
  const shown = review
    .slice(0, count)
    .map((each) => {
      const line = oneLine(each);
      return line.length > 100 ? `${line.slice(0, 99)}…` : line;
    })
    .join("; ");
  return review.length > count ? `${shown}; and ${review.length - count} more` : shown;
}

/** What the wrapper says about a session. */
const WrapperEvent = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("start"),
    stream: z.number().int().min(1),
    run: z.string().regex(/^[0-9a-f]{16}$/),
    kind: z.enum(["command", "shell", "sftp"]),
    command: z.string().max(4_000),
    folder: z.string().max(1_000),
    startedAt: z.string(),
  }),
  z.strictObject({
    type: z.literal("output"),
    stream: z.number().int().min(1),
    run: z.string().regex(/^[0-9a-f]{16}$/),
    /** What the terminal showed, base64; never what was typed. */
    bytes: z.string().max(90_000),
  }),
  z.strictObject({
    type: z.literal("end"),
    stream: z.number().int().min(1),
    run: z.string().regex(/^[0-9a-f]{16}$/),
    exitCode: z.number().int().nullable(),
    endedAt: z.string(),
  }),
  /** An agent asks for a folder of the person's (`omp-app-device ask-folder`), answered on the same connection. */
  z.strictObject({
    type: z.literal("ask-folder"),
    stream: z.number().int().min(1),
    request: AskId,
    path: z.string().max(4_096),
    write: z.boolean(),
    why: z.string().max(300),
  }),
]);
export type WrapperEvent = z.infer<typeof WrapperEvent>;

export interface GuardState {
  readonly on: boolean;
  readonly until: string | null;
  readonly sessions: number;
  readonly hostKey: string;
  /** Why the next turn-on waits until the person acknowledges (a sudo grant was used): access stays off till then. */
  readonly reviewPending: boolean;
  readonly changed: readonly string[];
  /** What the last off removed from the agent account (startup files, jobs). */
  readonly removed: readonly string[];
  /** When the agent account's sudo grant ends; null without one. */
  readonly sudoUntil: string | null;
  /** Agents' folder requests waiting for the person. */
  readonly asks: readonly FolderAsk[];
  /** The folders shared with agents, mounted while on. */
  readonly shared: readonly SharedFolder[];
}

/** An agent's request for a folder, as the person is shown it. */
export interface FolderAsk {
  readonly id: string;
  /** The folder's real path. */
  readonly path: string;
  /** Whether the agent asked to change files too. */
  readonly write: boolean;
  /** Why, as the agent said it (one line). */
  readonly why: string;
  /** The server whose agents have access now. */
  readonly server: string | null;
}

export class Guard {
  readonly #options: GuardOptions;
  #until: number | null = null;
  #deadline: ReturnType<typeof setTimeout> | null = null;
  readonly #sessions = new Set<{ kill(): void }>();
  /** Streams with a session now, and how many runs each has started (one connection to the records socket per run). */
  readonly #openStreams = new Map<number, number>();
  /** Runs started in the current minute, all streams together: below the server's record limit. */
  #runsThisMinute = { minute: 0, count: 0 };
  readonly #watchers = new Set<(line: string) => void>();
  #stop: (() => void)[] = [];
  /** The persistence paths' fingerprints when access turned on. */
  #snapshot: Snapshot | null = null;
  /** What changed during the last access, until acknowledged (kept in the state folder). */
  #review: string[] = [];
  /** What the last off removed from the agent account. */
  #removed: string[] = [];
  /** Sudo was allowed during this access: what ran as root cannot be checked. */
  #sudoGranted = false;
  #sudoUntil: number | null = null;
  #sudoTimer: ReturnType<typeof setTimeout> | null = null;
  /** Counts offs: a grant asked during one access never outlives it, even when its password comes late. */
  #offs = 0;
  /** Releases logind's delay lock on sleep, held while on (`holdSleep`). */
  #sleepRelease: (() => void) | null = null;
  /** The server named at the last turn-on: whose agents ask for folders. */
  #server: string | undefined;
  /** Folder requests waiting for the person, each answered on its own connection. */
  readonly #asks = new Map<
    string,
    FolderAsk & { readonly place: string; readonly reply: (answer: object) => void }
  >();
  /** The shared folders, as `folders.shared` keeps them. */
  #shared: readonly SharedFolder[] = [];
  #access: { readonly agentGid: number } | undefined;

  constructor(options: GuardOptions) {
    this.#options = options;
  }

  get controlSocket(): string {
    return join(this.#options.runDir, "control.sock");
  }

  get recordsSocket(): string {
    return join(this.#options.runDir, "records.sock");
  }

  /**
   * Starts the guard: off first (whatever a crash or a reboot left on), then its sockets. As root, `access` names who
   * may reach them: the control socket the person's account only, the records socket the agent account's group only
   * (the wrapper reports through it). Without it (tests, run as one account), both are the running account's only.
   */
  async start(access?: {
    readonly person: { readonly uid: number; readonly gid: number };
    readonly agentGid: number;
  }): Promise<void> {
    await mkdir(this.#options.runDir, { recursive: true, mode: 0o755 });
    this.#access = access;
    if (this.#options.folders !== undefined)
      this.#shared = await this.#options.folders.shared.list();
    // Also unmounts what a crash left mounted.
    await this.off();
    // A review left pending by the last access (also across a reboot) still holds the next turn-on.
    const kept = await readFile(this.#reviewFile, "utf8").catch(() => null);
    if (kept !== null) {
      let changed: string[] = ["(the review file could not be read)"];
      try {
        const parsed = z.object({ changed: z.array(z.string()) }).safeParse(JSON.parse(kept));
        if (parsed.success && parsed.data.changed.length > 0) changed = parsed.data.changed;
      } catch {
        // A damaged file still holds the next turn-on.
      }
      this.#review = changed;
    }
    this.#stop.push(
      await this.#listen(this.controlSocket, (line, socket) => this.#control(line, socket)),
    );
    this.#stop.push(
      await this.#listen(
        this.recordsSocket,
        (line, socket) => this.#record(line, socket),
        RECORDS_LIMITS,
      ),
    );
    await chmod(this.controlSocket, 0o600);
    await chmod(this.recordsSocket, access === undefined ? 0o600 : 0o660);
    if (access !== undefined) {
      await chown(this.controlSocket, access.person.uid, access.person.gid);
      await chown(this.recordsSocket, 0, access.agentGid);
    }
  }

  async stop(): Promise<void> {
    await this.off();
    for (const stop of this.#stop) stop();
    this.#stop = [];
  }

  state(): GuardState {
    return {
      on: this.#until !== null,
      until: this.#until === null ? null : new Date(this.#until).toISOString(),
      sessions: this.#sessions.size,
      hostKey: this.#options.hostKey,
      reviewPending: this.#review.length > 0,
      changed: this.#review,
      removed: this.#removed,
      sudoUntil: this.#sudoUntil === null ? null : new Date(this.#sudoUntil).toISOString(),
      asks: [...this.#asks.values()].map(({ id, path, write, why, server }) => ({
        id,
        path,
        write,
        why,
        server,
      })),
      shared: this.#shared,
    };
  }

  /** Turns access on for `minutes` with this key, once the person gave their password. */
  async on(
    pid: number,
    minutes: number,
    publicKey: string,
    server?: string,
  ): Promise<string | null> {
    const line = (() => {
      try {
        return authorizedKeyLine(publicKey);
      } catch {
        return null;
      }
    })();
    if (line === null) return "not an Ed25519 public key";
    if (this.#review.length > 0) {
      return `the changes made during the last session must be reviewed first (${this.#review.join("; ")}): review the computer, then run omp-app-device acknowledge, or select "Mark as reviewed" in the desktop app's Agent access panel`;
    }
    const granted = Math.min(minutes, Math.floor(this.#options.maxOnMs / 60_000));
    const asked = await this.#options.verify(
      pid,
      "turn-on",
      `${whose(server)} will be able to run commands on this computer, as its agent account, for ${lengthText(granted)}. Every command is displayed and logged.`,
    );
    if (!asked) return "the password was not given";
    // An off with a review may have come while the password was asked.
    if (this.#review.length > 0)
      return "the changes made during the last session must be reviewed first";
    const problem = await this.#options.agentAccount.problem();
    if (problem !== null) return problem;
    const turningOn = this.#until === null;
    if (this.#until === null) {
      // Whatever the account kept since the last access goes before this one starts.
      await this.#options.agentAccount.reset();
      this.#snapshot = await snapshot(this.#options.watchPaths);
    }
    const now = (this.#options.now ?? Date.now)();
    const until = now + Math.min(minutes * 60_000, this.#options.maxOnMs);
    await writeFile(this.#path("authorized_keys"), line, { mode: 0o644 });
    this.#server = server;
    // Before access starts: no session of the agent account runs while the guard mounts.
    if (turningOn) await this.#mountShared();
    this.#until = until;
    this.#sleepRelease ??= this.#options.holdSleep?.() ?? null;
    if (this.#deadline !== null) clearTimeout(this.#deadline);
    this.#deadline = setTimeout(() => void this.off(), until - now);
    this.#options.log(JSON.stringify({ type: "on", until: new Date(until).toISOString() }));
    this.#tell({ type: "state", state: this.state() });
    return null;
  }

  /**
   * `minutes` more while on, once the person gave their password again; never more than the longest turn-on from now.
   * Returns why not, or null.
   */
  async extend(pid: number, minutes: number, server?: string): Promise<string | null> {
    if (this.#until === null) return "agent access is off";
    const longest = Math.floor(this.#options.maxOnMs / 60_000);
    const asked = await this.#options.verify(
      pid,
      "extend",
      `${whose(server)} will keep their access to this computer for an additional ${lengthText(Math.min(minutes, longest))}, up to ${lengthText(longest)} from now.`,
    );
    if (!asked) return "the password was not given";
    // It may have turned off while the password was asked.
    if (this.#until === null) return "agent access is off";
    const now = (this.#options.now ?? Date.now)();
    const until = Math.min(this.#until + minutes * 60_000, now + this.#options.maxOnMs);
    this.#until = until;
    if (this.#deadline !== null) clearTimeout(this.#deadline);
    this.#deadline = setTimeout(() => void this.off(), until - now);
    this.#options.log(JSON.stringify({ type: "extended", until: new Date(until).toISOString() }));
    this.#tell({ type: "state", state: this.state() });
    return null;
  }

  /**
   * Off: the key and any sudo grant go first, then every session and every process of the agent account ends (also one
   * outside the slice), then what it left that could start something later is removed.
   */
  async off(): Promise<void> {
    const wasOn = this.#until !== null;
    this.#until = null;
    this.#offs += 1;
    if (this.#deadline !== null) clearTimeout(this.#deadline);
    this.#deadline = null;
    await rm(this.#path("authorized_keys"), { force: true });
    // The off state is told once, below, with what changed: the agent's summary comes from it.
    await this.#endSudo(false);
    for (const session of this.#sessions) session.kill();
    this.#sessions.clear();
    await this.#options.launcher.stopAll();
    this.#endAsks("agent access turned off");
    await this.#unmountAll();
    const changed = wasOn && this.#snapshot !== null ? await changedSince(this.#snapshot) : [];
    this.#snapshot = null;
    // At the guard's start too: whatever a crash or a reboot left.
    const removed = await this.#options.agentAccount.reset();
    if (wasOn) {
      this.#removed = removed;
      if (this.#sudoGranted) {
        // As root a session could change anything, beyond what the reset reaches: the person looks first.
        this.#review = [
          "Sudo was allowed during this session; commands run as root were not checked",
          ...changed,
        ];
        await mkdir(this.#options.stateDir, { recursive: true, mode: 0o700 });
        await writeFile(this.#reviewFile, `${JSON.stringify({ changed: this.#review })}\n`, {
          mode: 0o600,
        });
      }
      this.#sudoGranted = false;
      this.#options.log(
        JSON.stringify({
          type: "off",
          at: new Date((this.#options.now ?? Date.now)()).toISOString(),
          changed,
          removed,
        }),
      );
      this.#tell({ type: "state", state: this.state() });
    }
    // Last: off is done, so the computer may sleep now.
    this.#sleepRelease?.();
    this.#sleepRelease = null;
  }

  /**
   * Passwordless sudo for the agent account for `minutes`, while access is on and never past its end, once the person
   * gave their password again. Returns why not, or null.
   */
  async sudo(pid: number, minutes: number, server?: string): Promise<string | null> {
    if (this.#until === null) return "agent access is off";
    const access = this.#offs;
    const longestSudo = Math.floor((this.#options.maxSudoMs ?? 30 * 60_000) / 60_000);
    const leftOn = Math.max(
      1,
      Math.floor((this.#until - (this.#options.now ?? Date.now)()) / 60_000),
    );
    const asked = await this.#options.verify(
      pid,
      "sudo",
      `${whose(server)} will be able to run commands as root (administrator) on this computer, without a password, for ${lengthText(Math.min(minutes, longestSudo, leftOn))}, never past the end of access. Commands run as root are not checked afterwards.`,
    );
    if (!asked) return "the password was not given";
    // It may have turned off while the password was asked.
    if (this.#until === null || this.#offs !== access) return "agent access is off";
    const now = (this.#options.now ?? Date.now)();
    const until = Math.min(
      now + Math.min(minutes * 60_000, this.#options.maxSudoMs ?? 30 * 60_000),
      this.#until,
    );
    const refused = await this.#options.sudo.grant(this.#options.account);
    if (refused !== null) return refused;
    // An off while the drop-in was written already revoked: the grant must not outlive that access.
    if (this.#until === null || this.#offs !== access) {
      await this.#options.sudo.revoke();
      return "agent access is off";
    }
    this.#sudoGranted = true;
    this.#sudoUntil = until;
    if (this.#sudoTimer !== null) clearTimeout(this.#sudoTimer);
    this.#sudoTimer = setTimeout(() => void this.#endSudo(), until - now);
    this.#options.log(JSON.stringify({ type: "sudo", until: new Date(until).toISOString() }));
    this.#tell({ type: "state", state: this.state() });
    return null;
  }

  async #endSudo(tell = true): Promise<void> {
    if (this.#sudoTimer !== null) clearTimeout(this.#sudoTimer);
    this.#sudoTimer = null;
    const had = this.#sudoUntil !== null;
    this.#sudoUntil = null;
    await this.#options.sudo.revoke();
    if (had) {
      // What ran as root under the grant ends with it, not at off.
      const rootEnded = await this.#options.launcher.endRoot();
      this.#options.log(JSON.stringify({ type: "sudo-ended", rootEnded }));
      if (tell) this.#tell({ type: "state", state: this.state() });
    }
  }

  /** The person looked at what changed (with their password): the next turn-on may go ahead. */
  async acknowledge(pid: number, server?: string): Promise<string | null> {
    if (this.#review.length === 0) return null;
    const asked = await this.#options.verify(
      pid,
      "acknowledge",
      `By continuing, you confirm that you have reviewed this computer after agents had sudo access: ${reviewText(this.#review)}. ${whose(server)} may then be given access again.`,
    );
    if (!asked) return "the password was not given";
    this.#options.log(JSON.stringify({ type: "reviewed", changed: this.#review }));
    this.#review = [];
    await rm(this.#reviewFile, { force: true });
    this.#tell({ type: "state", state: this.state() });
    return null;
  }

  /**
   * An agent's request for a folder of the person's, on a session's own records connection. Refused at once when the
   * folder may not be shared (`checkFolder`), when access is off, or when three requests already wait; answered at once
   * when a shared folder covers it already. Else the agent hears "asked" at once and does not wait: the request stays
   * for the person (`allowFolder`, `denyFolder`) up to 10 minutes, and their answer goes out as a `folder-answer` event
   * with the request's stream, which the person's agent passes on so the chat hears it as a notice. A folder inside a
   * shared one that does not cover it is refused, so mount points never nest: each stays a folder of the guard's own.
   */
  #ask(
    event: Extract<WrapperEvent, { type: "ask-folder" }>,
    socket: Bun.Socket<ConnectionData>,
  ): void {
    if (
      socket.data.run !== null ||
      !this.#openStreams.has(event.stream) ||
      this.#asks.has(event.request)
    ) {
      socket.end();
      return;
    }
    // Bound, so the records socket does not close it before the person answers; its run is no wrapper's.
    socket.data.run = { stream: event.stream, run: `ask-${event.request}` };
    const id = event.request;
    let gone = false;
    socket.data.closed = () => {
      gone = true;
      if (this.#asks.delete(id)) this.#tell({ type: "state", state: this.state() });
    };
    const answer = (reply: object) => socket.end(`${JSON.stringify(reply)}\n`);
    const folders = this.#options.folders;
    if (folders === undefined) {
      answer({ answer: "refused", reason: "this computer does not share folders" });
      return;
    }
    void (async () => {
      const check = await checkFolder(event.path, folders.person);
      if (gone) return;
      if ("problem" in check) return answer({ answer: "refused", reason: check.problem });
      const covering = this.#shared.find(
        (each) => each.path === check.path || check.path.startsWith(`${each.path}/`),
      );
      if (covering !== undefined) {
        const at = `${sharedAt(covering.place, folders.root)}${check.path.slice(covering.path.length)}`;
        if (covering.write || !event.write)
          return answer({ answer: "allowed", at, write: covering.write });
        if (covering.path !== check.path)
          return answer({
            answer: "refused",
            reason: `${check.path} is inside ${covering.path}, which is shared read only (at ${at}): ask for ${covering.path} itself to change files`,
          });
      }
      if (this.#until === null) return answer({ answer: "refused", reason: "agent access is off" });
      if (this.#asks.size >= 3)
        return answer({
          answer: "refused",
          reason: "three requests are already waiting for the person: ask again once they answer",
        });
      const timer = setTimeout(
        () =>
          this.#answer(id, {
            answer: "no answer",
            reason: "the person did not answer within 10 minutes",
          }),
        folders.askMs ?? 600_000,
      );
      this.#asks.set(id, {
        id,
        path: check.path,
        place: check.place,
        write: event.write,
        why: oneLine(event.why).trim(),
        server: this.#server ?? null,
        reply: (reply) => {
          clearTimeout(timer);
          this.#tell({ type: "folder-answer", stream: event.stream, path: check.path, ...reply });
        },
      });
      this.#options.log(
        JSON.stringify({
          type: "folder-request",
          stream: event.stream,
          path: check.path,
          write: event.write,
        }),
      );
      this.#tell({ type: "state", state: this.state() });
      // The request no longer depends on its connection: the agent goes on, and hears the answer in its chat.
      socket.data.closed = null;
      answer({ answer: "asked" });
    })();
  }

  /** Answers a waiting request on its connection, and takes it off the list. */
  #answer(id: string, reply: object): void {
    const ask = this.#asks.get(id);
    if (ask === undefined) return;
    this.#asks.delete(id);
    ask.reply(reply);
    this.#tell({ type: "state", state: this.state() });
  }

  #endAsks(reason: string): void {
    for (const id of [...this.#asks.keys()]) this.#answer(id, { answer: "no answer", reason });
  }

  /**
   * The person allows a waiting request, with their password: the folder is shared from now on, to read it, or also to
   * change it when `write` and the agent asked for that; mounted at once while on. Shared folders inside it give way to
   * it. Returns why not, or null.
   */
  async allowFolder(
    pid: number,
    id: string,
    write: boolean,
    server?: string,
  ): Promise<string | null> {
    const folders = this.#options.folders;
    const ask = this.#asks.get(id);
    if (folders === undefined || ask === undefined) return "that request is no longer waiting";
    const writes = write && ask.write;
    const given = await this.#options.verify(
      pid,
      "share-folder",
      shareText(server, ask.path, writes),
    );
    if (!given) return "the password was not given";
    if (!this.#asks.has(id)) return "that request is no longer waiting";
    const problem = await this.#share({ path: ask.path, place: ask.place }, writes, ask.server);
    this.#answer(
      id,
      problem === null
        ? { answer: "allowed", at: sharedAt(ask.place, folders.root), write: writes }
        : {
            answer: "refused",
            reason: `the person allowed it, but it could not be mounted: ${problem}`,
          },
    );
    return null;
  }

  /**
   * The person shares a folder themselves, without an agent's asking, with their password: checked as an agent's
   * request is (`checkFolder`), then shared and mounted as an allowed request is. Returns why not, or null.
   */
  async shareFolder(
    pid: number,
    asked: string,
    write: boolean,
    server?: string,
  ): Promise<string | null> {
    const folders = this.#options.folders;
    if (folders === undefined) return "this computer does not share folders";
    const check = await checkFolder(asked, folders.person);
    if ("problem" in check) return check.problem;
    const covering = this.#shared.find(
      (each) => each.path === check.path || check.path.startsWith(`${each.path}/`),
    );
    if (covering !== undefined && (covering.write || !write))
      return covering.path === check.path
        ? `${check.path} is already shared`
        : `${check.path} is already shared as part of ${covering.path}`;
    if (covering !== undefined && covering.path !== check.path)
      return `${check.path} is inside ${covering.path}, which is shared read only: share ${covering.path} itself with changes allowed`;
    const given = await this.#options.verify(
      pid,
      "share-folder",
      shareText(server, check.path, write),
    );
    if (!given) return "the password was not given";
    const problem = await this.#share(check, write, this.#server ?? null);
    return problem === null ? null : `It is shared, but it could not be mounted now: ${problem}`;
  }

  /**
   * Shares a folder from now on, the shared folders inside it giving way to it, and mounts it at once while on: null,
   * or why it could not be mounted.
   */
  async #share(
    checked: { readonly path: string; readonly place: string },
    write: boolean,
    server: string | null,
  ): Promise<string | null> {
    const folders = this.#options.folders;
    if (folders === undefined) return "this computer does not share folders";
    for (const inner of this.#shared.filter((each) => each.path.startsWith(`${checked.path}/`)))
      await this.#unshare(inner);
    const folder: SharedFolder = {
      path: checked.path,
      place: checked.place,
      write,
      server,
      grantedAt: new Date((this.#options.now ?? Date.now)()).toISOString(),
    };
    await folders.shared.add(folder);
    this.#shared = await folders.shared.list();
    this.#options.log(JSON.stringify({ type: "folder-shared", path: folder.path, write }));
    const problem = this.#until === null ? null : await this.#mount(folder);
    this.#tell({ type: "state", state: this.state() });
    return problem;
  }

  /** The person turns a waiting request down (no password: it grants nothing). Returns why not, or null. */
  denyFolder(id: string): string | null {
    if (!this.#asks.has(id)) return "that request is no longer waiting";
    this.#options.log(JSON.stringify({ type: "folder-denied", path: this.#asks.get(id)?.path }));
    this.#answer(id, { answer: "denied" });
    return null;
  }

  /**
   * Asks the person's password for allowing the chat `chat` to reach this computer; the dialog's words are the guard's,
   * with the chat's name as one plain line. Returns why not, or null.
   */
  async grantChat(pid: number, chat: string, server?: string): Promise<string | null> {
    const name = oneLine(chat).trim().slice(0, 120) || "A chat";
    const where = server === undefined ? "in omp-app" : `on the omp-app server ${server}`;
    const given = await this.#options.verify(
      pid,
      "grant-chat",
      `The chat "${name}" ${where} will be able to run commands on this computer, as its agent account, whenever agent access is on, until you remove it from Chats with access.`,
    );
    return given ? null : "the password was not given";
  }

  /** Stops sharing a folder, unmounting it at once (no password: it only takes away). Returns why not, or null. */
  async removeFolder(path: string): Promise<string | null> {
    const folder = this.#shared.find((each) => each.path === path);
    if (folder === undefined) return "that folder is not shared";
    await this.#unshare(folder);
    this.#tell({ type: "state", state: this.state() });
    return null;
  }

  async #unshare(folder: SharedFolder): Promise<void> {
    const folders = this.#options.folders;
    if (folders === undefined) return;
    await folders.shared.remove(folder.path);
    this.#shared = await folders.shared.list();
    const at = sharedAt(folder.place, folders.root);
    if ((await folders.mounter.mounted(folders.root)).includes(at))
      await folders.mounter.unmount(at);
    this.#options.log(JSON.stringify({ type: "folder-removed", path: folder.path }));
  }

  /** Mounts a shared folder, checked again first (it may lead elsewhere since): null, or why not. */
  async #mount(folder: SharedFolder): Promise<string | null> {
    const folders = this.#options.folders;
    if (folders === undefined) return "this computer does not share folders";
    const check = await checkFolder(folder.path, folders.person);
    const problem =
      "problem" in check
        ? check.problem
        : check.path !== folder.path
          ? `${folder.path} now leads to ${check.path}`
          : await (async () => {
              // The guard's folder for mounts: root's; the agent account's group may enter it.
              await mkdir(folders.root, { recursive: true, mode: 0o750 });
              await chmod(folders.root, 0o750);
              if (this.#access !== undefined) await chown(folders.root, 0, this.#access.agentGid);
              const at = sharedAt(folder.place, folders.root);
              if ((await folders.mounter.mounted(folders.root)).includes(at))
                await folders.mounter.unmount(at);
              return folders.mounter.mount(folder.path, at, folder.write);
            })();
    this.#options.log(
      JSON.stringify(
        problem === null
          ? { type: "folder-mounted", path: folder.path }
          : { type: "folder-not-mounted", path: folder.path, problem },
      ),
    );
    return problem;
  }

  async #mountShared(): Promise<void> {
    for (const folder of this.#shared) await this.#mount(folder);
  }

  async #unmountAll(): Promise<void> {
    const folders = this.#options.folders;
    if (folders === undefined) return;
    for (const point of await folders.mounter.mounted(folders.root))
      await folders.mounter.unmount(point);
  }

  get #reviewFile(): string {
    return join(this.#options.stateDir, "review.json");
  }

  #path(name: string): string {
    return join(this.#options.runDir, name);
  }

  #tell(event: unknown): void {
    const line = JSON.stringify(event);
    for (const watcher of this.#watchers) watcher(line);
  }

  /** One control line; `open` turns the connection into the session's byte stream. */
  async #control(line: string, socket: Bun.Socket<ConnectionData>): Promise<void> {
    let request: z.infer<typeof Control>;
    try {
      request = Control.parse(JSON.parse(line));
    } catch {
      socket.end("error not a request\n");
      return;
    }
    switch (request.op) {
      case "on": {
        const refused = await this.on(
          request.pid,
          request.minutes,
          request.publicKey,
          request.server,
        );
        socket.end(
          refused === null ? `ok ${JSON.stringify(this.state())}\n` : `error ${refused}\n`,
        );
        return;
      }
      case "off":
        await this.off();
        socket.end("ok\n");
        return;
      case "state":
        socket.end(`ok ${JSON.stringify(this.state())}\n`);
        return;
      case "watch": {
        // Every line whole, in order: what the socket cannot take now waits for its drain. A watcher this far behind
        // is dropped (the agent watches again).
        const backlog: Buffer[] = [];
        let waiting = 0;
        const flush = () => {
          while (backlog.length > 0) {
            const head = backlog[0] as Buffer;
            const written = Math.max(0, socket.write(head));
            waiting -= written;
            if (written < head.length) {
              backlog[0] = head.subarray(written);
              socket.data.drained = flush;
              return;
            }
            backlog.shift();
          }
        };
        const send = (each: string) => {
          const bytes = Buffer.from(`${each}\n`);
          if (waiting + bytes.length > WATCH_BACKLOG_MAX) {
            this.#watchers.delete(send);
            socket.end();
            return;
          }
          backlog.push(bytes);
          waiting += bytes.length;
          if (backlog.length === 1) flush();
        };
        this.#watchers.add(send);
        socket.data.closed = () => this.#watchers.delete(send);
        send(JSON.stringify({ type: "state", state: this.state() }));
        return;
      }
      case "open":
        await this.#open(request.stream, socket);
        return;
      case "acknowledge": {
        const refused = await this.acknowledge(request.pid, request.server);
        socket.end(
          refused === null ? `ok ${JSON.stringify(this.state())}\n` : `error ${refused}\n`,
        );
        return;
      }
      case "extend": {
        const refused = await this.extend(request.pid, request.minutes, request.server);
        socket.end(
          refused === null ? `ok ${JSON.stringify(this.state())}\n` : `error ${refused}\n`,
        );
        return;
      }
      case "sudo": {
        const refused = await this.sudo(request.pid, request.minutes, request.server);
        socket.end(
          refused === null ? `ok ${JSON.stringify(this.state())}\n` : `error ${refused}\n`,
        );
        return;
      }
      case "allow-folder": {
        const refused = await this.allowFolder(
          request.pid,
          request.id,
          request.write,
          request.server,
        );
        socket.end(
          refused === null ? `ok ${JSON.stringify(this.state())}\n` : `error ${refused}\n`,
        );
        return;
      }
      case "deny-folder": {
        const refused = this.denyFolder(request.id);
        socket.end(
          refused === null ? `ok ${JSON.stringify(this.state())}\n` : `error ${refused}\n`,
        );
        return;
      }
      case "remove-folder": {
        const refused = await this.removeFolder(request.path);
        socket.end(
          refused === null ? `ok ${JSON.stringify(this.state())}\n` : `error ${refused}\n`,
        );
        return;
      }
      case "share-folder": {
        const refused = await this.shareFolder(
          request.pid,
          request.path,
          request.write,
          request.server,
        );
        socket.end(
          refused === null ? `ok ${JSON.stringify(this.state())}\n` : `error ${refused}\n`,
        );
        return;
      }
      case "grant-chat": {
        const refused = await this.grantChat(request.pid, request.chat, request.server);
        socket.end(refused === null ? "ok {}\n" : `error ${refused}\n`);
        return;
      }
    }
  }

  async #open(stream: number, socket: Bun.Socket<ConnectionData>): Promise<void> {
    if (this.#until === null) {
      socket.end("error agent access is off\n");
      return;
    }
    // A timer does not count the time the computer slept: the deadline is checked against the clock too.
    if ((this.#options.now ?? Date.now)() >= this.#until) {
      void this.off();
      socket.end("error agent access is off\n");
      return;
    }
    const changed = this.#snapshot === null ? [] : await changedSince(this.#snapshot);
    if (changed.length > 0) {
      socket.end(`error a startup file changed during this access: ${changed.join(", ")}\n`);
      return;
    }
    const configPath = this.#path(`sshd-${stream}.conf`);
    await writeFile(
      configPath,
      sessionConfig({
        account: this.#options.account,
        hostKey: this.#options.hostKey,
        authorizedKeys: this.#path("authorized_keys"),
        wrapper: this.#options.wrapper,
        sftpServer: this.#options.sftpServer,
        stream,
        recordsSocket: this.recordsSocket,
        logFile: this.#path(`sshd-${stream}.log`),
        ...(this.#options.sshdSession === undefined
          ? {}
          : { sshdSession: this.#options.sshdSession }),
        ...(this.#options.sshdAuth === undefined ? {} : { sshdAuth: this.#options.sshdAuth }),
      }),
      { mode: 0o644 },
    );
    // Off may have come during the awaits above: no session starts after it.
    if (this.#until === null || (this.#options.now ?? Date.now)() >= this.#until) {
      await rm(configPath, { force: true });
      socket.end("error agent access is off\n");
      return;
    }
    const session = this.#options.launcher.start(configPath);
    this.#sessions.add(session);
    this.#openStreams.set(stream, 0);
    socket.write("ok\n");
    // The open sessions are part of the state the person and the app see.
    this.#tell({ type: "state", state: this.state() });
    // The connection's bytes are the session's: in to sshd, and sshd's out to the connection.
    socket.data.raw = (bytes) => session.stdin.write(bytes);
    socket.data.closed = () => session.kill();
    void (async () => {
      const reader = session.stdout.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        let rest = value;
        while (rest.length > 0) {
          const written = socket.write(rest);
          rest = rest.subarray(Math.max(0, written));
          if (rest.length > 0)
            await new Promise<void>((resolve) => (socket.data.drained = resolve));
        }
      }
    })().finally(() => socket.end());
    void session.exited.finally(() => {
      this.#sessions.delete(session);
      this.#openStreams.delete(stream);
      void rm(configPath, { force: true });
      // An ended session while still on (at off, the off state says it).
      if (this.#until !== null) this.#tell({ type: "state", state: this.state() });
    });
  }

  /**
   * One wrapper run's events, from its own connection. The first `start` binds the connection to its run and stream;
   * only a stream with a session now may start a run, a stream at most 16, all streams at most 300 a minute (the server
   * takes 600 records a minute: a start and an end each); every later event must be that run's, and the end is its last.
   * A session runs as the same account as its wrapper, so it can still report its own runs falsely: this keeps it from
   * reporting for other streams, flooding the log or closing the computer's link.
   */
  #record(line: string, socket: Bun.Socket<ConnectionData>): void {
    let event: WrapperEvent;
    try {
      event = WrapperEvent.parse(JSON.parse(line));
    } catch {
      return;
    }
    if (event.type === "ask-folder") {
      this.#ask(event, socket);
      return;
    }
    const bound = socket.data.run;
    if (event.type === "start") {
      const runs = this.#openStreams.get(event.stream);
      const minute = Math.floor((this.#options.now ?? Date.now)() / 60_000);
      if (this.#runsThisMinute.minute !== minute) this.#runsThisMinute = { minute, count: 0 };
      if (bound !== null || runs === undefined || runs >= 16 || this.#runsThisMinute.count >= 300) {
        socket.end();
        return;
      }
      this.#openStreams.set(event.stream, runs + 1);
      this.#runsThisMinute.count += 1;
      socket.data.run = { stream: event.stream, run: event.run };
      // The wrapper runs nothing until this: a refused start runs nothing.
      socket.write("ok\n");
    } else if (bound === null || bound.stream !== event.stream || bound.run !== event.run) {
      socket.end();
      return;
    }
    const held = (bytes: number) =>
      this.#tell({
        type: "wrapper",
        event: {
          type: "output",
          stream: event.stream,
          run: event.run,
          bytes: Buffer.from(
            `\r\n[agent access: ${bytes} bytes of this run's output not shown]\r\n`,
          ).toString("base64"),
        },
      });
    if (event.type === "output") {
      // Shown live, never kept: at most a burst of 1 MB and 256 KB a second a run, so one run cannot bury the others
      // (or the state) in the person's live view. What is held back is said, not shown.
      const shown = this.#shownOutput(socket.data, event.bytes.length);
      if (shown === null) return;
      if (shown > 0) held(shown);
      this.#tell({ type: "wrapper", event });
      return;
    }
    if (event.type === "end" && socket.data.output.held > 0) held(socket.data.output.held);
    // The log keeps what ran and how it ended.
    this.#options.log(JSON.stringify(event));
    this.#tell({ type: "wrapper", event });
    if (event.type === "end") socket.end();
  }

  /**
   * Whether this much output (base64 characters) may be shown now: null when it is held back, else how many bytes held
   * back before it are to be noted (0: none).
   */
  #shownOutput(data: ConnectionData, size: number): number | null {
    const now = (this.#options.now ?? Date.now)();
    const bucket = data.output;
    if (bucket.at === 0) bucket.at = now;
    bucket.tokens = Math.min(
      OUTPUT_BURST,
      bucket.tokens + ((now - bucket.at) / 1000) * OUTPUT_PER_SECOND,
    );
    bucket.at = now;
    if (size > bucket.tokens) {
      bucket.held += Math.floor((size * 3) / 4);
      return null;
    }
    bucket.tokens -= size;
    const held = bucket.held;
    bucket.held = 0;
    return held;
  }

  /**
   * A line-oriented Unix socket: each line goes to `handle`, until a handler takes the connection's raw bytes. With
   * `limits` (the records socket, which sessions reach), at most `connections` at once, and each must bind to a run
   * within `bindMs`: a session cannot hold the guard's connections or memory.
   */
  async #listen(
    path: string,
    handle: (line: string, socket: Bun.Socket<ConnectionData>) => void | Promise<void>,
    limits?: { readonly connections: number; readonly bindMs: number },
  ): Promise<() => void> {
    await rm(path, { force: true });
    let open = 0;
    const listener = Bun.listen<ConnectionData>({
      unix: path,
      socket: {
        open(socket) {
          socket.data = {
            buffer: "",
            decoder: new TextDecoder(),
            raw: null,
            closed: null,
            drained: null,
            run: null,
            counted: false,
            output: { tokens: OUTPUT_BURST, at: 0, held: 0 },
          };
          if (limits === undefined) return;
          if (open >= limits.connections) {
            socket.end();
            return;
          }
          open += 1;
          socket.data.counted = true;
          setTimeout(() => {
            if (socket.data.run === null) socket.end();
          }, limits.bindMs);
        },
        data(socket, chunk) {
          if (socket.data.raw !== null) {
            void socket.data.raw(chunk);
            return;
          }
          socket.data.buffer += socket.data.decoder.decode(chunk, { stream: true });
          for (;;) {
            const newline = socket.data.buffer.indexOf("\n");
            if (newline === -1 || socket.data.raw !== null) break;
            const line = socket.data.buffer.slice(0, newline);
            socket.data.buffer = socket.data.buffer.slice(newline + 1);
            void handle(line, socket);
          }
          // One line longer than any event: not a wrapper's (a chunk may hold several whole lines at once).
          if (socket.data.raw === null && socket.data.buffer.length > 200_000) socket.end();
        },
        drain(socket) {
          // Cleared first: what it calls may wait for the next drain again.
          const drained = socket.data.drained;
          socket.data.drained = null;
          drained?.();
        },
        close(socket) {
          if (socket.data.counted) open -= 1;
          socket.data.closed?.();
        },
      },
    });
    return () => listener.stop(true);
  }
}

interface ConnectionData {
  buffer: string;
  /** The connection's text: a character split across two chunks is kept whole. */
  decoder: TextDecoder;
  raw: ((bytes: Uint8Array) => unknown) | null;
  closed: (() => void) | null;
  drained: (() => void) | null;
  /** The wrapper run this records connection reports (set by its `start`). */
  run: { readonly stream: number; readonly run: string } | null;
  /** Counted against the socket's connection limit. */
  counted: boolean;
  /** How much of the run's output may be shown now (base64 characters), and what was held back (bytes). */
  output: { tokens: number; at: number; held: number };
}

/** A run's output shown live: a burst of about 1 MB, then about 256 KB a second (base64 characters). */
const OUTPUT_BURST = Math.ceil((1_048_576 * 4) / 3);
const OUTPUT_PER_SECOND = Math.ceil((262_144 * 4) / 3);
/** Records connections at once (each wrapper run holds one), and how soon each must start its run. */
const RECORDS_LIMITS = { connections: 128, bindMs: 2_000 } as const;
/** A watcher (the person's agent) further behind than this is dropped; it watches again. */
const WATCH_BACKLOG_MAX = 8 * 1_048_576;
