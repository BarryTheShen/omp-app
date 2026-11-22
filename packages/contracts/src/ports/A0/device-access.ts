/**
 * Agent access to a machine (#20): while its switch is on, an enrolled machine keeps a link open to the server, and the
 * agents reach it with `ssh <alias>` through that link (`ProxyCommand omp-app device-ssh <alias>`). The machine opens
 * the link; the server can never turn access on. Turning on, extending it and granting sudo happen only on the machine,
 * in a window whose content ships with the desktop app or with its `omp-app-device` command, after the system's own
 * password dialog. Pages and the server can only list machines, see what ran, and turn a machine off.
 *
 * Three parts:
 * - **Enrollment** (`DEVICE_ACCESS_PATHS.enroll`): the machine, given a one-time pairing code typed on it, sends its alias,
 *   its identity key and its sshd host key. It keeps the server's https address (the certificate is checked by TLS as
 *   any, not pinned); the server pins its keys.
 * - **The access link** (`DEVICE_ACCESS_PATHS.link`, WebSocket, `AccessFrame`): a challenge the machine signs, then
 *   streams. The server sends only `challenge`, `open`, `data`, `ack`, `close`, `ping` and `off`: no frame turns access
 *   on, extends it or grants sudo.
 * - **The port** (`A0.deviceAccess`): what pages see. Command lines, results and times only: the live terminal stays on
 *   the machine.
 */
import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";

/**
 * A machine's alias, as the agents type it (`ssh laptop`) and the server writes it into its ssh config: lowercase
 * letters, digits and dashes, starting with a letter. Nothing an ssh config reads as a pattern or an option (`*`, `?`,
 * `!`, spaces) can be in it.
 */
export const AccessAlias = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,30}$/)
  .refine((alias) => !RESERVED_ALIASES.has(alias), "a reserved name");
export type AccessAlias = z.infer<typeof AccessAlias>;
/** Names that already mean something to ssh or to a person reading the config. */
const RESERVED_ALIASES = new Set(["localhost", "host", "match", "all", "local", "server"]);

/** A machine's id, given by the server at enrollment. */
export const AccessMachineId = z.string().regex(/^am_[A-Za-z0-9_-]{22}$/);
export type AccessMachineId = z.infer<typeof AccessMachineId>;

/** An Ed25519 public key, 32 bytes in base64url (43 characters). */
export const Ed25519PublicKey = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** An Ed25519 signature, 64 bytes in base64url (86 characters). */
export const Ed25519Signature = z.string().regex(/^[A-Za-z0-9_-]{86}$/);
/** An OpenSSH public key line for an Ed25519 key: `ssh-ed25519 <base64>`, no comment. */
export const SshPublicKey = z.string().regex(/^ssh-ed25519 [A-Za-z0-9+/]{68}$/);

/** Limits every party checks; a frame over them closes the link. */
export const ACCESS_LIMITS = {
  /** Bytes of one `data` frame, before base64. */
  frameBytes: 64 * 1024,
  /** Bytes a side may send on one stream before the other side's `ack`. */
  streamWindow: 256 * 1024,
  /** Streams open at once on one machine. */
  streams: 8,
  /** Characters of a record's command line; longer ones are cut and marked. */
  command: 4_000,
  /** Characters of a record's folder. */
  folder: 1_000,
  /** Records one machine may send per minute; more close the link. */
  recordsPerMinute: 600,
  /** The longest access turns on for at once, and each extension. */
  maxOnMs: 2 * 3_600_000,
  extendMs: 3_600_000,
} as const;

/** What the machine's switch is now, as the machine says. */
export const AccessState = z.discriminatedUnion("on", [
  z.strictObject({ on: z.literal(false) }),
  z.strictObject({
    on: z.literal(true),
    /** ISO time access turns off by itself. */
    until: z.string(),
    /** Sessions open now. */
    sessions: z.number().int().min(0).max(ACCESS_LIMITS.streams),
    /** ISO time a sudo grant ends; null without one. */
    sudoUntil: z.string().nullable(),
  }),
]);
export type AccessState = z.infer<typeof AccessState>;

/** An enrolled machine, as pages list it. */
export const AccessMachine = z.strictObject({
  id: AccessMachineId,
  alias: AccessAlias,
  /** ISO time it enrolled. */
  enrolledAt: z.string(),
  /** ISO time its link last answered; null before its first link. */
  lastSeenAt: z.string().nullable(),
  /** Off unless its link is open now and says on. */
  state: AccessState,
  /** The machine refuses to turn on until the person reviews, on the machine, what changed during the last access. */
  reviewPending: z.boolean(),
  /** What the machine can reach while on, as it says (empty while off). */
  reach: z.array(z.string().max(120)).max(24),
});
export type AccessMachine = z.infer<typeof AccessMachine>;

/** What ran in a session: a command, an interactive shell, a file copy. */
export const AccessRecordKind = z.enum(["command", "shell", "sftp"]);

