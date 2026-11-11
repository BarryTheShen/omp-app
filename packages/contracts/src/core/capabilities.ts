/**
 * Capability keys and their status.
 *
 * Rule: a capability is `available` only when the running omp reports it (the chat host's `hello` lists its methods)
 * or a side-effect-free probe confirms it. A version string alone never turns a feature on; features gate on
 * capabilities, not on versions.
 */
import { z } from "zod";
import { CHAT_HOST_METHOD_NAMES, type ChatHostMethodName } from "../chat-host/method-names";

/** omp features that are not a single method. */
export const OMP_FEATURE_CAPABILITIES = [
  /** omp's extension and tool dialogs reach the app (the chat host's `ui.*` requests). */
  "omp.ui",
  /** `set_host_tools` plus the chat host's `tool.call` requests. */
  "omp.host-tools",
  /** `set_host_uri_schemes` plus the chat host's `uri.*` requests. */
  "omp.host-uris",
  /** `subagent_lifecycle` / `subagent_progress` / `subagent_event` events. */
  "omp.subagent-events",
  /** `live_*` methods and events. */
  "omp.live-voice",
] as const;
export type OmpFeatureCapability = (typeof OMP_FEATURE_CAPABILITIES)[number];

/** Lowercase dotted words, each word letters/digits joined by single hyphens: `session-files`. */
const FEATURE_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(?:\.[a-z][a-z0-9]*(?:-[a-z0-9]+)*)*$/;

/**
 * - `omp.cmd.<method>`: one of the chat host's methods (`chat-host/method-names.ts`).
 * - `omp.*` features above.
 * - `host.<feature>`: closed on the server (A1, AP3/AP4).
 * - `client.<feature>`: browser-only behavior (AP5).
 * - `upstream.<feature>`: needs something omp has not shipped (AP6); `unavailable` until it does.
 */
export type CapabilityKey =
  | `omp.cmd.${ChatHostMethodName}`
  | OmpFeatureCapability
  | `host.${string}`
  | `client.${string}`
  | `upstream.${string}`;

export const CapabilityKey: z.ZodType<CapabilityKey> = z.union([
  z.templateLiteral(["omp.cmd.", z.enum(CHAT_HOST_METHOD_NAMES)]),
  z.enum(OMP_FEATURE_CAPABILITIES),
  z.templateLiteral(["host.", z.string().regex(FEATURE_NAME)]),
  z.templateLiteral(["client.", z.string().regex(FEATURE_NAME)]),
  z.templateLiteral(["upstream.", z.string().regex(FEATURE_NAME)]),
]);

/**
 * The shared reasons for D8's unavailable upstream operations. The browser and
 * server both publish these exact strings so a capability's detail cannot drift.
 *
 * omp v18.12.6:
 * - `--goal` seeds a fresh interactive CLI session only; `--print` and `--mode` refuse it
 *   (`packages/coding-agent/src/cli/flag-tables.ts:152-155,380-397`, `packages/coding-agent/src/cli/args.ts:130-139`).
 * - RPC goal operations are get/create/resume/pause/drop; create rejects an already active goal
 *   (`packages/coding-agent/src/modes/rpc/rpc-goal.ts:21-27,250`).
 * - Loop and vibe are `handleTui`-only (`packages/coding-agent/src/slash-commands/builtin-modes.ts:360-373,416-436`);
 *   tan is `handleTui`-only (`packages/coding-agent/src/slash-commands/builtin-lifecycle.ts:463-471`).
 */
export const D8_AP6_UNAVAILABLE_REASONS = {
  "upstream.goal-launch":
    "omp can only open a chat with a goal already set from its terminal. Open the chat first, then set the goal.",
  "upstream.goal-update":
    "omp cannot change an active goal or its budget from here. Drop the goal and set a new one instead.",
  "upstream.loop":
    "The app cannot repeat a prompt automatically; use loop controls in omp's terminal.",
  "upstream.tan-dispatch":
    "Start a side-task worker from omp's terminal; the app cannot start one here.",
  "upstream.vibe-worker":
    "Start persistent workers from omp's terminal; the app cannot start them here.",
} as const satisfies Record<
  | "upstream.goal-launch"
  | "upstream.goal-update"
  | "upstream.loop"
  | "upstream.tan-dispatch"
  | "upstream.vibe-worker",
  string
>;

export const CapabilityState = z.enum(["available", "fallback", "unavailable"]);
export type CapabilityState = z.infer<typeof CapabilityState>;

/** Who provides the capability: omp (through the chat host), the app server, the browser, or (not yet) omp upstream. */
export const CapabilityVia = z.enum(["omp", "host", "client", "upstream"]);
export type CapabilityVia = z.infer<typeof CapabilityVia>;

export const CapabilityStatus = z.object({
  state: CapabilityState,
  via: CapabilityVia,
  /** Why it is a fallback or unavailable, and what the fallback cannot do. */
  detail: z.string().optional(),
});
export type CapabilityStatus = z.infer<typeof CapabilityStatus>;

/**
 * Status per capability; a key that is absent is unknown, which the UI treats as unavailable. A key or a status this
 * build does not know (a newer server's: an update adds the chat host's methods) is left out, not refused. Refused, it
 * failed the whole welcome, and every page opened before the update reconnected every 5 seconds until it was reloaded.
 */
export const CapabilityMap = z
  .record(z.string(), z.unknown())
  .transform((entries): Partial<Record<CapabilityKey, CapabilityStatus>> => {
    const known: Partial<Record<CapabilityKey, CapabilityStatus>> = {};
    for (const [key, value] of Object.entries(entries)) {
      const name = CapabilityKey.safeParse(key);
      const status = CapabilityStatus.safeParse(value);
      if (name.success && status.success) known[name.data] = status.data;
    }
    return known;
  });
export type CapabilityMap = z.output<typeof CapabilityMap>;

/** The capability one of the chat host's methods needs: `omp.cmd.<method>`. */
export function ompCommandCapability(method: ChatHostMethodName): `omp.cmd.${ChatHostMethodName}` {
  return `omp.cmd.${method}`;
}
