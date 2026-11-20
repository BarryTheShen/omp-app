/**
 * `omp-app-device` (#20): the person's agent on a machine. It enrolls the machine with a server, turns access on (the
 * guard asks the person's password), keeps the access link open only while on, relays sessions between the link and the
 * guard, and signs what the guard reports into records for the server. The guard owns the deadline: when it says off,
 * the agent closes the link.
 *
 * Files: `<data>/machine.json` (server, id, alias), `<data>/identity.pem` (the identity key, owner-only), `<data>/seq`
 * (the last record number). A local control socket `<runtime>/agent.sock` (owner-only) serves the desktop app and the
 * CLI: `status`, `on`, `off`, `watch`.
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AccessEnrolled,
  type AccessRecord,
  type AccessState,
  accessRecordSigningText,
  DEVICE_ACCESS_PATHS,
} from "@omp-app/contracts";
import { z } from "zod";
import {
  GUARD_WAIT_MS,
  guardOpen,
  guardRequest,
  guardWatch,
  PASSWORD_WAIT_MS,
  SERVER_NAME,
} from "./guard-client";
import { MachineLink } from "./link";
import { readReach } from "./reach";
import { tellTerminals } from "./terminals";

/** `leave`'s answer for a computer linked to no server: nothing to tell. `omp-app-device remove` says so. */
export const NOT_LINKED = "this computer was not linked to a server";

/** Why the server refused to link this computer, in words the person can act on. */
export function refusalWords(reason: "code" | "alias-taken" | "too-many", alias: string): string {
  switch (reason) {
    case "code":
      return "the server did not accept the one-time code (it was already used, or it expired); try again";
    case "alias-taken":
      return `the server already lists a computer named ${alias}; remove it in that server's Agent access panel, then try again`;
    case "too-many":
      return "the server has reached its limit of linked computers; remove one in its Agent access panel, then try again";
  }
}

const Machine = z.strictObject({
  serverOrigin: z.string().url(),
  machineId: z.string(),
  alias: z.string(),
});
type Machine = z.infer<typeof Machine>;

const GuardStateBody = z.object({
  on: z.boolean(),
  until: z.string().nullable(),
  sessions: z.number(),
  hostKey: z.string(),
  reviewPending: z.boolean(),
  changed: z.array(z.string()),
  removed: z.array(z.string()).default([]),
  sudoUntil: z.string().nullable(),
  /** Agents' folder requests waiting for the person, and the shared folders (PLAN §7d); a guard before them has none. */
  asks: z
    .array(
      z.object({
        id: z.string(),
        path: z.string(),
        write: z.boolean(),
        why: z.string(),
        server: z.string().nullable(),
      }),
    )
    .default([]),
  shared: z
    .array(
      z.object({
        path: z.string(),
        place: z.string(),
        write: z.boolean(),
        server: z.string().nullable(),
        grantedAt: z.string(),
      }),
    )
    .default([]),
});

/** Agents' folder requests waiting for the person, and the folders shared with agents. */
export interface Folders {
  readonly asks: z.infer<typeof GuardStateBody>["asks"];
  readonly shared: z.infer<typeof GuardStateBody>["shared"];
}

/** What the wrapper told the guard, as the guard passes it on. */
const WrapperEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("start"),
    stream: z.number(),
    run: z.string(),
    kind: z.enum(["command", "shell", "sftp"]),
    command: z.string(),
    folder: z.string(),
    startedAt: z.string(),
  }),
  z.object({ type: z.literal("output"), stream: z.number(), run: z.string(), bytes: z.string() }),
  z.object({
    type: z.literal("end"),
    stream: z.number(),
    run: z.string(),
    exitCode: z.number().nullable(),
    endedAt: z.string(),
  }),
]);
type WrapperEvent = z.infer<typeof WrapperEvent>;

export interface AgentOptions {
  readonly dataDir: string;
  readonly runtimeDir: string;
  /** The guard's control socket. */
  readonly guardSocket: string;
  /** A test's WebSocket in place of Bun's. */
  readonly socket?: (url: string) => WebSocket;
  readonly log?: (line: string) => void;
  /** Tells the person's open terminals when a session starts (a machine without a desktop); on by default. */
  readonly tellTerminals?: (text: string) => Promise<unknown>;
  /** What this computer can reach (`readReach`), replaced in tests. */
  readonly readReach?: () => Promise<string[]>;
}

