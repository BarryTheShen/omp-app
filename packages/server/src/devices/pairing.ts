/**
 * Pairing in progress, in memory only: the requests waiting for a paired device to allow them, and the one-time code.
 * Nothing here outlives the server: a device that was asking asks again.
 *
 * A request has a secret only the asking device knows (it collects the key with it) and 6 digits both devices show, so
 * the person allowing it can tell it is theirs. A one-time code is 8 letters and digits; one works at a time, once,
 * for 10 minutes and 5 wrong entries.
 */
import { randomUUID } from "node:crypto";
import {
  type DeviceKind,
  normalizePairingCode,
  PAIRING_CODE_MS,
  PAIRING_CODE_TRIES,
  PAIRING_REQUEST_MS,
  type PairingAsked,
  type PairingRequest,
} from "@omp-app/contracts";
import type { Framing } from "./framing";

/** At most this many requests wait at once; more are refused until one ends. */
export const WAITING_REQUESTS_MAX = 5;
/** The one-time code's letters: no I, O, 0 or 1, which read alike. 32 of them, so each takes 5 random bits. */
const CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

interface Ask {
  readonly id: string;
  readonly secret: string;
  readonly name: string;
  readonly kind: DeviceKind;
  /** Whether the asking page runs in a panel inside another app, and which. */
  readonly framing: Framing;
  readonly code: string;
  readonly requestedAt: number;
  readonly expiresAt: number;
  state: "waiting" | "allowed" | "denied";
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface OneTimeCode {
  readonly code: string;
  readonly expiresAt: number;
  triesLeft: number;
}

export type ClaimResult =
  | { readonly status: "waiting" }
  | {
      readonly status: "allowed";
      readonly name: string;
      readonly kind: DeviceKind;
      readonly framing: Framing;
    }
  | { readonly status: "denied" }
  | { readonly status: "expired" };

export type CodeResult =
  | { readonly status: "ok" }
  | { readonly status: "wrong"; readonly triesLeft: number }
  | { readonly status: "expired" };

export interface PairingDeskOptions {
  readonly now?: () => number;
  readonly randomBytes?: (count: number) => Uint8Array;
  /** The name of a device that paired from the app at an origin before; null when none did. */
  readonly framedBefore?: (framedBy: string) => string | null;
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.byteLength === right.byteLength && crypto.timingSafeEqual(left, right);
}

export class PairingDesk {
  readonly #asks = new Map<string, Ask>();
  readonly #bySecret = new Map<string, Ask>();
  readonly #listeners = new Set<() => void>();
  readonly #now: () => number;
  readonly #randomBytes: (count: number) => Uint8Array;
  readonly #framedBefore: (framedBy: string) => string | null;
  #code: OneTimeCode | undefined;

  constructor(options: PairingDeskOptions = {}) {
    this.#now = options.now ?? Date.now;
    this.#framedBefore = options.framedBefore ?? (() => null);
    this.#randomBytes =
      options.randomBytes ?? ((count) => crypto.getRandomValues(new Uint8Array(count)));
  }

