/**
 * The machine's side of the access link (#20): it opens the link (the server cannot), signs the server's challenge
 * with the machine's identity key and the server's pinned address, tells the switch's state, and carries each session
 * stream between the server and the guard within each stream's window. A frame the contract refuses ends the link.
 */
import {
  ACCESS_LIMITS,
  type AccessRecord,
  type AccessState,
  accessChallengeSigningText,
  DEVICE_ACCESS_PATHS,
  type MachineAccessFrame,
  ServerAccessFrame,
} from "@omp-app/contracts";
import type { GuardStream } from "./guard-client";

export interface LinkDeps {
  /** The server's address, pinned at enrollment. */
  readonly serverOrigin: string;
  readonly machineId: string;
  /** Signs text with the machine's identity key (base64url). */
  readonly sign: (text: string) => string;
  /** The switch as it is now; `sessionKey` while on. */
  readonly state: () => {
    state: AccessState;
    reviewPending: boolean;
    sessionKey?: string;
    reach?: readonly string[];
  };
  /** Opens a session stream on the guard. */
  readonly openStream: (
    stream: number,
    handlers: { data(bytes: Uint8Array): void; close(reason: string): void },
  ) => Promise<GuardStream | string>;
  /** The server (any paired page) asked access off. */
  readonly onOff: () => void;
  readonly onClosed: (code: number, reason: string) => void;
  /** The server took the machine's answer: what waited for the link may go now. */
  readonly onAuthenticated?: () => void;
  /** Bun's WebSocket by default; a test gives its own. */
  readonly socket?: (url: string) => WebSocket;
}

interface Stream {
  guard: GuardStream | null;
  /** Bytes sent to the server not yet acknowledged. */
  unacked: number;
  /** Bytes from the guard waiting for the window. */
  queue: Uint8Array[];
  paused: boolean;
  /** Bytes from the server written to the guard or waiting to be, not yet acknowledged: at most the stream's window. */
  inbound: number;
  /** The writes to the guard, one after another. */
  writing: Promise<void>;
}

export class MachineLink {
  readonly #deps: LinkDeps;
  readonly #ws: WebSocket;
  #authed = false;
  readonly #streams = new Map<number, Stream>();
  #closed = false;
  /** Streams opened this minute: each starts an sshd as root's child, so a server may not open them without end. */
  #opens = { minute: 0, count: 0 };
  /** When the server was last heard from: it pings every 15 s, so 45 s of silence means the network dropped. */
  #heardAt = Date.now();
  readonly #silence: ReturnType<typeof setInterval>;