/** What the agent tells its watchers (the desktop window, `omp-app-device watch`). */
export type AgentEvent =
  | { readonly type: "state"; readonly state: AccessState; readonly linked: boolean }
  | { readonly type: "wrapper"; readonly event: WrapperEvent }
  /** Something the person should hear about: sudo allowed, a folder request, the summary when access turns off. */
  | { readonly type: "notice"; readonly text: string }
  | { readonly type: "folders"; readonly folders: Folders };

/** What happened while access was on, for the summary at off. */
interface Tally {
  runs: number;
  shells: number;
  sudo: boolean;
}

/**
 * The summary when access turns off: how much ran, whether sudo was allowed, what the off removed from the agent
 * account, and, after a sudo grant, that the person looks before the next turn-on.
 */
export function summaryText(
  tally: Tally,
  removed: readonly string[],
  reviewPending: boolean,
): string {
  const sessions = `${tally.runs} session${tally.runs === 1 ? "" : "s"}${tally.shells > 0 ? ` (${tally.shells} interactive)` : ""}`;
  let text = `Agent access is off. While on: ${sessions}; ${tally.sudo ? "sudo was allowed" : "no sudo"}.`;
  if (removed.length > 0) {
    const named = removed.slice(0, 5).join(", ") + (removed.length > 5 ? " and more" : "");
    text += ` Removed what the agent account left that could run later: ${named}.`;
  }
  if (reviewPending)
    text +=
      " Sudo was allowed, so changes made as root are not checked: look over the computer, then run omp-app-device acknowledge before turning access on again.";
  return text;
}

export class Agent {
  readonly #options: AgentOptions;
  #machine: Machine | null = null;
  #identity: KeyObject | null = null;
  #state: AccessState = { on: false };
  /** The guard holds the next turn-on until what changed during the last access is looked at. */
  #review: { pending: boolean; changed: readonly string[] } = { pending: false, changed: [] };
  #sessionKey: string | null = null;
  #link: MachineLink | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #retryMs = 1_000;
  #seq = 0;
  /** Records started and not ended, by the wrapper's run. */
  readonly #running = new Map<string, Omit<AccessRecord, "signature">>();
  readonly #watchers = new Set<(event: AgentEvent) => void>();
  #stopWatch: (() => void) | null = null;
  /** Counted from the guard's on to its off; null while off. */
  #tally: Tally | null = null;
  /** The sudo grant already told about. */
  #sudoTold: string | null = null;
  /** What this computer can reach, read when access turned on; empty while off. */
  #reach: readonly string[] = [];
  #folders: Folders = { asks: [], shared: [] };
  /** Folder requests already told about. */
  #asksTold = new Set<string>();

  private constructor(options: AgentOptions) {
    this.#options = options;
  }

  static async open(options: AgentOptions): Promise<Agent> {
    const agent = new Agent(options);
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    await mkdir(options.runtimeDir, { recursive: true, mode: 0o700 });
    const machine = await readFile(join(options.dataDir, "machine.json"), "utf8").catch(() => null);
    if (machine !== null) agent.#machine = Machine.parse(JSON.parse(machine));
    const identity = await readFile(join(options.dataDir, "identity.pem"), "utf8").catch(
      () => null,
    );
    if (identity !== null) agent.#identity = createPrivateKey(identity);
    agent.#seq =
      Number((await readFile(join(options.dataDir, "seq"), "utf8").catch(() => "0")).trim()) || 0;
    return agent;
  }

  get machine(): Machine | null {
    return this.#machine;
  }

  get state(): AccessState {
    return this.#state;
  }

  get linked(): boolean {
    return this.#link?.authenticated ?? false;
  }

