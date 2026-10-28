/**
 * App-facing names for omp: the release the app runs, and omp's own objects (`Omp`, typed from omp's SDK).
 *
 * Until H5.6e2 it also keeps omp's RPC command table, built from `../omp-wire/rpc-wire.generated.ts` (copied unchanged
 * from omp, see `../omp-wire/PROVENANCE.md`) and mirroring the schema's `x-rpc.commands`; the capability keys of omp's
 * commands are still made from its names.
 */
import type * as OmpTypes from "../chat-host/omp-types";
import type * as Wire from "../omp-wire/rpc-wire.generated";

/** omp's own objects, typed from omp's SDK (`../chat-host/omp-types.ts`). */
export type * as Omp from "../chat-host/omp-types";

/**
 * The omp release the app runs and supports: the `@oh-my-pi/pi-coding-agent` version `packages/server/package.json` pins,
 * whose command line the app builds into its chat host and runs, and no other. The contracts package cannot read that file,
 * so `packages/server/src/omp-host/omp-version.test.ts` keeps the two equal.
 */
export const OMP_FLOOR_VERSION = "18.12.6";

/** The omp tag the files in `../omp-wire/` were copied from. */
export const OMP_WIRE_TAG = "v18.12.6";

/** The commit `OMP_WIRE_TAG` points at. */
export const OMP_WIRE_COMMIT = "45c35e40c46166dc726ccc52f5d27f40f2449f99";

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

/** One of omp's session events (`Omp.SessionEvent`). */
export type OmpEvent = OmpTypes.SessionEvent;

/** A transcript message, discriminated by `role` (`Omp.AgentMessage`). Messages carry no session entry id; see ids.ts. */
export type OmpMessage = OmpTypes.AgentMessage;
