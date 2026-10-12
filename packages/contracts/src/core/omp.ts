/**
 * App-facing names over omp's own wire types.
 *
 * Every type here is an alias of, or is built from, `../omp-wire/rpc-wire.generated.ts`, which is
 * copied unchanged from omp (see `../omp-wire/PROVENANCE.md`). The command table mirrors the
 * schema's `x-rpc.commands` (`../omp-wire/rpc-wire.schema.json`); a test keeps the two equal.
 * The protocol itself is described in omp's `docs/rpc.md` at the wire tag.
 */
import type * as Wire from "../omp-wire/rpc-wire.generated";

export type * as OmpWire from "../omp-wire/rpc-wire.generated";

/** The oldest omp release the app supports (PLAN.md, "Open questions"). */
export const OMP_FLOOR_VERSION = "18.6.1";

/** The omp tag the files in `../omp-wire/` were copied from. */
export const OMP_WIRE_TAG = "v18.9.1";

/** The commit `OMP_WIRE_TAG` points at. */
export const OMP_WIRE_COMMIT = "a4d6f0adc63dda4ccdf4d25c26422219820f865b";

/**
 * omp RPC protocol versions the app speaks. omp writes its `ready` frame in protocol 1 and
 * advertises `supportedProtocolVersions: [1, 2]` (docs/rpc.md:43-50 at v18.9.1); the app then
 * sends `negotiate_protocol` for `OMP_PREFERRED_PROTOCOL_VERSION` (lossless `rpc_chunk` framing).
 */
export const OMP_PROTOCOL_VERSIONS = [1, 2] as const;
export type OmpProtocolVersion = (typeof OMP_PROTOCOL_VERSIONS)[number];
export const OMP_PREFERRED_PROTOCOL_VERSION: OmpProtocolVersion = 2;

/** The two RPC process modes (docs/rpc.md:1204-1212 at v18.9.1): `rpc-ui` also forwards tool UI dialogs. */
export const OMP_RPC_MODES = ["rpc", "rpc-ui"] as const;
export type OmpRpcMode = (typeof OMP_RPC_MODES)[number];

export type OmpCommandName = keyof Wire.RpcWireCommands;

export interface OmpCommandSpec {
  /**
   * `"prompt_result"`: the command is complete only when a later `prompt_result` frame with the
   * same `id` arrives (unless its response already says `agentInvoked: false`). `null`: the
   * response completes it. From `x-rpc.commands[].completion`.
   */
  readonly completion: "prompt_result" | null;
  /** Command-specific client timeout from `x-rpc.commands[].timeoutMs`; `null` when omp sets none. */
  readonly timeoutMs: number | null;
}