  /** Watches the guard: its state (the deadline turns access off there) and what the wrapper reports. */
  async start(): Promise<void> {
    this.#stopped = false;
    this.#stopWatch = await guardWatch(
      this.#options.guardSocket,
      (event) => this.#fromGuard(event),
      () => this.#guardGone(),
    );
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#stopWatch?.();
    this.#closeLink();
  }

  #stopped = false;

  /**
   * Enrolls this machine with a server, given a one-time pairing code made there and the alias the agents will use.
   * The agent then talks to that server only, until it is enrolled again (only while access is off). Returns why not,
   * or null.
   */
  async enroll(
    serverOrigin: string,
    code: string,
    alias: string,
    fetcher: typeof fetch = fetch,
  ): Promise<string | null> {
    let url: URL;
    try {
      url = new URL(serverOrigin);
    } catch {
      return "the server's address must start with https://";
    }
    // Each turn-on's session key goes over this link: never in clear, but to this computer itself (tests).
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      return "the server's address must start with https://";
    const origin = url.origin;
    const guard = await guardRequest(this.#options.guardSocket, { op: "state" });
    if (!guard.ok) return guard.reason;
    const guardState = GuardStateBody.parse(guard.body);
    // A turn-on's session key goes to the server the link opens to: it must stay the one it was turned on for.
    if (guardState.on || this.#state.on) return "turn agent access off first";
    const hostKeyPath = guardState.hostKey;
    const hostKey = (await readFile(`${hostKeyPath}.pub`, "utf8"))
      .trim()
      .split(" ")
      .slice(0, 2)
      .join(" ");
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const identityKey = publicKey.export({ format: "jwk" }).x ?? "";
    let enrolled: z.infer<typeof AccessEnrolled>;
    try {
      const answer = await fetcher(`${origin}${DEVICE_ACCESS_PATHS.enroll}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, alias, identityKey, hostKey }),
        signal: AbortSignal.timeout(20_000),
      });
      enrolled = AccessEnrolled.parse(await answer.json());
    } catch (error) {
      return `the server did not answer as an omp-app server should (${error instanceof Error ? error.message : String(error)})`;
    }
    if (enrolled.status !== "enrolled") return refusalWords(enrolled.reason, alias);
    // Access may have been turned on while the server answered: this enrollment then does not replace the machine.
    const after = await guardRequest(this.#options.guardSocket, { op: "state" });
    if (!after.ok || GuardStateBody.parse(after.body).on || this.#state.on || this.#turningOn > 0)
      return "turn agent access off first";
    await writeFile(
      join(this.#options.dataDir, "identity.pem"),
      privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600 },
    );
    const machine: Machine = { serverOrigin: origin, machineId: enrolled.machineId, alias };
    await writeFile(
      join(this.#options.dataDir, "machine.json"),
      `${JSON.stringify(machine, null, 2)}\n`,
      { mode: 0o600 },
    );
    this.#machine = machine;
    this.#identity = privateKey;
    return null;
  }

  /**
   * Turns access on for `minutes`: a key for this turn-on only, then the guard, which asks the person's password for
   * the process `callerPid` (the desktop window or the terminal asking). Returns why not, or null.
   */
  async on(callerPid: number, minutes: number): Promise<string | null> {
    if (this.#machine === null || this.#identity === null) return "this machine is not enrolled";
    this.#turningOn += 1;
    try {
      return await this.#turnOn(callerPid, minutes);
    } finally {
      this.#turningOn -= 1;
    }
  }

  async #turnOn(callerPid: number, minutes: number): Promise<string | null> {
    const key = this.#sessionKey === null ? await newSessionKey(this.#options.runtimeDir) : null;
    const publicKey = key?.publicKey ?? this.#publicOfSession;
    if (publicKey === null) return "no session key";
    const answer = await guardRequest(
      this.#options.guardSocket,
      { op: "on", pid: callerPid, minutes, publicKey, ...this.#server() },
      PASSWORD_WAIT_MS,
    );
    if (!answer.ok) return answer.reason;
    if (key !== null) {
      this.#sessionKey = key.privateKey;
      this.#publicOfSession = key.publicKey;
    }
    const guard = GuardStateBody.parse(answer.body);
    this.#setState({
      on: true,
      until: guard.until ?? new Date().toISOString(),
      sessions: guard.sessions,
      sudoUntil: null,
    });
    this.#connect();
    return null;
  }

  #publicOfSession: string | null = null;
  /** Turn-ons waiting for the guard (the person's password): the guard says on before they finish. */
  #turningOn = 0;
  /** An off was asked of the guard and it has not said off yet. */
  #stopping = false;

  /**
   * Turns access off. The link goes first, so no new session can start even while the guard is slow to answer (a
   * session may flood it); then the guard ends every session. Its own deadline still holds if it never answers.
   */
  async off(): Promise<void> {
    this.#stopping = true;
    this.#wentOff();
    const answer = await guardRequest(this.#options.guardSocket, { op: "off" }, GUARD_WAIT_MS);
    if (!answer.ok)
      this.#notice(
        `Agent access may still be on at this computer (${answer.reason}): no new session can start, and it ends by itself at its deadline.`,
      );
  }

  /** What changed during the last access, if anything holds the next turn-on. */
  get review(): { readonly pending: boolean; readonly changed: readonly string[] } {
    return this.#review;
  }

  /** Agents' folder requests waiting for the person, and the shared folders, as the guard last said. */
  get folders(): Folders {
    return this.#folders;
  }

  /**
   * The linked server's host, for the guard to name in its password dialog: from this agent's own record of the link,
   * never from whoever asks. Left out when it is not in the letters the guard takes (the dialog then says "omp-app"),
   * so an unusual host name never makes the guard refuse the request.
   */
  #server(): { server?: string } {
    if (this.#machine === null) return {};
    try {
      const host = new URL(this.#machine.serverOrigin).host;
      return host.length <= 260 && SERVER_NAME.test(host) ? { server: host } : {};
    } catch {
      return {};
    }
  }

  /** `minutes` more while on (`callerPid` asks the password). */
  async extend(callerPid: number, minutes: number): Promise<string | null> {
    const answer = await guardRequest(
      this.#options.guardSocket,
      { op: "extend", pid: callerPid, minutes, ...this.#server() },
      PASSWORD_WAIT_MS,
    );
    return answer.ok ? null : answer.reason;
  }

  /**
   * This machine is being removed: the server it is linked to forgets it (a `leave` on the link, which only this
   * machine's key can authenticate; a short link of its own when access is off, as no link is kept then), and this
   * computer's record of the link goes. Returns why the server could not be told (the record goes anyway), or null.
   */
  async leave(): Promise<string | null> {
    const machine = this.#machine;
    const identity = this.#identity;
    if (machine === null || identity === null) return NOT_LINKED;
    const told = await new Promise<string | null>((resolve) => {
      let done = false;
      const finish = (why: string | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        link.close();
        resolve(why);
      };
      const timer = setTimeout(() => finish("the server did not answer within 10 s"), 10_000);
      const link: MachineLink = new MachineLink({
        serverOrigin: machine.serverOrigin,
        machineId: machine.machineId,
        sign: (text) => sign(null, Buffer.from(text, "utf8"), identity).toString("base64url"),
        state: () => ({ state: { on: false }, reviewPending: this.#review.pending }),
        openStream: async () => "this machine is being removed",
        onOff: () => undefined,
        // The server ends the link with "removed" (4410) once it forgot the machine.
        onClosed: (code, reason) =>
          finish(code === 4410 ? null : `the link closed before the server forgot it (${reason})`),
        onAuthenticated: () => {
          if (!link.sendLeave()) finish("the link could not carry the request");
        },
        ...(this.#options.socket === undefined ? {} : { socket: this.#options.socket }),
      });
    });
    // Off first: a link kept while on would go on talking to a server that no longer knows this machine.
    if (this.#state.on) await this.off();
    this.#closeLink();
    await rm(join(this.#options.dataDir, "machine.json"), { force: true });
    await rm(join(this.#options.dataDir, "identity.pem"), { force: true });
    this.#machine = null;
    this.#identity = null;
    return told;
  }

  /** Sudo for the agent account for `minutes` while access is on (`callerPid` asks the password). */
  async sudo(callerPid: number, minutes: number): Promise<string | null> {
    const answer = await guardRequest(
      this.#options.guardSocket,
      { op: "sudo", pid: callerPid, minutes, ...this.#server() },
      PASSWORD_WAIT_MS,
    );
    return answer.ok ? null : answer.reason;
  }

  /** The person looked at what changed (`callerPid` asks the password, as for turning on). */
  async acknowledge(callerPid: number): Promise<string | null> {
    const answer = await guardRequest(
      this.#options.guardSocket,
      { op: "acknowledge", pid: callerPid, ...this.#server() },
      PASSWORD_WAIT_MS,
    );
    return answer.ok ? null : answer.reason;
  }

  /** Allows an agent's folder request (`callerPid` asks the password), to read it or also to change it. */
  async allowFolder(callerPid: number, id: string, write: boolean): Promise<string | null> {
    const answer = await guardRequest(
      this.#options.guardSocket,
      { op: "allow-folder", pid: callerPid, id, write, ...this.#server() },
      PASSWORD_WAIT_MS,
    );
    return answer.ok ? null : answer.reason;
  }

  async denyFolder(id: string): Promise<string | null> {
    const answer = await guardRequest(this.#options.guardSocket, { op: "deny-folder", id });
    return answer.ok ? null : answer.reason;
  }

  /** Stops sharing a folder; unmounted at once. */
  async removeFolder(path: string): Promise<string | null> {
    const answer = await guardRequest(this.#options.guardSocket, { op: "remove-folder", path });
    return answer.ok ? null : answer.reason;
  }

  /** Hears every state change and what each session shows; returns what stops it. */
  watch(listener: (event: AgentEvent) => void): () => void {
    this.#watchers.add(listener);
    listener({ type: "state", state: this.#state, linked: this.linked });
    return () => this.#watchers.delete(listener);
  }

  #tell(event: AgentEvent): void {
    for (const watcher of this.#watchers) watcher(event);
  }

  #notice(text: string): void {
    this.#tell({ type: "notice", text });
    const tell = this.#options.tellTerminals ?? tellTerminals;
    void tell(text);
  }

  /** The guard's requests and shared folders: watchers hear of a change, and the person of each new request. */
  #takeFolders(folders: Folders): void {
    if (JSON.stringify(folders) === JSON.stringify(this.#folders)) return;
    this.#folders = folders;
    this.#tell({ type: "folders", folders });
    for (const ask of folders.asks) {
      if (this.#asksTold.has(ask.id)) continue;
      this.#asksTold.add(ask.id);
      this.#notice(
        `An agent asks to ${ask.write ? "read and change" : "read"} ${ask.path}${ask.why === "" ? "" : `: ${ask.why}`}. Allow or deny it in Agent access.`,
      );
    }
    const waiting = new Set(folders.asks.map((ask) => ask.id));
    for (const id of this.#asksTold) if (!waiting.has(id)) this.#asksTold.delete(id);
  }

  #setState(state: AccessState): void {
    this.#state = state;
    this.#link?.sendState();
    this.#tell({ type: "state", state, linked: this.linked });
  }

  #wentOff(): void {
    this.#sessionKey = null;
    this.#publicOfSession = null;
    // Every session ended with access: a run still open (its wrapper killed with it) ends here, before the link goes.
    this.#endRuns([...this.#running.keys()]);
    this.#reach = [];
    this.#setState({ on: false });
    this.#closeLink();
  }

  #closeLink(): void {
    if (this.#retry !== null) clearTimeout(this.#retry);
    this.#retry = null;
    const link = this.#link;
    this.#link = null;
    link?.close();
  }

  /** Opens the link while on; a dropped link is opened again, waiting longer each time, while access stays on. */
  #connect(): void {
    const machine = this.#machine;
    const identity = this.#identity;
    if (machine === null || identity === null || this.#link !== null || !this.#state.on) return;
    const link: MachineLink = new MachineLink({
      serverOrigin: machine.serverOrigin,
      machineId: machine.machineId,
      sign: (text) => sign(null, Buffer.from(text, "utf8"), identity).toString("base64url"),
      state: () => ({
        state: this.#state,
        reviewPending: this.#review.pending,
        ...(this.#state.on && this.#sessionKey !== null ? { sessionKey: this.#sessionKey } : {}),
        reach: this.#reach,
      }),
      openStream: (stream, handlers) =>
        guardOpen(this.#options.guardSocket, stream, {
          ...handlers,
          close: (reason) => {
            handlers.close(reason);
            // A run whose wrapper was killed with its session (cut off, Turn off) never says it ended: once its own
            // late end has had time to arrive, it ends here, without an exit code. Only the runs open now: a later
            // session may get the same stream number.
            const open = [...this.#running].filter(([, started]) => started.stream === stream);
            setTimeout(() => this.#endRuns(open.map(([run]) => run)), 2_000);
          },
        }),
      onOff: () => void this.off(),
      onClosed: (code, reason) => {
        if (this.#link !== link) return;
        this.#link = null;
        this.#options.log?.(`link closed: ${code} ${reason}`);
        this.#tell({ type: "state", state: this.#state, linked: false });
        if (!this.#state.on) return;
        this.#retry = setTimeout(() => {
          this.#retry = null;
          this.#connect();
        }, this.#retryMs);
        this.#retryMs = Math.min(this.#retryMs * 2, 30_000);
      },
      onAuthenticated: () => {
        // Records made while no link was up (it dropped, or access went off before they ended), oldest first.
        const waiting = this.#unsent.splice(0);
        for (const [at, record] of waiting.entries()) {
          if (!link.sendRecord(record)) {
            this.#unsent.unshift(...waiting.slice(at));
            break;
          }
        }
      },
      ...(this.#options.socket === undefined ? {} : { socket: this.#options.socket }),
    });
    this.#link = link;
    this.#retryMs = 1_000;
  }

  #fromGuard(raw: unknown): void {
    const message = raw as { type?: string; state?: unknown; event?: unknown };
    if (message.type === "state") {
      const state = GuardStateBody.safeParse(message.state);
      if (!state.success) return;
      const review = { pending: state.data.reviewPending, changed: state.data.changed };
      const reviewChanged = review.pending !== this.#review.pending;
      this.#review = review;
      this.#takeFolders({ asks: state.data.asks, shared: state.data.shared });
      if (!state.data.on) this.#stopping = false;
      // On at the guard, but neither on here nor being turned on or off here: this agent restarted while access was on.
      // Nothing here shows or controls that access any more, so it goes off.
      if (state.data.on && !this.#state.on && this.#turningOn === 0 && !this.#stopping) {
        this.#stopping = true;
        this.#notice(
          "Agent access was still on when this computer's agent started again; it is now off. Turn it on again if agents still need it.",
        );
        void guardRequest(this.#options.guardSocket, { op: "off" });
        return;
      }
      if (state.data.on) {
        if (this.#tally === null) {
          this.#tally = { runs: 0, shells: 0, sudo: false };
          // What access opens, for the app's panel: read once per turn-on.
          void (this.#options.readReach ?? readReach)().then((reach) => {
            if (this.#tally === null) return;
            this.#reach = reach;
            this.#link?.sendState();
          });
        }
        const sudoUntil = state.data.sudoUntil;
        if (sudoUntil !== null && sudoUntil !== this.#sudoTold) {
          this.#sudoTold = sudoUntil;
          this.#tally.sudo = true;
          this.#notice(
            `The omp agent account may use sudo on this computer until ${new Date(sudoUntil).toLocaleTimeString()}.`,
          );
        }
      } else if (this.#tally !== null) {
        // The guard's off state carries what changed: one summary per access.
        this.#notice(summaryText(this.#tally, state.data.removed, state.data.reviewPending));
        this.#tally = null;
        this.#sudoTold = null;
      }
      // The guard turned off (its deadline, or a stop): the agent follows.
      if (!state.data.on && this.#state.on) this.#wentOff();
      else if (this.#state.on && state.data.on) {
        // The guard's own state is the truth: its deadline, its sessions, its sudo grant.
        this.#setState({
          on: true,
          until: state.data.until ?? this.#state.until,
          sessions: state.data.sessions,
          sudoUntil: state.data.sudoUntil,
        });
      } else if (reviewChanged) this.#setState(this.#state);
      return;
    }
    if (message.type !== "wrapper") return;
    const parsed = WrapperEvent.safeParse(message.event);
    if (!parsed.success) return;
    const event = parsed.data;
    this.#tell({ type: "wrapper", event });
    if (event.type === "start") {
      this.#startRecord(event);
      if (this.#tally !== null) {
        this.#tally.runs += 1;
        if (event.kind === "shell") this.#tally.shells += 1;
      }
      const tell = this.#options.tellTerminals ?? tellTerminals;
      void tell(
        `omp agent session on this computer: ${event.command.slice(0, 200)} (omp-app-device watch shows it)`,
      );
    }
    if (event.type === "end") this.#endRecord(event);
  }

  #guardGone(): void {
    // Without the guard nothing on this machine can be reached: off.
    if (this.#tally !== null) {
      this.#notice(summaryText(this.#tally, [], false));
      this.#tally = null;
      this.#sudoTold = null;
    }
    if (this.#state.on) this.#wentOff();
    // The guard restarted, or dropped this watch: watch it again (an access it still holds then goes off).
    if (!this.#stopped) setTimeout(() => void this.#watchAgain(), 2_000);
  }

  async #watchAgain(): Promise<void> {
    if (this.#stopped) return;
    try {
      await this.start();
    } catch {
      setTimeout(() => void this.#watchAgain(), 2_000);
    }
  }

  #startRecord(event: Extract<WrapperEvent, { type: "start" }>): void {
    const machine = this.#machine;
    if (machine === null) return;
    this.#seq += 1;
    void writeFile(join(this.#options.dataDir, "seq"), `${this.#seq}\n`, { mode: 0o600 });
    const record: Omit<AccessRecord, "signature"> = {
      machineId: machine.machineId,
      seq: this.#seq,
      stream: event.stream,
      kind: event.kind,
      command: event.command,
      folder: event.folder,
      startedAt: event.startedAt,
      endedAt: null,
      exitCode: null,
      sudo: this.#state.on && this.#state.sudoUntil !== null,
    };
    this.#running.set(event.run, record);
    this.#sendRecord(record);
  }

  #endRecord(event: Extract<WrapperEvent, { type: "end" }>): void {
    const started = this.#running.get(event.run);
    if (started === undefined) return;
    this.#running.delete(event.run);
    this.#sendRecord({ ...started, endedAt: event.endedAt, exitCode: event.exitCode });
  }

  /** Ends these runs if still open, as ended now with no exit code. */
  #endRuns(runs: readonly string[]): void {
    for (const run of runs) {
      const started = this.#running.get(run);
      if (started === undefined) continue;
      this.#running.delete(run);
      this.#sendRecord({ ...started, endedAt: new Date().toISOString(), exitCode: null });
    }
  }

  #sendRecord(record: Omit<AccessRecord, "signature">): void {
    const identity = this.#identity;
    if (identity === null) return;
    const signature = sign(
      null,
      Buffer.from(accessRecordSigningText(record), "utf8"),
      identity,
    ).toString("base64url");
    const signed = { ...record, signature };
    if (this.#link?.sendRecord(signed) === true) return;
    // No link now: kept until the next one, the oldest dropped past 500 (the machine's own log keeps them all).
    this.#unsent.push(signed);
    if (this.#unsent.length > 500) this.#unsent.shift();
  }

  /** Signed records waiting for a link, oldest first. */
  readonly #unsent: AccessRecord[] = [];
}

/** A key pair for one turn-on, made by `ssh-keygen` in an owner-only folder that is removed at once. */
async function newSessionKey(
  runtimeDir: string,
): Promise<{ publicKey: string; privateKey: string }> {
  const folder = await mkdtemp(join(runtimeDir, "key-"));
  try {
    await chmod(folder, 0o700);
    const path = join(folder, "key");
    const made = await Bun.spawn(
      ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "", "-f", path],
      {
        stdout: "ignore",
        stderr: "ignore",
      },
    ).exited;
    if (made !== 0) throw new Error("ssh-keygen failed");
    return {
      publicKey: (await readFile(`${path}.pub`, "utf8")).trim().split(" ").slice(0, 2).join(" "),
      privateKey: await readFile(path, "utf8"),
    };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
