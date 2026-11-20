/**
 * The app's own notifications (Web Push): a device subscribes with this server's public key and gives the server its
 * push endpoint and keys; the server pushes what needs the person, and tapping the notification opens the app at it,
 * also the iPhone's Home Screen app, which a link from another app never opens.
 */
import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";

/** A push service's address for one device: an https URL. */
const Endpoint = z
  .string()
  .max(2048)
  .regex(/^https:\/\/[^\s/]+\/\S*$/, "A push endpoint is an https address.");

/** A device's subscription as `PushSubscription.toJSON()` gives it, and the name the device goes by. */
export const PushSubscribeArgs = z.strictObject({
  endpoint: Endpoint,
  keys: z.strictObject({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{86,88}={0,2}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22,24}={0,2}$/),
  }),
  device: z.string().min(1).max(80),
});
export type PushSubscribeArgs = z.infer<typeof PushSubscribeArgs>;

/** A subscribed device, without what would let anyone push to it. */
export const PushDevice = z.strictObject({
  /** A short hash of its endpoint. */
  id: z.string().min(1),
  device: z.string().min(1),
  since: z.string().min(1),
});
export type PushDevice = z.infer<typeof PushDevice>;

export const PushDevices = z.strictObject({ devices: z.array(PushDevice) });
export type PushDevices = z.infer<typeof PushDevices>;

export const PushPort = definePort({
  name: "A0.push",
  methods: {
    /** The server's public key, for `PushManager.subscribe({ applicationServerKey })`. */
    key: { args: z.strictObject({}), result: z.strictObject({ publicKey: z.string().min(1) }) },
    devices: { args: z.strictObject({}), result: PushDevices },
    subscribe: { args: PushSubscribeArgs, result: PushDevices },
    /** By the device's endpoint (the page knows its own) or by its id (Settings' list). */
    unsubscribe: {
      args: z.union([
        z.strictObject({ endpoint: Endpoint }),
        z.strictObject({ id: z.string().min(1) }),
      ]),
      result: PushDevices,
    },
    /** A test notification to every device, or to the one with this endpoint. */
    test: {
      args: z.strictObject({ endpoint: Endpoint.optional() }),
      result: z.strictObject({ sent: z.number().int(), failed: z.number().int() }),
    },
    /**
     * A notification to every device, from a program on the server's side (an agent's message to its person):
     * tapping it opens the chat named, else the app.
     */
    send: {
      args: z.strictObject({
        title: z.string().min(1).max(120),
        body: z.string().max(500),
        chat: z.string().min(1).max(100).optional(),
        tag: z.string().min(1).max(100).optional(),
      }),
      result: z.strictObject({ sent: z.number().int(), failed: z.number().int() }),
    },
  },
  events: {},
});
export type PushPort = typeof PushPort;
export type PushClient = PortClient<PushPort>;
export type PushHandlers<Context> = PortHandlers<PushPort, Context>;