/** Every omp RPC command at the wire tag, in schema order. */
export const OMP_COMMANDS = {
  negotiate_protocol: { completion: null, timeoutMs: null },
  prompt: { completion: "prompt_result", timeoutMs: null },
  steer: { completion: null, timeoutMs: null },
  follow_up: { completion: null, timeoutMs: null },
  remove_queued_message: { completion: null, timeoutMs: null },
  promote_queued_message: { completion: null, timeoutMs: null },
  abort: { completion: null, timeoutMs: null },
  abort_and_prompt: { completion: "prompt_result", timeoutMs: null },
  abort_and_restore_queue: { completion: null, timeoutMs: null },
  new_session: { completion: null, timeoutMs: null },
  open_session: { completion: null, timeoutMs: null },
  get_state: { completion: null, timeoutMs: null },
  set_fast_mode: { completion: null, timeoutMs: null },
  set_slow_mode: { completion: null, timeoutMs: null },
  goal: { completion: null, timeoutMs: null },
  set_ask_dialog: { completion: null, timeoutMs: null },
  get_available_commands: { completion: null, timeoutMs: null },
  get_entries: { completion: null, timeoutMs: null },
  get_tree: { completion: null, timeoutMs: null },
  set_todos: { completion: null, timeoutMs: null },
  set_host_tools: { completion: null, timeoutMs: null },
  set_host_uri_schemes: { completion: null, timeoutMs: null },
  set_subagent_subscription: { completion: null, timeoutMs: null },
  set_event_filter: { completion: null, timeoutMs: null },
  get_subagents: { completion: null, timeoutMs: null },
  get_subagent_messages: { completion: null, timeoutMs: null },
  cancel_subagent: { completion: null, timeoutMs: null },
  steer_subagent: { completion: null, timeoutMs: null },
  live_start: { completion: null, timeoutMs: null },
  live_stop: { completion: null, timeoutMs: null },
  live_mute: { completion: null, timeoutMs: null },
  set_model: { completion: null, timeoutMs: null },
  cycle_model: { completion: null, timeoutMs: null },
  get_available_models: { completion: null, timeoutMs: null },
  set_thinking_level: { completion: null, timeoutMs: null },
  cycle_thinking_level: { completion: null, timeoutMs: null },
  get_available_thinking_levels: { completion: null, timeoutMs: null },
  set_steering_mode: { completion: null, timeoutMs: null },
  set_follow_up_mode: { completion: null, timeoutMs: null },
  set_interrupt_mode: { completion: null, timeoutMs: null },
  compact: { completion: null, timeoutMs: null },
  set_auto_compaction: { completion: null, timeoutMs: null },
  set_cache_warming: { completion: null, timeoutMs: null },
  set_auto_retry: { completion: null, timeoutMs: null },
  abort_retry: { completion: null, timeoutMs: null },
  bash: { completion: null, timeoutMs: null },
  abort_bash: { completion: null, timeoutMs: null },
  get_session_stats: { completion: null, timeoutMs: null },
  export_html: { completion: null, timeoutMs: null },
  switch_session: { completion: null, timeoutMs: null },
  branch: { completion: null, timeoutMs: null },
  fork: { completion: null, timeoutMs: null },
  get_branch_messages: { completion: null, timeoutMs: null },
  get_last_assistant_text: { completion: null, timeoutMs: null },
  set_session_name: { completion: null, timeoutMs: null },
  handoff: { completion: null, timeoutMs: null },
  get_messages: { completion: null, timeoutMs: null },
  get_messages_page: { completion: null, timeoutMs: null },
  get_login_providers: { completion: null, timeoutMs: null },
  login: { completion: null, timeoutMs: 600000 },
  get_logout_accounts: { completion: null, timeoutMs: null },
  logout: { completion: null, timeoutMs: null },
  predict_word: { completion: null, timeoutMs: 155000 },
  predict_word_feedback: { completion: null, timeoutMs: null },
  btw: { completion: null, timeoutMs: null },
  btw_cancel: { completion: null, timeoutMs: null },
  get_btw_history: { completion: null, timeoutMs: null },
} as const satisfies { readonly [K in OmpCommandName]: OmpCommandSpec };

export const OMP_COMMAND_NAMES = Object.keys(OMP_COMMANDS) as [OmpCommandName, ...OmpCommandName[]];

/** Per command: parameters, successful response `data`, and how completion arrives. */
export type OmpCommandMap = {
  [K in OmpCommandName]: {
    params: Wire.RpcWireCommands[K]["params"];
    result: Wire.RpcWireCommands[K]["result"];
    completion: (typeof OMP_COMMANDS)[K]["completion"];
  };
};

export type OmpCommandParams<K extends OmpCommandName> = OmpCommandMap[K]["params"];
export type OmpCommandResult<K extends OmpCommandName> = OmpCommandMap[K]["result"];

/** A command frame as written to omp's stdin: `{ id?, type, ...params }` (docs/rpc.md, "Command Schema"). */
export type OmpCommand<K extends OmpCommandName = OmpCommandName> = K extends OmpCommandName
  ? { id?: string; type: K } & (OmpCommandParams<K> extends undefined
      ? unknown
      : OmpCommandParams<K>)
  : never;

/** A command response; `data` has the shape of `OmpCommandResult<command>` when `success` is true. */
export type OmpResponse = Wire.RpcResponse;

/** A session event (the schema's `x-rpc.sessionEvent` union). */
export type OmpEvent = Wire.RpcAgentEvent;

/** An unsolicited stdout frame other than host requests (`x-rpc.notification`). */
export type OmpNotification = Wire.RpcNotification;

/** A request omp sends to the host for a host-owned tool or URI scheme. */
export type OmpHostRequest = Wire.RpcHostRequest;

/** Any frame omp writes to stdout once `rpc_chunk` sequences are reassembled (`x-rpc.serverFrame`). */
export type OmpServerFrame = Wire.RpcServerFrame;

/** Any frame the host writes to omp's stdin: a command or an `x-rpc.inbound` frame. */
export type OmpInboundFrame = OmpCommand | Wire.RpcInbound;

/** A transcript message, discriminated by `role`. Messages carry no session entry id; see ids.ts. */
export type OmpMessage = Wire.AgentMessage;

/** Any content block a user, tool result or assistant message can hold. */
export type OmpContentPart = Wire.UserContent | Wire.AssistantContent;
