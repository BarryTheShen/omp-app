/**
 * One machine's access link, as the server holds it (#20): the challenge the machine signs, its switch's state, the
 * session streams and the records it signs. The machine opened the link; the server can only open streams on it while
 * the machine says it is on, send bytes within each stream's window, and turn it off.
 */
import {
  ACCESS_LIMITS,
  type AccessActivity,
  type AccessState,
  accessChallengeSigningText,
  accessRecordSigningText,
  MachineAccessFrame,
  type ServerAccessFrame,
} from "@omp-app/contracts";
import { ed25519Verifies, newNonce } from "./keys";
import type { SavedMachine } from "./store";

/** Close codes the link ends with. */
export const LINK_CLOSE = {
  badFrame: 4400,
  authFailed: 4401,
  authTimeout: 4408,
  silent: 4409,
  removed: 4410,
  tooMuch: 4429,
} as const;

/** How long the machine has to answer the challenge. */
export const AUTH_WITHIN_MS = 10_000;
/**
 * Once authenticated, a ping every 15 s; a machine not heard from in 45 s is gone (a network that dropped leaves its
 * socket looking open for minutes): its link ends, and it links again when it can.
 */
export const PING_EVERY_MS = 15_000;
export const SILENT_AFTER_MS = 45_000;

/** Where a stream's bytes from the machine go (the `ssh` that asked for it). */
export interface StreamSink {
  /** The machine started the session's sshd: bytes may flow. */
  opened(): void;
  /** Bytes from the machine; the link acknowledges them once this resolves. */
  data(bytes: Uint8Array): void | Promise<void>;
  /** The machine closed the stream, refused it, or the link ended. */
  close(reason: string): void;
}

/** A stream as its `ssh` uses it. */
export interface StreamHandle {
  readonly stream: number;
  /** Sends bytes; resolves once the machine's window has room for them all. */
  write(bytes: Uint8Array): Promise<void>;
  close(): void;
}

export interface LinkDeps {
  readonly send: (frame: ServerAccessFrame) => void;
  readonly close: (code: number, reason: string) => void;
  /** The enrolled machine with this id, or undefined (never enrolled, or removed). */
  readonly machine: (machineId: string) => SavedMachine | undefined;
  /** This server's address, which the machine signs into its answer. */
  readonly serverOrigin: string;
  /** The last record `seq` kept for the machine (0 before any). */
  readonly lastSeq: (machineId: string) => number;
  /** Its verified runs with no end kept yet (started on an earlier link): each may still be finished once. */
  readonly openRuns: (machineId: string) => Iterable<number>;
  readonly onAuthenticated: (link: AccessLink) => void;
  readonly onState: (link: AccessLink) => void;
  readonly onActivity: (link: AccessLink, activity: AccessActivity) => void;
  /** The machine asked to be forgotten (it is being removed from agent access). */
  readonly onLeave: (link: AccessLink) => void;
  readonly now?: () => number;
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}

interface OpenStream {
  readonly sink: StreamSink;
  readonly threadId: string | null;
  /** Bytes sent to the machine not yet acknowledged. */
  unacked: number;
  /** Writes waiting for the window. */
  readonly waiting: { bytes: Uint8Array; done: () => void; failed: (error: Error) => void }[];
  opened: boolean;
}

export class AccessLink {
  #machine: SavedMachine | null = null;
  #state: AccessState = { on: false };
  #reviewPending = false;
  #reach: readonly string[] = [];
  #sessionKey: string | null = null;
  #nonce = "";
  #nextStream = 1;
  readonly #streams = new Map<number, OpenStream>();
  #closed = false;
  #records = { minute: 0, count: 0 };
  #lastSeq = 0;
  /** Records said started (no end yet), here or on an earlier link: each may be finished once, under its own `seq`. */
  readonly #running = new Set<number>();
  readonly #deps: LinkDeps;
  #authTimer: { cancel(): void } | null = null;
  #beatTimer: { cancel(): void } | null = null;
  #heardAt = 0;
  #pings = 0;

  constructor(deps: LinkDeps) {
    this.#deps = deps;
  }

  /** The machine, once its answer to the challenge checked out. */
  get machine(): SavedMachine | null {
    return this.#machine;
  }

  get state(): AccessState {
    return this.#state;
  }

  get reviewPending(): boolean {
    return this.#reviewPending;
  }

  /** What the machine says it can reach while on; empty while off. */
  get reach(): readonly string[] {
    return this.#reach;
  }

  /** The private key the machine made for this turn-on; null while off. Never written to disk. */
  get sessionKey(): string | null {
    return this.#sessionKey;
  }

