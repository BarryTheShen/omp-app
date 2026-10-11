import { z } from "zod";
import { definePort } from "../../core/envelope";
import { ThreadId } from "../../core/ids";
import { Timestamp } from "./shared";

/** A slash command as typed by the user, including its leading `/`. */
export const SlashCommand = z
  .string()
  .min(2)
  .regex(/^\/\S(?:[\s\S]*)$/, "expected a slash command");
export type SlashCommand = z.infer<typeof SlashCommand>;

export const CommandOutput = z.strictObject({
  text: z.string(),
  emittedAt: Timestamp.optional(),
});
export type CommandOutput = z.infer<typeof CommandOutput>;

export const SessionInfoUpdate = z.strictObject({
  sessionId: ThreadId,
  title: z.string().optional(),
});
export type SessionInfoUpdate = z.infer<typeof SessionInfoUpdate>;

/** Safe model metadata from a config_update; credentials and provider headers are excluded. */
export const CommandModelUpdate = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  provider: z.string().min(1),
  api: z.string().min(1).optional(),
  reasoning: z.boolean().optional(),
});
export type CommandModelUpdate = z.infer<typeof CommandModelUpdate>;

export const ConfigInfoUpdate = z.strictObject({
  model: CommandModelUpdate.optional(),
  thinkingLevel: z
    .enum(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"])
    .optional(),
});
export type ConfigInfoUpdate = z.infer<typeof ConfigInfoUpdate>;

export const CommandRunArgs = z.strictObject({
  threadId: ThreadId,
  command: SlashCommand,
});
export type CommandRunArgs = z.infer<typeof CommandRunArgs>;

/** Aggregates command_output, session_info_update and config_update without conflating settlement. */
export const CommandRunResult = z.strictObject({
  command: SlashCommand,
  status: z.enum(["completed", "aborted"]),
  agentInvoked: z.boolean(),
  /** The `prompt_result.sessionSettled` bit; a later session_settled event is separate. */
  promptSettled: z.boolean(),
  /** True only after the distinct `session_settled` frame has arrived. */
  sessionSettled: z.boolean(),
  outputs: z.array(CommandOutput),
  sessionUpdates: z.array(SessionInfoUpdate),
  configUpdates: z.array(ConfigInfoUpdate),
});
export type CommandRunResult = z.infer<typeof CommandRunResult>;

/**
 * An https URL: the only scheme omp's share viewer and gist links use. It carries no username or password,
 * and no space, control character or backslash.
 */
export const HttpsUrl = z
  .string()
  .url()
  .max(2_048)
  .refine((value) => value.startsWith("https://"), "expected an https URL")
  .refine(
    (value) =>
      ![...value].some(
        (char) => char.charCodeAt(0) <= 0x20 || char.charCodeAt(0) === 0x7f || char === "\\",
      ),
    "expected a URL without spaces, control characters or backslashes",
  )
  .refine(
    (value) => !/^https:\/\/[^/?#]*@/.test(value),
    "expected a URL without a username or password",
  );

/**
 * `/share`'s typed result, read from omp 18.6.1's reply: the viewer link, the gist link when omp made
 * one, and whether omp trimmed the session to fit the share size limit (builtin-collaboration.ts:285-307).
 */
export const ShareResult = z.strictObject({
  url: HttpsUrl,
  gistUrl: HttpsUrl.optional(),
  truncated: z.boolean(),
});
export type ShareResult = z.infer<typeof ShareResult>;

export const ShareCommandArgs = z.strictObject({ threadId: ThreadId });
export type ShareCommandArgs = z.infer<typeof ShareCommandArgs>;

/** `session` runs `/dump`; `all` runs `/dump all` (builtin-collaboration.ts:231-279). */
export const DumpScope = z.enum(["session", "all"]);
export type DumpScope = z.infer<typeof DumpScope>;

export const DumpCommandArgs = z.strictObject({ threadId: ThreadId, scope: DumpScope });
export type DumpCommandArgs = z.infer<typeof DumpCommandArgs>;

/**
 * omp's own dump text for one scope, exactly as omp printed it. The server checks the shape omp 18.6.1
 * prints for that scope and passes the text through unparsed; browser code shows it and never reads it.
 * `empty` is true when omp printed its message for a session with no messages (builtin-collaboration.ts:248,
 * :257), so a caller can say so without a report to save.
 */
export const DumpReport = z.strictObject({
  scope: DumpScope,
  text: z.string().min(1),
  empty: z.boolean(),
});
export type DumpReport = z.infer<typeof DumpReport>;

export const CommandOutputEvent = z.strictObject({
  threadId: ThreadId,
  output: CommandOutput,
});
export type CommandOutputEvent = z.infer<typeof CommandOutputEvent>;

/** The browser window `/browser` switches to (builtin-collaboration.ts:496-531). */
export const BrowserVisibility = z.enum(["headless", "visible"]);
export type BrowserVisibility = z.infer<typeof BrowserVisibility>;

/** The toggles the app sends as `/<mode> on|off`. */
export const ModeChangeToggle = z.enum(["slow", "computer", "extended-context"]);
export type ModeChangeToggle = z.infer<typeof ModeChangeToggle>;

/** Every mode the app changes through an omp command. */
export const ModeChangeMode = z.enum(["slow", "computer", "extended-context", "browser"]);
export type ModeChangeMode = z.infer<typeof ModeChangeMode>;

/** One mode change the app asks omp for: a toggle on or off, or the browser window. */
export const ModeChangeRequest = z.union([
  z.strictObject({ mode: ModeChangeToggle, requested: z.boolean() }),
  z.strictObject({ mode: z.literal("browser"), visibility: BrowserVisibility }),
]);
export type ModeChangeRequest = z.infer<typeof ModeChangeRequest>;

/** Each spelling omp's slash-command grammar takes, with the typed request it stands for. */
const MODE_CHANGE_SPELLINGS: ReadonlyArray<readonly [string, ModeChangeRequest]> = [
  ["/slow on", { mode: "slow", requested: true }],
  ["/slow off", { mode: "slow", requested: false }],
  ["/computer on", { mode: "computer", requested: true }],
  ["/computer off", { mode: "computer", requested: false }],
  ["/extended-context on", { mode: "extended-context", requested: true }],
  ["/extended-context off", { mode: "extended-context", requested: false }],
  ["/browser headless", { mode: "browser", visibility: "headless" }],
  ["/browser visible", { mode: "browser", visibility: "visible" }],
];

/** The command omp runs for a request; the spellings above are the only ones the app sends. */
export function modeChangeCommand(request: ModeChangeRequest): string {
  return request.mode === "browser"
    ? `/browser ${request.visibility}`
    : `/${request.mode} ${request.requested ? "on" : "off"}`;
}

/** The typed request for one of the spellings above, or null for any other text. */
export function modeChangeFromCommand(command: string): ModeChangeRequest | null {
  return MODE_CHANGE_SPELLINGS.find(([spelling]) => spelling === command)?.[1] ?? null;
}

export const ModeChangeArgs = z.strictObject({ threadId: ThreadId, request: ModeChangeRequest });
export type ModeChangeArgs = z.infer<typeof ModeChangeArgs>;

/**
 * Why omp did not make a change, read from its reply. `model-has-no-slow-mode`, `not-in-session` and
 * `not-offered` mean the mode is not available here (unsupported); `claude-usage-limit` and
 * `browser-restart-failed` mean omp tried and the change did not take (refused).
 */
export const ModeUnsupportedReason = z.enum([
  "model-has-no-slow-mode",
  "not-in-session",
  "not-offered",
]);
export type ModeUnsupportedReason = z.infer<typeof ModeUnsupportedReason>;
export const ModeRefusedReason = z.enum(["claude-usage-limit", "browser-restart-failed"]);
export type ModeRefusedReason = z.infer<typeof ModeRefusedReason>;

/**
 * What omp did with one mode change, typed by the server from its reply (A1 gateway/mode-parsers.ts).
 * `applied`: omp made the change. `refused` and `unsupported`: omp said it did not, and why. `unknown`: a
 * reply the server does not recognise. It is never read as applied; the app shows omp's own words as sent
 * (`outputs`), exactly as it did before typed results. The browser shows plain words for every other outcome.
 */
export const ModeChangeResult = z.union([
  z.strictObject({ outcome: z.literal("applied"), mode: ModeChangeToggle, on: z.boolean() }),
  z.strictObject({
    outcome: z.literal("applied"),
    mode: z.literal("browser"),
    visibility: BrowserVisibility,
  }),
  z.strictObject({
    outcome: z.literal("refused"),
    mode: ModeChangeMode,
    reason: ModeRefusedReason,
  }),
  z.strictObject({
    outcome: z.literal("unsupported"),
    mode: ModeChangeMode,
    reason: ModeUnsupportedReason,
  }),
  z.strictObject({
    outcome: z.literal("unknown"),
    mode: ModeChangeMode,
    outputs: z.array(z.string()),
  }),
]);
export type ModeChangeResult = z.infer<typeof ModeChangeResult>;

export const OmpCommandGateway = definePort({
  name: "A1.ompCommandGateway",
  methods: {
    run: {
      args: CommandRunArgs,
      result: CommandRunResult,
      capability: "host.command-gateway",
    },
    share: {
      args: ShareCommandArgs,
      result: ShareResult,
      capability: "host.command-gateway",
    },
    dump: {
      args: DumpCommandArgs,
      result: DumpReport,
      capability: "host.command-gateway",
    },
    modeChange: {
      args: ModeChangeArgs,
      result: ModeChangeResult,
      capability: "host.command-gateway",
    },
  },
  events: {
    output: {
      payload: CommandOutputEvent,
      capability: "host.command-gateway",
    },
  },
});