  constructor(deps: LinkDeps) {
    this.#deps = deps;
    const url = `${deps.serverOrigin.replace(/^http/, "ws")}${DEVICE_ACCESS_PATHS.link}`;
    this.#ws = deps.socket?.(url) ?? new WebSocket(url);
    this.#ws.addEventListener("message", (event) => {
      this.#heardAt = Date.now();
      this.#receive(String(event.data));
    });
    this.#ws.addEventListener("close", (event) => this.#end(event.code, event.reason));
    this.#ws.addEventListener("error", () => this.#end(1006, "the link failed"));
    this.#silence = setInterval(() => {
      if (Date.now() - this.#heardAt > 45_000) this.#end(4409, "the server went silent");
    }, 5_000);
  }

  get authenticated(): boolean {
    return this.#authed;
  }

  /** Tells the server the switch's state (after a change). */
  sendState(): void {
    if (!this.#authed) return;
    const { state, reviewPending, sessionKey, reach } = this.#deps.state();
    this.#send({
      type: "state",
      state,
      reviewPending,
      ...(sessionKey === undefined ? {} : { sessionKey }),
      ...(state.on && reach !== undefined ? { reach: [...reach] } : {}),
    });
  }

  /** Sends a record; false when the link cannot carry it now (not authenticated, or closed). */
  sendRecord(record: AccessRecord): boolean {
    if (!this.#authed || this.#closed || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#send({ type: "record", record });
    return true;
  }

  /** Asks the server to forget this machine (it is being removed); false when the link cannot carry it now. */
  sendLeave(): boolean {
    if (!this.#authed || this.#closed || this.#ws.readyState !== WebSocket.OPEN) return false;
    this.#send({ type: "leave" });
    return true;
  }

  close(): void {
    this.#end(1000, "closed by the machine");
  }

  #send(frame: MachineAccessFrame): void {
    if (!this.#closed && this.#ws.readyState === WebSocket.OPEN)
      this.#ws.send(JSON.stringify(frame));
  }

  #end(code: number, reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#silence);
    for (const stream of this.#streams.values()) stream.guard?.end();
    this.#streams.clear();
    try {
      this.#ws.close(code === 1006 ? 1000 : code, reason);
    } catch {
      // Already closed.
    }
    this.#deps.onClosed(code, reason);
  }

  #receive(text: string): void {
    let frame: ServerAccessFrame;
    try {
      frame = ServerAccessFrame.parse(JSON.parse(text));
    } catch {
      this.#end(4400, "not a frame");
      return;
    }
    switch (frame.type) {
      case "challenge":
        if (this.#authed) {
          this.#end(4400, "a second challenge");
          return;
        }
        this.#send({
          type: "auth",
          machineId: this.#deps.machineId,
          signature: this.#deps.sign(
            accessChallengeSigningText(this.#deps.machineId, frame.nonce, this.#deps.serverOrigin),
          ),
        });
        this.#authed = true;
        this.sendState();
        this.#deps.onAuthenticated?.();
        return;
      case "open":
        void this.#open(frame.stream);
        return;
      case "data": {
        const stream = this.#streams.get(frame.stream);
        if (stream?.guard == null) return;
        const bytes = Buffer.from(frame.bytes, "base64");
        // The server keeps to the window: past it, it is not a server this machine talks to.
        stream.inbound += bytes.length;
        if (stream.inbound > ACCESS_LIMITS.streamWindow) {
          this.#end(4429, "past the stream's window");
          return;
        }
        const guard = stream.guard;
        stream.writing = stream.writing
          .then(() => guard.write(bytes))
          .then(() => {
            stream.inbound -= bytes.length;
            if (this.#streams.get(frame.stream) === stream && bytes.length > 0) {
              this.#send({ type: "ack", stream: frame.stream, bytes: bytes.length });
            }
          })
          .catch(() => undefined);
        return;
      }
      case "ack": {
        const stream = this.#streams.get(frame.stream);
        if (stream === undefined) return;
        stream.unacked = Math.max(0, stream.unacked - frame.bytes);
        this.#flush(frame.stream, stream);
        return;
      }
      case "close": {
        const stream = this.#streams.get(frame.stream);
        this.#streams.delete(frame.stream);
        stream?.guard?.end();
        return;
      }
      case "ping":
        this.#send({ type: "pong", n: frame.n });
        return;
      case "off":
        this.#deps.onOff();
        return;
    }
  }

  async #open(id: number): Promise<void> {
    const { state, reviewPending } = this.#deps.state();
    if (!state.on)
      return this.#send({ type: "refused", stream: id, reason: "agent access is off" });
    if (reviewPending)
      return this.#send({ type: "refused", stream: id, reason: "a review is pending" });
    if (this.#streams.size >= ACCESS_LIMITS.streams || this.#streams.has(id)) {
      return this.#send({ type: "refused", stream: id, reason: "too many sessions" });
    }
    const minute = Math.floor(Date.now() / 60_000);
    if (this.#opens.minute !== minute) this.#opens = { minute, count: 0 };
    if (this.#opens.count >= 60) {
      return this.#send({ type: "refused", stream: id, reason: "too many sessions this minute" });
    }
    this.#opens.count += 1;
    const stream: Stream = {
      guard: null,
      unacked: 0,
      queue: [],
      paused: false,
      inbound: 0,
      writing: Promise.resolve(),
    };
    this.#streams.set(id, stream);
    const guard = await this.#deps.openStream(id, {
      data: (bytes) => {
        stream.queue.push(bytes.slice());
        this.#flush(id, stream);
      },
      close: () => {
        if (this.#streams.get(id) !== stream) return;
        this.#streams.delete(id);
        this.#send({ type: "close", stream: id });
      },
    });
    if (typeof guard === "string") {
      this.#streams.delete(id);
      return this.#send({ type: "refused", stream: id, reason: guard });
    }
    if (this.#streams.get(id) !== stream) return guard.end();
    stream.guard = guard;
    this.#send({ type: "opened", stream: id });
    this.#flush(id, stream);
  }

  /** The guard's bytes go to the server while the stream's window has room; the guard waits while it has none. */
  #flush(id: number, stream: Stream): void {
    if (stream.guard === null) return;
    while (stream.queue.length > 0) {
      const room = ACCESS_LIMITS.streamWindow - stream.unacked;
      if (room <= 0) break;
      const head = stream.queue[0];
      if (head === undefined) break;
      const size = Math.min(head.length, room, ACCESS_LIMITS.frameBytes);
      this.#send({
        type: "data",
        stream: id,
        bytes: Buffer.from(head.subarray(0, size)).toString("base64"),
      });
      stream.unacked += size;
      if (size === head.length) stream.queue.shift();
      else stream.queue[0] = head.subarray(size);
    }
    const full = stream.queue.length > 0;
    if (full && !stream.paused) stream.guard.pause();
    if (!full && stream.paused) stream.guard.resume();
    stream.paused = full;
  }
}