/**
 * One thing a session ran, as the machine signed it: the command line (the shell's start for an interactive one), when
 * it started and ended, its exit code, whether it used sudo. `seq` counts up from 1 on each machine, so a dropped or
 * replayed record shows. The chat is the one the server opened the stream for. Every string came from the machine: a
 * page shows it as text only.
 */
export const AccessRecord = z.strictObject({
  machineId: AccessMachineId,
  seq: z.number().int().min(1),
  stream: z.number().int().min(1),
  kind: AccessRecordKind,
  command: z.string().max(ACCESS_LIMITS.command),
  folder: z.string().max(ACCESS_LIMITS.folder),
  startedAt: z.string(),
  /** Null while it runs. */
  endedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  sudo: z.boolean(),
  signature: Ed25519Signature,
});
export type AccessRecord = z.infer<typeof AccessRecord>;

/** A record as pages see it: with the chat the server opened its stream for (null outside a chat). */
export const AccessActivity = z.strictObject({
  record: AccessRecord,
  threadId: z.string().nullable(),
  /** The machine's signature checked against its enrolled key. */
  verified: z.boolean(),
});
export type AccessActivity = z.infer<typeof AccessActivity>;

/**
 * The exact text a record's signature covers: a fixed prefix and every field but the signature, in a fixed order, as one
 * JSON array. The machine signs it with its identity key; the server checks it with the key it pinned at enrollment.
 */
export function accessRecordSigningText(record: Omit<AccessRecord, "signature">): string {
  return JSON.stringify([
    "omp-app-access-record-v1",
    record.machineId,
    record.seq,
    record.stream,
    record.kind,
    record.command,
    record.folder,
    record.startedAt,
    record.endedAt,
    record.exitCode,
    record.sudo,
  ]);
}

/** The exact text the machine signs to answer the link's challenge: the server's address pins which server asked. */
export function accessChallengeSigningText(
  machineId: AccessMachineId,
  nonce: string,
  serverOrigin: string,
): string {
  return JSON.stringify(["omp-app-access-link-v1", machineId, nonce, serverOrigin]);
}

/** A stream's bytes in a frame: base64, at most `ACCESS_LIMITS.frameBytes` before encoding. */
const StreamBytes = z
  .string()
  .regex(/^[A-Za-z0-9+/]*={0,2}$/)
  .max(Math.ceil(ACCESS_LIMITS.frameBytes / 3) * 4);
const StreamId = z
  .number()
  .int()
  .min(1)
  .max(2 ** 31 - 1);

/** The frames the server sends the machine. None turns access on, extends it or grants sudo. */
export const ServerAccessFrame = z.discriminatedUnion("type", [
  /** First, on every link: the machine signs `accessChallengeSigningText` with this nonce. */
  z.strictObject({ type: z.literal("challenge"), nonce: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }),
  /**
   * Open a session stream for a chat (null: an `ssh` run outside the app's chats). `chat` is the chat's name, sent only
   * to a machine that keeps chat grants (its state carries `grants`).
   */
  z.strictObject({
    type: z.literal("open"),
    stream: StreamId,
    threadId: z.string().max(200).nullable(),
    chat: z.string().max(120).optional(),
  }),
  /**
   * A chat without a grant tried to reach the machine (no stream was opened): the machine asks its person whether to
   * allow it. Sent only to a machine that keeps chat grants.
   */
  z.strictObject({
    type: z.literal("ask"),
    threadId: z.string().min(1).max(200),
    chat: z.string().max(120),
  }),
  z.strictObject({ type: z.literal("data"), stream: StreamId, bytes: StreamBytes }),
  /** The receiver took this many more bytes of the stream: the sender may send that many more. */
  z.strictObject({ type: z.literal("ack"), stream: StreamId, bytes: z.number().int().min(1) }),
  z.strictObject({ type: z.literal("close"), stream: StreamId }),
  z.strictObject({ type: z.literal("ping"), n: z.number().int().min(0) }),
  /** Turn access off now: sessions end, the link closes. Any paired page may ask it. */
  z.strictObject({ type: z.literal("off") }),
]);
export type ServerAccessFrame = z.infer<typeof ServerAccessFrame>;

