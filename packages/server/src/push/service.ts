/**
 * The app's own notifications: the server's VAPID keys and the subscribed devices, kept in one owner-only file
 * (`<app data>/push.json`, the keys made at first use), and sending a notification to every device. A device whose
 * push service says it is gone (404, 410) is dropped.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AppFailure, type PushDevices, PushPort, type PushSubscribeArgs } from "@omp-app/contracts";
import { z } from "zod";
import type { PortHandlerContext, PortRegistration } from "../registry/ports";
import { newVapidKeys, type PushTarget, pushRequest, type VapidKeys } from "./web-push";

/** Who the push services may contact about this server's pushes (VAPID's `sub`: a URL or a mailto). */
const SUBJECT = "https://github.com/BarryTheShen/omp-app";

const StoreFile = z.object({
  version: z.literal(1),
  vapid: z.object({ privatePem: z.string().min(1), publicKey: z.string().min(1) }),
  devices: z.array(
    z.object({
      endpoint: z.string().min(1),
      keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
      device: z.string().min(1),
      since: z.string().min(1),
    }),
  ),
});
type Store = z.infer<typeof StoreFile>;

/** What a notification says and where tapping it leads: a chat by id, or a path in the app. */
export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Opens this chat. */
  readonly chat?: string;
  /** Opens this path of the app (`/`, `/#…`) when no chat is named. */
  readonly path?: string;
  /** Replaces an earlier notification with the same tag on the device (and coalesces at the push service). */
  readonly tag?: string;
}

export interface PushServiceOptions {
  readonly file: string;
  readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
  readonly now?: () => Date;
  readonly log?: (kind: string, fields: Record<string, string | number>) => void;
}

const idOf = (endpoint: string): string =>
  createHash("sha256").update(endpoint).digest("base64url").slice(0, 12);

export class PushService {
  readonly #options: PushServiceOptions;
  readonly #fetch: NonNullable<PushServiceOptions["fetch"]>;
  readonly #now: () => Date;
  /** Every change goes through this chain, so two at once never lose one. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: PushServiceOptions) {
    this.#options = options;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? (() => new Date());
  }

  async #read(): Promise<Store> {
    try {
      return StoreFile.parse(JSON.parse(await readFile(this.#options.file, "utf8")));
    } catch (failure) {
      if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
      const fresh: Store = { version: 1, vapid: newVapidKeys(), devices: [] };
      await this.#write(fresh);
      return fresh;
    }
  }

  async #write(store: Store): Promise<void> {
    await mkdir(dirname(this.#options.file), { recursive: true });
    const temporary = `${this.#options.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#options.file);
  }

  #change<T>(work: (store: Store) => Promise<T> | T): Promise<T> {
    const next = this.#queue.then(async () => work(await this.#read()));
    this.#queue = next.catch(() => undefined);
    return next;
  }

  static #listed(store: Store): PushDevices {
    return {
      devices: store.devices.map((each) => ({
        id: idOf(each.endpoint),
        device: each.device,
        since: each.since,
      })),
    };
  }

  async publicKey(): Promise<string> {
    return (await this.#change((store) => store)).vapid.publicKey;
  }

  devices(): Promise<PushDevices> {
    return this.#change((store) => PushService.#listed(store));
  }

  subscribe(device: PushSubscribeArgs): Promise<PushDevices> {
    return this.#change(async (store) => {
      const others = store.devices.filter((each) => each.endpoint !== device.endpoint);
      const next: Store = {
        ...store,
        devices: [...others, { ...device, since: this.#now().toISOString() }],
      };
      await this.#write(next);
      return PushService.#listed(next);
    });
  }

  unsubscribe(
    which: { readonly endpoint: string } | { readonly id: string },
  ): Promise<PushDevices> {
    return this.#change(async (store) => {
      const keep = store.devices.filter((each) =>
        "endpoint" in which ? each.endpoint !== which.endpoint : idOf(each.endpoint) !== which.id,
      );
      const next: Store = { ...store, devices: keep };
      if (keep.length !== store.devices.length) await this.#write(next);
      return PushService.#listed(next);
    });
  }

  /** Sends `message` to every device (or the one at `endpoint`); returns how many took it and how many did not. */
  async send(message: PushMessage, only?: string): Promise<{ sent: number; failed: number }> {
    const store = await this.#change((current) => current);
    const targets = store.devices.filter((each) => only === undefined || each.endpoint === only);
    const payload = JSON.stringify({
      title: message.title,
      body: message.body,
      ...(message.chat === undefined ? {} : { chat: message.chat }),
      ...(message.path === undefined ? {} : { path: message.path }),
      ...(message.tag === undefined ? {} : { tag: message.tag }),
    });
    const gone: string[] = [];
    let sent = 0;
    await Promise.all(
      targets.map(async (target) => {
        const status = await this.#deliver(target, payload, store.vapid, message.tag);
        if (status >= 200 && status < 300) sent += 1;
        else if (status === 404 || status === 410) gone.push(target.endpoint);
        this.#options.log?.("push.sent", { device: target.device, status });
      }),
    );
    if (gone.length > 0) {
      await this.#change(async (current) => {
        await this.#write({
          ...current,
          devices: current.devices.filter((each) => !gone.includes(each.endpoint)),
        });
      });
    }
    return { sent, failed: targets.length - sent };
  }

  async #deliver(
    target: PushTarget,
    payload: string,
    vapid: VapidKeys,
    tag?: string,
  ): Promise<number> {
    try {
      const request = pushRequest(target, payload, vapid, {
        subject: SUBJECT,
        now: this.#now(),
        ...(tag === undefined
          ? {}
          : { topic: createHash("sha256").update(tag).digest("base64url").slice(0, 32) }),
      });
      const answer = await this.#fetch(request.url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(15_000),
      });
      return answer.status;
    } catch {
      return 0;
    }
  }
}

export function createPushRegistration(push: PushService): PortRegistration {
  const handlers = {
    key: async (_args: unknown, _call: PortHandlerContext) => ({
      publicKey: await push.publicKey(),
    }),
    devices: (_args: unknown, _call: PortHandlerContext) => push.devices(),
    subscribe: (args: unknown, _call: PortHandlerContext) =>
      push.subscribe(args as PushSubscribeArgs),
    unsubscribe: (args: unknown, _call: PortHandlerContext) =>
      push.unsubscribe(args as { endpoint: string } | { id: string }),
    test: async (args: unknown, _call: PortHandlerContext) => {
      const { endpoint } = args as { endpoint?: string };
      const result = await push.send(
        {
          title: "omp app",
          body: "Notifications from this app reach this device. Tap to open it.",
          path: "/",
          tag: "test",
        },
        endpoint,
      );
      if (result.sent === 0 && result.failed === 0) {
        throw new AppFailure({
          code: "not_found",
          message: "No device gets this app's notifications yet.",
          retryable: false,
        });
      }
      return result;
    },
    send: (args: unknown, _call: PortHandlerContext) => push.send(args as PushMessage),
  };
  return { port: PushPort, context: push, handlers };
}