  /** A device asks to pair, from a panel inside another app when `framing` says so; "busy" while as many requests wait as are allowed. */
  ask(name: string, kind: DeviceKind, framing: Framing = {}): PairingAsked | "busy" {
    this.#prune();
    if (this.waiting().length >= WAITING_REQUESTS_MAX) return "busy";
    const now = this.#now();
    const digits = Buffer.from(this.#randomBytes(4)).readUInt32BE(0) % 1_000_000;
    const ask: Ask = {
      id: randomUUID(),
      secret: Buffer.from(this.#randomBytes(32)).toString("base64url"),
      name,
      kind,
      framing,
      code: String(digits).padStart(6, "0"),
      requestedAt: now,
      expiresAt: now + PAIRING_REQUEST_MS,
      state: "waiting",
      timer: undefined,
    };
    // A request that ends unanswered leaves the paired devices' lists by itself.
    ask.timer = setTimeout(() => this.#end(ask), PAIRING_REQUEST_MS);
    ask.timer.unref?.();
    this.#asks.set(ask.id, ask);
    this.#bySecret.set(ask.secret, ask);
    this.#changed();
    return {
      requestId: ask.secret,
      code: ask.code,
      expiresAt: new Date(ask.expiresAt).toISOString(),
    };
  }

  /** Where the asking device's request stands; an allowed or denied one is answered once, then it is gone. */
  claim(secret: string): ClaimResult {
    this.#prune();
    const ask = this.#bySecret.get(secret);
    if (ask === undefined) return { status: "expired" };
    if (ask.state === "waiting") return { status: "waiting" };
    this.#end(ask);
    return ask.state === "allowed"
      ? { status: "allowed", name: ask.name, kind: ask.kind, framing: ask.framing }
      : { status: "denied" };
  }

  /** A paired device allows a request; false when it has ended or was answered. */
  allow(id: string): boolean {
    return this.#answer(id, "allowed");
  }

  /** A paired device turns a request down; false when it has ended or was answered. */
  deny(id: string): boolean {
    return this.#answer(id, "denied");
  }

  /** The requests waiting for an answer, oldest first. */
  waiting(): PairingRequest[] {
    const now = this.#now();
    return [...this.#asks.values()]
      .filter((ask) => ask.state === "waiting" && ask.expiresAt > now)
      .sort((a, b) => a.requestedAt - b.requestedAt)
      .map((ask) => ({
        id: ask.id,
        name: ask.name,
        kind: ask.kind,
        code: ask.code,
        requestedAt: new Date(ask.requestedAt).toISOString(),
        expiresAt: new Date(ask.expiresAt).toISOString(),
        ...ask.framing,
        // Known only for an app whose origin is known: an app that did not say who it is matches none.
        ...(ask.framing.framedBy === undefined
          ? {}
          : { framedBefore: this.#framedBefore(ask.framing.framedBy) }),
      }));
  }

  /** A new one-time code; the one made before stops working. */
  newCode(): { readonly code: string; readonly expiresAt: number } {
    const bytes = this.#randomBytes(8);
    let code = "";
    for (const byte of bytes) code += CODE_LETTERS[byte & 31];
    this.#code = {
      code,
      expiresAt: this.#now() + PAIRING_CODE_MS,
      triesLeft: PAIRING_CODE_TRIES,
    };
    return { code, expiresAt: this.#code.expiresAt };
  }

  /** A code typed on a new device: right once; wrong ones use up its tries. */
  enterCode(typed: string): CodeResult {
    const current = this.#code;
    if (current === undefined || current.expiresAt <= this.#now() || current.triesLeft <= 0) {
      this.#code = undefined;
      return { status: "expired" };
    }
    if (constantTimeEqual(normalizePairingCode(typed), current.code)) {
      this.#code = undefined;
      return { status: "ok" };
    }
    current.triesLeft -= 1;
    if (current.triesLeft <= 0) this.#code = undefined;
    return { status: "wrong", triesLeft: current.triesLeft };
  }

  /** Hears every change to the waiting requests; the returned function stops it. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Ends every request (the server stops). */
  dispose(): void {
    for (const ask of [...this.#asks.values()]) this.#end(ask, false);
  }

  #answer(id: string, state: "allowed" | "denied"): boolean {
    this.#prune();
    const ask = this.#asks.get(id);
    if (ask === undefined || ask.state !== "waiting") return false;
    ask.state = state;
    this.#changed();
    return true;
  }

  #prune(): void {
    const now = this.#now();
    for (const ask of [...this.#asks.values()]) if (ask.expiresAt <= now) this.#end(ask);
  }

  #end(ask: Ask, tell = true): void {
    if (ask.timer !== undefined) clearTimeout(ask.timer);
    const had = this.#asks.delete(ask.id);
    this.#bySecret.delete(ask.secret);
    if (had && tell && ask.state === "waiting") this.#changed();
  }

  #changed(): void {
    for (const listener of this.#listeners) listener();
  }
}