/** The frames the machine sends the server. */
export const MachineAccessFrame = z.discriminatedUnion("type", [
  /** The answer to `challenge`: the machine's id and its signature over `accessChallengeSigningText`. */
  z.strictObject({
    type: z.literal("auth"),
    machineId: AccessMachineId,
    signature: Ed25519Signature,
  }),
  /**
   * The switch's state, after `auth` and on every change. On turning on, `sessionKey` is the private half of a key the
   * machine made for this turn-on only (OpenSSH text): its sshd accepts that key until access turns off. The server keeps
   * it only in the user's runtime folder (in memory, never a disk) for its ssh, and removes it at off or when the link
   * ends. `reviewPending`: the machine refuses to turn on until the last access's changes are reviewed on it.
   */
  z.strictObject({
    type: z.literal("state"),
    state: AccessState,
    reviewPending: z.boolean(),
    sessionKey: z.string().max(1_000).optional(),
    /** What the machine can reach while on: networks per interface, summed up on the machine. */
    reach: z.array(z.string().max(120)).max(24).optional(),
    /**
     * The chats the machine's person allowed to reach it (chat ids). A machine that sends it keeps chat grants: the
     * server then opens streams only for these chats and asks the machine for the others.
     */
    grants: z.array(z.string().max(200)).max(500).optional(),
  }),
  /** The stream is open: its sshd runs. */
  z.strictObject({ type: z.literal("opened"), stream: StreamId }),
  /** The stream was not opened, and why (off, too many streams, a review pending). */
  z.strictObject({ type: z.literal("refused"), stream: StreamId, reason: z.string().max(200) }),
  z.strictObject({ type: z.literal("data"), stream: StreamId, bytes: StreamBytes }),
  z.strictObject({ type: z.literal("ack"), stream: StreamId, bytes: z.number().int().min(1) }),
  z.strictObject({ type: z.literal("close"), stream: StreamId }),
  z.strictObject({ type: z.literal("pong"), n: z.number().int().min(0) }),
  /** One thing a session ran, signed (`AccessRecord`). */
  z.strictObject({ type: z.literal("record"), record: AccessRecord }),
  /**
   * The machine is being removed from agent access (`omp-app-device remove`, or Remove in the app): the server forgets
   * it, as Remove in the panel does. Only on an authenticated link, so only the machine's own key can ask it.
   */
  z.strictObject({ type: z.literal("leave") }),
  /**
   * The machine's person turned a chat's request down (a grant shows in `state`'s `grants` instead): the server tells the
   * chat, so it neither waits nor tries again.
   */
  z.strictObject({ type: z.literal("chat-denied"), threadId: z.string().min(1).max(200) }),
  /**
   * The person answered a folder request an agent made from a session (`omp-app-device ask-folder`, which returns at
   * once): the server tells the chat whose stream it was. `at` is where the folder is reached, when allowed.
   */
  z.strictObject({
    type: z.literal("folder-answer"),
    stream: StreamId,
    path: z.string().max(4_096),
    answer: z.enum(["allowed", "denied", "no answer"]),
    at: z.string().max(4_096).optional(),
    write: z.boolean().optional(),
    reason: z.string().max(300).optional(),
  }),
]);
export type MachineAccessFrame = z.infer<typeof MachineAccessFrame>;

/** The routes a machine uses: enrollment (POST, JSON) and the access link (WebSocket). */
export const DEVICE_ACCESS_PATHS = {
  enroll: "/devices/access/enroll",
  link: "/devices/access/link",
} as const;

/**
 * Enrollment, sent by the machine with a one-time pairing code typed on it (Settings → Devices → a new code). The server
 * pins its identity key (signatures) and its sshd host key (the agents' ssh checks it).
 */
export const AccessEnroll = z.strictObject({
  code: z.string().min(1).max(20),
  alias: AccessAlias,
  identityKey: Ed25519PublicKey,
  hostKey: SshPublicKey,
});
export type AccessEnroll = z.infer<typeof AccessEnroll>;

export const AccessEnrolled = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("enrolled"), machineId: AccessMachineId }),
  z.strictObject({
    status: z.literal("refused"),
    reason: z.enum(["code", "alias-taken", "too-many"]),
  }),
]);
export type AccessEnrolled = z.infer<typeof AccessEnrolled>;

const MachineIdArgs = z.strictObject({ machineId: AccessMachineId });

/** What pages see and may do: list, read what ran, turn off, forget a machine. Nothing here turns access on. */
export const DeviceAccessPort = definePort({
  name: "A0.deviceAccess",
  methods: {
    list: {
      args: z.strictObject({}),
      result: z.strictObject({ machines: z.array(AccessMachine) }),
    },
    /** The machine's records, newest first: `before` a `seq` to page back. */
    history: {
      args: z.strictObject({
        machineId: AccessMachineId,
        before: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      }),
      result: z.strictObject({ activity: z.array(AccessActivity) }),
    },
    /** Turns access off now (its sessions end). Any paired page may: off cannot widen access. */
    off: { args: MachineIdArgs, result: z.strictObject({ sent: z.boolean() }) },
    /** Forgets the machine: its keys stop working, its link closes, its history stays readable until removed with it. */
    remove: { args: MachineIdArgs, result: z.strictObject({ machines: z.array(AccessMachine) }) },
  },
  events: {
    changed: { payload: z.strictObject({ machines: z.array(AccessMachine) }) },
    activity: { payload: AccessActivity },
  },
});
export type DeviceAccessPort = typeof DeviceAccessPort;
export type DeviceAccessClient = PortClient<DeviceAccessPort>;
export type DeviceAccessHandlers<Context> = PortHandlers<DeviceAccessPort, Context>;