  /** The link opened: the challenge goes first, and the answer must come in time. */
  start(): void {
    this.#nonce = newNonce();
    this.#deps.send({ type: "challenge", nonce: this.#nonce });
    this.#authTimer = this.#timer(() => {
      if (this.#machine === null) this.#end(LINK_CLOSE.authTimeout, "no answer to the challenge");
    }, AUTH_WITHIN_MS);
  }

  #timer(fn: () => void, ms: number): { cancel(): void } {
    if (this.#deps.setTimer !== undefined) return this.#deps.setTimer(fn, ms);
    const id = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(id) };
  }

  /** The heartbeat: a ping, or the end of a link not heard from. */
  #beat(): void {
    this.#beatTimer = this.#timer(() => {
      if (this.#closed) return;
      if ((this.#deps.now ?? Date.now)() - this.#heardAt > SILENT_AFTER_MS) {
        this.#end(LINK_CLOSE.silent, "the machine went silent");
        return;
      }
      this.#deps.send({ type: "ping", n: this.#pings });
      this.#pings += 1;
      this.#beat();
    }, PING_EVERY_MS);
  }

  /** A frame from the machine. Anything malformed, out of order or over a limit ends the link. */
  receive(text: string): void {
    if (this.#closed) return;
    this.#heardAt = (this.#deps.now ?? Date.now)();
    const fault = this.#take(text);
    if (fault !== undefined) this.#end(fault[0], fault[1]);
  }

  /** Acts on one frame; returns the close code and reason when it must end the link. */
  #take(text: string): readonly [number, string] | undefined {
    let parsed: ReturnType<typeof MachineAccessFrame.safeParse>;
    try {
      parsed = MachineAccessFrame.safeParse(JSON.parse(text));
    } catch {
      return [LINK_CLOSE.badFrame, "not JSON"];
    }
    if (!parsed.success) return [LINK_CLOSE.badFrame, "not a frame"];
    const frame = parsed.data;
    const machine = this.#machine;
    if (machine === null) {
      if (frame.type !== "auth") return [LINK_CLOSE.authFailed, "auth must come first"];
      const known = this.#deps.machine(frame.machineId);
      const signed = accessChallengeSigningText(
        frame.machineId,
        this.#nonce,
        this.#deps.serverOrigin,
      );
      if (known === undefined || !ed25519Verifies(known.identityKey, signed, frame.signature)) {
        return [LINK_CLOSE.authFailed, "the answer did not check out"];
      }
      this.#authTimer?.cancel();
      this.#beat();
      this.#machine = known;
      this.#lastSeq = this.#deps.lastSeq(known.id);
      for (const seq of this.#deps.openRuns(known.id)) this.#running.add(seq);
      this.#deps.onAuthenticated(this);
      return undefined;
    }
    switch (frame.type) {
      case "auth":
        return [LINK_CLOSE.badFrame, "auth twice"];
      case "state": {
        this.#state = frame.state;
        this.#reviewPending = frame.reviewPending;
        if (!frame.state.on) {
          this.#reach = [];
          this.#sessionKey = null;
          this.#closeStreams("access turned off");
        } else if (frame.sessionKey !== undefined) {
          this.#sessionKey = frame.sessionKey;
        }
        if (frame.state.on && frame.reach !== undefined) this.#reach = frame.reach;
        this.#deps.onState(this);
        return undefined;
      }
      case "opened": {
        const stream = this.#streams.get(frame.stream);
        // A stream closed here before the machine said it opened: nothing to do.
        if (stream === undefined) return undefined;
        if (stream.opened) return [LINK_CLOSE.badFrame, "opened twice"];
        stream.opened = true;
        stream.sink.opened();
        this.#flush(frame.stream, stream);
        return undefined;
      }
      case "refused": {
        const stream = this.#streams.get(frame.stream);
        if (stream !== undefined) {
          this.#streams.delete(frame.stream);
          stream.sink.close(`refused: ${frame.reason}`);
        }
        return undefined;
      }
      case "data": {
        const stream = this.#streams.get(frame.stream);
        if (stream === undefined) return undefined;
        const bytes = Buffer.from(frame.bytes, "base64");
        void Promise.resolve(stream.sink.data(bytes)).then(
          () => {
            if (!this.#closed && this.#streams.has(frame.stream) && bytes.length > 0) {
              this.#deps.send({ type: "ack", stream: frame.stream, bytes: bytes.length });
            }
          },
          () => this.closeStream(frame.stream),
        );
        return undefined;
      }
      case "ack": {
        const stream = this.#streams.get(frame.stream);
        if (stream === undefined) return undefined;
        if (frame.bytes > stream.unacked) return [LINK_CLOSE.badFrame, "acknowledged unsent bytes"];
        stream.unacked -= frame.bytes;
        this.#flush(frame.stream, stream);
        return undefined;
      }
      case "close": {
        const stream = this.#streams.get(frame.stream);
        if (stream !== undefined) {
          this.#streams.delete(frame.stream);
          for (const each of stream.waiting) each.failed(new Error("the stream closed"));
          stream.sink.close("closed by the machine");
        }
        return undefined;
      }
      case "pong":
        return undefined;
      case "leave":
        this.#deps.onLeave(this);
        return undefined;
      case "record": {
        const record = frame.record;
        const minute = Math.floor((this.#deps.now ?? Date.now)() / 60_000);
        if (this.#records.minute !== minute) this.#records = { minute, count: 0 };
        this.#records.count += 1;
        if (this.#records.count > ACCESS_LIMITS.recordsPerMinute)
          return [LINK_CLOSE.tooMuch, "too many records"];
        if (record.machineId !== machine.id)
          return [LINK_CLOSE.badFrame, "another machine's record"];
        const { signature, ...signed } = record;
        const verified = ed25519Verifies(
          machine.identityKey,
          accessRecordSigningText(signed),
          signature,
        );
        // A record that does not verify, or that goes back in its count, is kept and shown as unverified: hiding it would
        // hide what ran. A verified one moves the count on; one that started with no end may be finished once, under the
        // same `seq`.
        const fresh = record.seq > this.#lastSeq;
        const finishing = this.#running.has(record.seq) && record.endedAt !== null;
        const inOrder = fresh || finishing;
        if (verified && fresh) {
          this.#lastSeq = record.seq;
          if (record.endedAt === null) this.#running.add(record.seq);
        }
        if (verified && finishing) this.#running.delete(record.seq);
        this.#deps.onActivity(this, {
          record,
          threadId: this.#streams.get(record.stream)?.threadId ?? null,
          verified: verified && inOrder,
        });
        return undefined;
      }
    }
  }

  /**
   * Opens a session stream for an `ssh` (its chat, or null). Refused while the machine is off, has a review pending, or
   * runs the most streams already.
   */
  openStream(threadId: string | null, sink: StreamSink): StreamHandle | string {
    if (this.#machine === null || this.#closed) return "the machine is not connected";
    if (!this.#state.on) return "agent access is off";
    if (this.#reviewPending) return "a review is pending on the machine";
    if (this.#streams.size >= ACCESS_LIMITS.streams) return "too many sessions";
    const stream = this.#nextStream;
    this.#nextStream += 1;
    this.#streams.set(stream, { sink, threadId, unacked: 0, waiting: [], opened: false });
    this.#deps.send({ type: "open", stream, threadId });
    return {
      stream,
      write: (bytes) => this.#write(stream, bytes),
      close: () => this.closeStream(stream),
    };
  }

  closeStream(stream: number): void {
    const open = this.#streams.get(stream);
    if (open === undefined) return;
    this.#streams.delete(stream);
    for (const each of open.waiting) each.failed(new Error("the stream closed"));
    if (!this.#closed) this.#deps.send({ type: "close", stream });
    open.sink.close("closed");
  }

  /** Asks the machine to turn access off now. */
  off(): void {
    if (this.#machine !== null && !this.#closed) this.#deps.send({ type: "off" });
  }

  /** The link ended (the socket closed, or the server ends it): every stream ends with it. */
  ended(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#authTimer?.cancel();
    this.#beatTimer?.cancel();
    this.#sessionKey = null;
    this.#state = { on: false };
    this.#reach = [];
    this.#closeStreams("the machine's link ended");
  }

  /** Ends the link from this side. */
  end(code: number, reason: string): void {
    this.#end(code, reason);
  }

  #end(code: number, reason: string): void {
    if (this.#closed) return;
    this.ended();
    this.#deps.close(code, reason);
  }

  #closeStreams(reason: string): void {
    for (const [stream, open] of [...this.#streams]) {
      this.#streams.delete(stream);
      for (const each of open.waiting) each.failed(new Error(reason));
      open.sink.close(reason);
    }
  }

  #write(stream: number, bytes: Uint8Array): Promise<void> {
    const open = this.#streams.get(stream);
    if (open === undefined || this.#closed) return Promise.reject(new Error("the stream closed"));
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    open.waiting.push({ bytes, done: resolve, failed: reject });
    this.#flush(stream, open);
    return promise;
  }

  /** Sends what waits, in frames of at most the frame's bytes, while the machine's window has room. */
  #flush(stream: number, open: OpenStream): void {
    if (!open.opened) return;
    while (open.waiting.length > 0) {
      const head = open.waiting[0];
      if (head === undefined) break;
      const room = ACCESS_LIMITS.streamWindow - open.unacked;
      if (room <= 0) return;
      const size = Math.min(head.bytes.length, room, ACCESS_LIMITS.frameBytes);
      const chunk = head.bytes.subarray(0, size);
      open.unacked += size;
      this.#deps.send({ type: "data", stream, bytes: Buffer.from(chunk).toString("base64") });
      head.bytes = head.bytes.subarray(size);
      if (head.bytes.length === 0) {
        open.waiting.shift();
        head.done();
      }
    }
  }
}
