/**
 * The chat host protocol, version 1 (SDK plan, module H5: `reassessment/SDK-CHAT-HOST-PLAN.md`, "H5.1 design").
 *
 * A chat host is one chat on omp's SDK in its own process. The server and the host exchange JSON lines over the host's
 * stdin and stdout, one object per line, each with a `kind`:
 * - from the host: `hello` (the first line, once the chat is ready), `response`, and `event`;
 * - from the server: `request`.
 *
 * Every request gets exactly one response with its `id`. Events are numbered `seq` = 1, 2, 3, … in the order the host
 * wrote them, and stdout keeps that order with the responses. omp's own objects (session events, models, images) keep
 * omp's shapes: the server and the host type them from omp's SDK, so this file holds only the envelope, the method names
 * and the app's own payloads.
 */

import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type { AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { calculateTokensPerSecond } from "@oh-my-pi/pi-coding-agent/utils/token-rate";
import type { BtwHistoryRecord } from "@oh-my-pi/pi-tui/overlays/btw-history";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";
import type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
import type { TodoStatus } from "@oh-my-pi/pi-tui/tools/todo";
import { z } from "zod";
import { type ParseResult, parseJson } from "../core/errors";
import type { UiAnsweredEvent, UiEvent } from "./dialogs";
import {
  HostToolUpdateParams,
  SetHostToolsParams,
  SetHostUriSchemesParams,
  type ToolCancelEvent,
  type UriCancelEvent,
} from "./host-tools";
import { type JobDetail, JobIdParams, type JobList, JobsParams } from "./jobs";
import { type LiveEvent, LiveMuteParams, LiveStartParams } from "./live";
import { CHAT_HOST_METHOD_NAMES, type ChatHostMethodName } from "./method-names";
import {
  SteerSubagentParams,
  type SubagentEvent,
  SubagentIdParams,
  SubagentMessagesParams,
  type SubagentSnapshot,
  SubagentSubscriptionParams,
  type SubagentTranscript,
} from "./subagents";

/**
 * omp's session, for the types of its own objects in the protocol (the model, todos, usage, statistics). Type-only:
 * nothing of omp runs where this file is imported.
 */
type Session = AgentSession;

export { CHAT_HOST_CHAT_ARG, CHAT_HOST_SOCKET_ARG } from "./args";
export * from "./dialogs";
export * from "./host-requests";
export * from "./host-tools";
export * from "./jobs";
export * from "./live";
export * from "./subagents";

export const CHAT_HOST_PROTOCOL_VERSION = 1;

const RequestId = z.string().min(1);

/**
 * Why a request failed. Besides the protocol's own, omp's codes the app tells apart: `session_busy` (work could still
 * write into the transcript), `agent_busy` (a prompt came while a turn runs and named no delivery: omp's
 * `AgentBusyError`), `unknown_since` (an entries cursor the session does not have), `stale_cursor` (a message cursor from
 * before the session changed); and plan mode's: `plan_disabled` (omp's `plan.enabled` is off), `goal_active` (a goal
 * runs), `plan_missing` (no plan at that file), `plan_mode_off` (nothing to approve).
 */
export const ChatHostErrorCode = z.enum([
  "unknown_method",
  "invalid_params",
  "failed",
  "session_busy",
  "agent_busy",
  "unknown_since",
  "stale_cursor",
  "plan_disabled",
  "goal_active",
  "plan_missing",
  "plan_mode_off",
]);
export type ChatHostErrorCode = z.infer<typeof ChatHostErrorCode>;

export const ChatHostError = z.object({ code: ChatHostErrorCode, message: z.string() });
export type ChatHostError = z.infer<typeof ChatHostError>;

// Host → server

export const ChatHostHello = z.object({
  kind: z.literal("hello"),
  protocol: z.int(),
  /** The omp release the host was built from. */
  ompVersion: z.string(),
  /** The methods this host answers; a method not listed gets `unknown_method`. */
  methods: z.array(z.string()),
  session: z.object({ id: z.string(), file: z.string().nullable(), cwd: z.string() }),
  /** The host's process id: a server that attached to a running host (D2) can end it when it does not hand back. */
  pid: z.int().optional(),
});
export type ChatHostHello = z.infer<typeof ChatHostHello>;

export const ChatHostResponse = z.union([
  z.object({
    kind: z.literal("response"),
    id: RequestId,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    kind: z.literal("response"),
    id: RequestId,
    ok: z.literal(false),
    error: ChatHostError,
  }),
]);
export type ChatHostResponse = z.infer<typeof ChatHostResponse>;

/** An event object: omp's session event, or one of the app's own (`prompt_result`). Passed on as it is, never copied. */
const EventPayload = z.custom<{ readonly type: string }>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly type?: unknown }).type === "string",
  "expected an object with a string type",
);

export const ChatHostEvent = z.object({
  kind: z.literal("event"),
  seq: z.int().min(1),
  event: EventPayload,
});
/** One event line; `E` is the event type the reader knows (omp's session events and the app's own). */
export interface ChatHostEvent<E extends { readonly type: string } = { readonly type: string }> {
  readonly kind: "event";
  readonly seq: number;
  readonly event: E;
}

/**
 * A request. The server sends the protocol's methods; the host sends its own (`ChatHostHostMethodMap`: the dialogs).
 * Each side answers the other's requests with responses.
 */
export const ChatHostRequest = z.object({
  kind: z.literal("request"),
  id: RequestId,
  method: z.string().min(1),
  params: z.unknown(),
});
export type ChatHostRequest = z.infer<typeof ChatHostRequest>;

export const ChatHostHostLine = z.union([
  ChatHostHello,
  ChatHostResponse,
  ChatHostEvent,
  ChatHostRequest,
]);
export type ChatHostHostLine = ChatHostHello | ChatHostResponse | ChatHostEvent | ChatHostRequest;

/** Parses one line the host wrote. A failure names what is wrong, never the line itself. */
export function parseHostLine(line: string): ParseResult<ChatHostHostLine> {
  return parseJson(ChatHostHostLine, line);
}

// Server → host

export const ChatHostServerLine = z.union([ChatHostRequest, ChatHostResponse]);
export type ChatHostServerLine = ChatHostRequest | ChatHostResponse;

/** Parses one line the server wrote: a request, or an answer to one of the host's. A request's params are checked by `parseChatHostParams`. */
export function parseServerLine(line: string): ParseResult<ChatHostServerLine> {
  return parseJson(ChatHostServerLine, line);
}

// Methods

/** An image the user attached, in omp's shape (`ImageContent`): base64 data and its media type. */
export const ChatHostImage = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string(),
});
export type ChatHostImage = z.infer<typeof ChatHostImage>;

export const PromptParams = z.object({
  text: z.string(),
  images: z.array(ChatHostImage).optional(),
  /** How a prompt sent while a reply streams is queued; without it, such a prompt fails as busy, as in omp. */
  streamingBehavior: z.enum(["steer", "followUp"]).optional(),
});
export type PromptParams = z.infer<typeof PromptParams>;

/** `steer` and `follow_up`: a message for one of omp's two queues, as `prompt` takes it. */
export const QueuedInputParams = PromptParams.omit({ streamingBehavior: true });
export type QueuedInputParams = z.infer<typeof QueuedInputParams>;

/**
 * The answer to `prompt`, sent once omp admitted the prompt. With `resultFollows`, exactly one `prompt_result` event
 * with this request's id follows; without it, the prompt was handled where it stood (an extension's input hook took it,
 * a built-in command answered it, or it was empty) and nothing follows.
 */
export interface PromptAnswer {
  readonly resultFollows: boolean;
}

export const EmptyParams = z.object({});
export type EmptyParams = z.infer<typeof EmptyParams>;

/** How `message_update` events are sent: `full` carries the reply so far (`partial`), `delta` only the increment. */
export const EventOptions = z.object({ messageUpdates: z.enum(["full", "delta"]) });
export type EventOptions = z.infer<typeof EventOptions>;

/** The chat's pause (omp's `agentPauseGate`): when it began, epoch ms, or null while the chat runs. */
export interface PauseState {
  readonly pausedAt: number | null;
}

/**
 * The chat's state, read with `get_state`: omp's own fields, as omp's session reports them. A field omp leaves undefined
 * is absent, as in omp's JSON.
 */
export interface ChatHostState {
  readonly model?: NonNullable<Session["model"]>;
  readonly thinkingLevel?: NonNullable<Session["thinkingLevel"]>;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly steeringMode: Session["steeringMode"];
  readonly followUpMode: Session["followUpMode"];
  readonly interruptMode: Session["interruptMode"];
  readonly sessionId: string;
  /** Absent for a chat that is not saved. */
  readonly sessionFile?: string;
  readonly sessionName?: string;
  readonly autoCompactionEnabled: boolean;
  readonly messageCount: number;
  readonly queuedMessageCount: number;
  /** Background jobs or deliveries can still wake the session. */
  readonly hasPendingAsyncWork: boolean;
  /** Idle, nothing queued or admitted, nothing pending (omp's settle predicate). */
  readonly isSettled: boolean;
  readonly queuedMessages: ReturnType<Session["getQueuedMessages"]>;
  readonly todoPhases: ReturnType<Session["getTodoPhases"]>;
  readonly fastModeEnabled: boolean;
  readonly fastModeActive: boolean;
  readonly tokensPerSecond: ReturnType<typeof calculateTokensPerSecond>;
  readonly slowModeSupported: boolean;
  readonly slowModeEnabled: boolean;
  readonly slowModeScope?: NonNullable<ReturnType<Session["getSlowModeScope"]>>;
  readonly usageLimit?: NonNullable<ReturnType<Session["getUsageLimitState"]>>;
  readonly systemPrompt: Session["systemPrompt"];
  /** The session's tools as omp describes them for a session dump. */
  readonly dumpTools: readonly ChatHostToolDescriptor[];
  readonly contextUsage?: NonNullable<ReturnType<Session["getContextUsage"]>>;
  /** null when the chat has no goal. */
  readonly goal: NonNullable<ReturnType<Session["getGoalModeState"]>> | null;
  /** The app's field, not omp's: when the chat's pause began (epoch ms); absent while it runs. */
  readonly pausedAt?: number;
}

export interface ChatHostToolDescriptor {
  readonly name: string;
  readonly description: string;
  /** The tool's parameters as the provider sees them (omp's `toolWireSchema`). */
  readonly parameters: unknown;
  readonly examples?: unknown;
}

export const SetModelParams = z.object({ provider: z.string().min(1), modelId: z.string().min(1) });
export type SetModelParams = z.infer<typeof SetModelParams>;

export const CycleRoleModelsParams = z.object({ direction: z.enum(["forward", "backward"]) });
export type CycleRoleModelsParams = z.infer<typeof CycleRoleModelsParams>;

export const UseRoleModelParams = z.object({ role: z.string().min(1) });
export type UseRoleModelParams = z.infer<typeof UseRoleModelParams>;

export const BtwParams = z.object({
  question: z.string().min(1),
  recordId: z.string().min(1).optional(),
});
export type BtwParams = z.infer<typeof BtwParams>;

export const BtwCancelParams = z.object({ recordId: z.string().min(1).optional() });
export type BtwCancelParams = z.infer<typeof BtwCancelParams>;

/** A role's model as omp resolves it for Ctrl+P (`getRoleModelCycle`): `smol`, `default`, `slow` or one of the user's. */
export interface RoleModel {
  readonly role: string;
  readonly provider: string;
  readonly modelId: string;
  /** The model's display name. */
  readonly name: string;
  /** The thinking level the role names (`slow: provider/model:high`), which a switch to it applies; null for none. */
  readonly thinkingLevel: string | null;
}

/**
 * The thinking levels omp's session takes (`ConfiguredThinkingLevel`: omp's `ThinkingLevel` and `auto`), by name. The
 * mapped type makes a level omp adds or drops fail the typecheck here.
 */
const THINKING_LEVELS: { readonly [Level in `${ConfiguredThinkingLevel}`]: Level } = {
  inherit: "inherit",
  off: "off",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
  auto: "auto",
};

export const ThinkingLevelParams = z.object({ level: z.enum(THINKING_LEVELS) });
export type ThinkingLevelParams = z.infer<typeof ThinkingLevelParams>;

/** Where a role's setting is kept when omp's `modelRoleStorage` is `project`: omp's `ModelRoleSelectionScope`. */
export const ModelRoleScope = z.enum(["global", "project"]);
export type ModelRoleScope = z.infer<typeof ModelRoleScope>;

export const AssignModelRoleParams = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  role: z.string().min(1),
  thinkingLevel: z.enum(THINKING_LEVELS).optional(),
  scope: ModelRoleScope.optional(),
});
export type AssignModelRoleParams = z.infer<typeof AssignModelRoleParams>;

export const ClearModelRoleParams = z.object({
  role: z.string().min(1),
  scope: ModelRoleScope.optional(),
});
export type ClearModelRoleParams = z.infer<typeof ClearModelRoleParams>;

/**
 * A role's fallback chain (#2838), as omp's model hub sets it (`onFallbackChainChange`): the models omp's retry falls
 * back to, in order, when the role's model fails (`retry.fallbackChains[role]`). An empty chain clears it.
 */
export const SetRoleFallbacksParams = z.object({
  role: z.string().min(1),
  chain: z.array(z.string().min(1)).max(32),
});
export type SetRoleFallbacksParams = z.infer<typeof SetRoleFallbacksParams>;

/**
 * A model preset by name (#2838): omp's named snapshot of the role assignments and the default thinking level
 * (`modelPresets.<name>`). A name is a letter, then letters, digits, `-` or `_`.
 */
export const ModelPresetParams = z.object({ name: z.string().min(1).max(64) });
export type ModelPresetParams = z.infer<typeof ModelPresetParams>;

/**
 * A model's own compaction limit (#2838), as omp's model hub edits it: `input` is the typed text, a token base the
 * compaction policy scales (`400k`), a fixed trigger (`f400k`), a percentage of the window (`80%`), or empty to remove
 * the model's own entry. `confirmed` acknowledges omp's warning for a limit that opens the model's extended window.
 */
export const CompactionPointParams = z.object({
  provider: z.string().min(1),
  modelId: z.string().min(1),
  input: z.string().max(64),
  confirmed: z.boolean().optional(),
});
export type CompactionPointParams = z.infer<typeof CompactionPointParams>;

/** Where auto-compaction triggers for one model, as omp's model hub shows it (`describeModelCompactionPoint`). */
export interface HubCompactionPoint {
  /** Context tokens that trigger auto-compaction; null when auto-compaction is off or the window is unknown. */
  readonly tokens: number | null;
  /** Why it triggers there, in omp's words: `fixed`, `85% of 400K base`, `80% of window`; null with no tokens. */
  readonly basis: string | null;
  /** What sets it: the model's own `provider/id` entry, another matching `compaction.modelThresholds` key, `global` or `default`. */
  readonly source: string;
  /** The model's own entry as one types it (`90k`, `f400k`, `80%`); null when it has none. */
  readonly draft: string | null;
}

/** One role of omp's model hub. */
export interface HubRole {
  readonly role: string;
  /** omp's short label for the role (`getRoleInfo(role).tag`); null when it has none. */
  readonly tag: string | null;
  readonly name: string;
  /** omp's hub lists chat roles first and the kinds of runner (image, search, judge, …) after. */
  readonly section: "chat" | "kind";
  /** The role's setting as omp reads it (`provider/id`, with `:level` when it names one); null when unset. */
  readonly value: string | null;
  /** Which settings layer the value comes from: `runtime`, `overlay`, `project`, `global` or `default`. */
  readonly provenance: string;
  /** The model the role resolves to, from its value or, when it has none, omp's auto-selection; null when none fits. */
  readonly model: {
    readonly provider: string;
    readonly modelId: string;
    readonly name: string;
  } | null;
  /** The thinking level the role applies (`inherit` where it names none); null when the role has no model. */
  readonly thinkingLevel: string | null;
  /** True when `model` is omp's auto-selection, not the role's setting. */
  readonly autoSelected: boolean;
  /**
   * The models omp's retry falls back to when the role's model fails, in order (`retry.fallbackChains[role]`): model
   * selectors, `provider/id` with `:level` where one names it, or `provider/*` (#2838).
   */
  readonly fallbacks: readonly string[];
}

/** One model of omp's model hub. */
export interface HubModel {
  readonly provider: string;
  readonly modelId: string;
  readonly name: string;
  readonly contextWindow: number | null;
  readonly reasoning: boolean;
  /**
   * The thinking levels a role assignment can apply to the model (omp's hub offers these and no others): none for a
   * model that does not reason; `inherit`, `off`, its efforts, and `auto` where its reasoning surface is verified.
   */
  readonly thinkingLevels: readonly string[];
  /** The roles that accept the model (omp's `getRoleInfo(role).accepts`). */
  readonly roles: readonly string[];
  /** Where auto-compaction triggers for the model (#2838); absent from hosts before it. */
  readonly compaction?: HubCompactionPoint;
}

/** What omp's model hub shows. */
export interface ModelHub {
  /** omp's `modelRoleStorage` setting: where a role's setting is written when assigned. */
  readonly storage: "global" | "project";
  /** The live chat's model. */
  readonly current: { readonly provider: string; readonly modelId: string } | null;
  /** In omp's order: its chat roles, then the kinds of runner, then roles of the user's own. */
  readonly roles: readonly HubRole[];
  /** The models a role can be given, in the hub's order: those with a role first, then the most recently used. */
  readonly models: readonly HubModel[];
  /**
   * omp's model presets (#2838), by name, and the one the current role assignments match (`findActiveModelPreset`);
   * null when they match none.
   */
  readonly presets: { readonly names: readonly string[]; readonly active: string | null };
}

/** One model of the chat's model menu, as omp names it. */
export interface MenuModel {
  readonly provider: string;
  readonly modelId: string;
  readonly name: string;
}

/** What the chat's model menu lists. */
export interface ModelMenu {
  /**
   * omp's available models in its model browser's order without the role and recently-used steps: by provider, then
   * omp's priority, then the newest version first (`sortModelItems` with `skipRoleRank` and no recent order).
   */
  readonly models: readonly MenuModel[];
  /** The models omp used most recently, newest first, as `provider/id` (omp's own history, as its model browser reads it). */
  readonly recent: readonly string[];
}

export const EnabledParams = z.object({ enabled: z.boolean() });
export type EnabledParams = z.infer<typeof EnabledParams>;

/**
 * omp's queue modes (how many queued messages one delivery takes) and interrupt modes, by name. The mapped types make a
 * mode omp adds or drops fail the typecheck here.
 */
const STEERING_MODES: { readonly [Mode in Session["steeringMode"]]: Mode } = {
  all: "all",
  "one-at-a-time": "one-at-a-time",
};
const FOLLOW_UP_MODES: { readonly [Mode in Session["followUpMode"]]: Mode } = {
  all: "all",
  "one-at-a-time": "one-at-a-time",
};
const INTERRUPT_MODES: { readonly [Mode in Session["interruptMode"]]: Mode } = {
  immediate: "immediate",
  wait: "wait",
};

export const SteeringModeParams = z.object({ mode: z.enum(STEERING_MODES) });
export type SteeringModeParams = z.infer<typeof SteeringModeParams>;
export const FollowUpModeParams = z.object({ mode: z.enum(FOLLOW_UP_MODES) });
export type FollowUpModeParams = z.infer<typeof FollowUpModeParams>;
export const InterruptModeParams = z.object({ mode: z.enum(INTERRUPT_MODES) });
export type InterruptModeParams = z.infer<typeof InterruptModeParams>;

/** `compact` and `handoff`: optional instructions for the summary. */
export const CustomInstructionsParams = z.object({ customInstructions: z.string().optional() });
export type CustomInstructionsParams = z.infer<typeof CustomInstructionsParams>;

export const SessionNameParams = z.object({ name: z.string() });
export type SessionNameParams = z.infer<typeof SessionNameParams>;

export const ExportHtmlParams = z.object({ outputPath: z.string().optional() });
export type ExportHtmlParams = z.infer<typeof ExportHtmlParams>;

export const LoginParams = z.object({ providerId: z.string().min(1) });
export type LoginParams = z.infer<typeof LoginParams>;

/** What `login` answers: the provider, and whether the sign-in was cancelled (its question, or `cancel_sign_in`). */
export interface LoginResult {
  readonly providerId: string;
  readonly cancelled: boolean;
}

/** `mcp_reauth`: an MCP server to sign in to again, by its name in omp's MCP config (#2779 D6.2). */
export const McpReauthParams = z.object({ name: z.string().min(1).max(100) });
export type McpReauthParams = z.infer<typeof McpReauthParams>;

/**
 * What `mcp_reauth` answers: the server's connection once it is signed in again (null when omp runs no such server, or
 * the sign-in was cancelled), and whether it was cancelled.
 */
export interface McpReauthResult {
  readonly name: string;
  readonly status: "connected" | "connecting" | "disconnected" | null;
  readonly cancelled: boolean;
}

/**
 * The question a sign-in asks when omp waits for its answer on its own computer, which the device's browser cannot
 * reach (an MCP server's, and a provider's that returns to `localhost`): the address that browser ends on is pasted back.
 */
export const SIGN_IN_ADDRESS_PROMPT =
  "After you sign in, your browser shows a page that cannot load. Paste its address here.";

/** One of omp's sign-in providers, and whether a sign-in for it is stored. */
export interface LoginProvider {
  readonly id: string;
  readonly name: string;
  readonly available: boolean;
  readonly authenticated: boolean;
}

export const LogoutAccountParams = z.object({
  providerId: z.string().min(1),
  credentialId: z.number().int(),
});
export type LogoutAccountParams = z.infer<typeof LogoutAccountParams>;

/** One account omp stores for a provider, as omp's `/logout` lists it. */
export interface ProviderAccount {
  /** omp's number for the stored credential, which signing out names. */
  readonly credentialId: number;
  /** Who it is: the account's email, account id or project, with its organization when two share one email. */
  readonly label: string;
  /** omp's longer line: the email, account and project, and the credential's number. */
  readonly detail: string;
  readonly kind: "oauth" | "api_key";
  /** The account this chat's requests use now. */
  readonly active: boolean;
}

/**
 * Where a provider's sign-in comes from when no stored account gives it: omp's `--api-key`, a key in omp's
 * models.yml, or an environment variable (`envVar`, when one variable holds it).
 */
export interface ProviderAuthSource {
  readonly kind: "runtime" | "config" | "env";
  readonly envVar?: string;
}

/** A provider's stored accounts, the one in use first, and another source of its sign-in when there is one. */
export interface ProviderAccounts {
  readonly providerId: string;
  readonly accounts: readonly ProviderAccount[];
  readonly otherSource?: ProviderAuthSource;
}

/** omp's todo statuses (`TodoStatus`); as with the levels, a status omp adds or drops fails the typecheck here. */
const TODO_STATUSES: { readonly [Status in TodoStatus]: Status } = {
  pending: "pending",
  in_progress: "in_progress",
  completed: "completed",
  abandoned: "abandoned",
  blocked: "blocked",
};

/** omp's todo list (`TodoPhase`, `TodoItem`), as the user edits it. */
export const SetTodosParams = z.object({
  phases: z.array(
    z.object({
      name: z.string(),
      tasks: z.array(
        z.object({
          content: z.string(),
          status: z.enum(TODO_STATUSES),
          blocker: z.string().optional(),
          details: z.string().optional(),
          notes: z.array(z.string()).optional(),
        }),
      ),
    }),
  ),
});
export type SetTodosParams = z.infer<typeof SetTodosParams>;

/** Entries after the one with this id; all entries without one. */
export const EntriesParams = z.object({ since: z.string().min(1).optional() });
export type EntriesParams = z.infer<typeof EntriesParams>;

/** omp's page bounds: at most 256 messages a page, 100 by default; the cursor is the previous page's `nextCursor`. */
export const MessagesPageParams = z.object({
  cursor: z.string().min(1).max(2048).optional(),
  limit: z.int().min(1).max(256).optional(),
});
export type MessagesPageParams = z.infer<typeof MessagesPageParams>;

export const NewSessionParams = z.object({ parentSession: z.string().min(1).optional() });
export type NewSessionParams = z.infer<typeof NewSessionParams>;

/** `branch`, `fork` and `navigate_tree`: the session entry to start from. */
export const EntryParams = z.object({ entryId: z.string().min(1) });
export type EntryParams = z.infer<typeof EntryParams>;

/** A fork's start: an entry to copy the chat up to, or none to copy the whole chat (omp's `fork(entryId?)`). */
export const ForkParams = z.object({ entryId: z.string().min(1).optional() });
export type ForkParams = z.infer<typeof ForkParams>;

/** The session's entries and its live leaf (`get_entries`, `get_tree`). */
type SessionManagerOf = Session["sessionManager"];
type LeafId = ReturnType<SessionManagerOf["getLeafId"]>;

export interface MessagesPage {
  readonly messages: Session["messages"];
  /** Absent on the last page. */
  readonly nextCursor?: string;
  readonly totalMessages: number;
}

/** A rewind in place, as omp's own (`navigateTree` without a summary). */
export interface NavigateTreeResult {
  readonly cancelled: boolean;
  /** A rewound prompt's text and images, for the composer. */
  readonly editorText?: string;
  readonly editorImages?: NonNullable<Awaited<ReturnType<Session["navigateTree"]>>["editorImages"]>;
  /** The leaf after the move. */
  readonly leafId: LeafId;
}

/** omp's two queues of messages sent while a reply streams. */
export const QueueName = z.enum(["steering", "followUp"]);
export type QueueName = z.infer<typeof QueueName>;

export const RemoveQueuedMessageParams = z.object({ message: z.string(), queue: QueueName });
export type RemoveQueuedMessageParams = z.infer<typeof RemoveQueuedMessageParams>;

export const PromoteQueuedMessageParams = z.object({ message: z.string() });
export type PromoteQueuedMessageParams = z.infer<typeof PromoteQueuedMessageParams>;

/** A queued message handed back, with its images (omp's `RestoredQueuedMessage`). */
export interface QueuedMessage {
  readonly text: string;
  readonly images?: readonly ChatHostImage[];
}

/** `remove_queued_message`: the message taken out of its queue, or `removed: false` when it was no longer there. */
export type RemoveQueuedMessageResult =
  | { readonly removed: false }
  | ({ readonly removed: true } & QueuedMessage);

/** `abort_and_restore_queue`: every message that was still queued, for the message box. */
export interface RestoredQueue {
  readonly steering: readonly QueuedMessage[];
  readonly followUp: readonly QueuedMessage[];
}

/** `local_folder`: the chat's own scratch folder on the server, omp's `local://`, made when missing. */
export interface LocalFolder {
  readonly folder: string;
}

/** One entry of omp's command list (`buildAvailableSlashCommands`): the fields the app reads. */
export interface ChatHostCommand {
  readonly name: string;
  readonly aliases?: readonly string[];
  readonly description?: string;
  readonly input?: { readonly hint: string };
  readonly subcommands?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly usage?: string;
  }[];
  readonly source: "builtin" | "skill" | "extension" | "custom" | "mcp_prompt" | "file";
}

/** `bash` (the `!` command, and `!!` with `excludeFromContext`, #839): omp runs it and records it in the chat. */
export const BashParams = z.object({
  command: z.string().min(1),
  excludeFromContext: z.boolean().optional(),
});
export type BashParams = z.infer<typeof BashParams>;

/** `python` (the `$` command, and `$$` with `excludeFromContext`): omp runs it in its Python kernel and records it. */
export const PythonParams = z.object({
  code: z.string().min(1),
  excludeFromContext: z.boolean().optional(),
});
export type PythonParams = z.infer<typeof PythonParams>;

/** How a `bash` or `python` run ended: the fields of omp's `BashResult` and `PythonResult` the app reads. */
export interface ShellRunResult {
  readonly output: string;
  /** Undefined when the run was cancelled. */
  readonly exitCode: number | undefined;
  readonly cancelled: boolean;
  readonly truncated: boolean;
  /** The full output's artifact when it was too long to keep in the record. */
  readonly artifactId?: string;
}

export interface ChatHostMethodMap {
  readonly prompt: { readonly params: PromptParams; readonly result: PromptAnswer };
  /** Stops the reply; answers once omp's abort finished. */
  readonly abort: { readonly params: EmptyParams; readonly result: EmptyParams };
  readonly get_state: { readonly params: EmptyParams; readonly result: ChatHostState };
  readonly set_event_options: { readonly params: EventOptions; readonly result: EventOptions };
  readonly remove_queued_message: {
    readonly params: RemoveQueuedMessageParams;
    readonly result: RemoveQueuedMessageResult;
  };
  readonly promote_queued_message: {
    readonly params: PromoteQueuedMessageParams;
    readonly result: { readonly promoted: boolean };
  };
  /** Takes every queued message back, then stops the reply, as omp's Escape does. */
  readonly abort_and_restore_queue: {
    readonly params: EmptyParams;
    readonly result: RestoredQueue;
  };
  /** The chat's scratch folder (omp's `local://`), where files attached to a message are put for omp's tools. */
  readonly local_folder: { readonly params: EmptyParams; readonly result: LocalFolder };
  /**
   * Holds every agent of the chat (main, subagents, advisor) at its next step, as omp's `/pause` does: a model reply or
   * tool already under way finishes, nothing new starts. Pausing a paused chat keeps the first time.
   */
  readonly pause: { readonly params: EmptyParams; readonly result: PauseState };
  /** Releases the pause: held agents go on, queued messages send. */
  readonly resume: { readonly params: EmptyParams; readonly result: PauseState };
  readonly get_available_commands: {
    readonly params: EmptyParams;
    readonly result: { readonly commands: readonly ChatHostCommand[] };
  };
  readonly bash: { readonly params: BashParams; readonly result: ShellRunResult };
  readonly python: { readonly params: PythonParams; readonly result: ShellRunResult };
  readonly set_model: {
    readonly params: SetModelParams;
    readonly result: NonNullable<Session["model"]>;
  };
  /** Waits for omp's background model refresh first. */
  readonly get_available_models: {
    readonly params: EmptyParams;
    readonly result: { readonly models: ReturnType<Session["getAvailableModels"]> };
  };
  /**
   * omp's `/btw` (the chat host's `BtwController`, a port of omp's own): a side question about the chat (or a follow-up in topic `recordId`), answered
   * beside it, also while omp works. It answers once the question is saved as running; the answer comes as `btw_delta`
   * and `btw_record` events. One side question runs at a time.
   */
  readonly btw: {
    readonly params: BtwParams;
    readonly result: { readonly record: BtwHistoryRecord };
  };
  /** Cancels the running side question (only topic `recordId`, when given); answered outside the command order. */
  readonly btw_cancel: {
    readonly params: BtwCancelParams;
    readonly result: { readonly cancelled: boolean };
  };
  /** The chat's side questions, newest first, as omp keeps them (shared with omp's terminal); a running one carries its answer so far. */
  readonly get_btw_history: {
    readonly params: EmptyParams;
    readonly result: { readonly records: readonly BtwHistoryRecord[] };
  };
  /**
   * The roles Ctrl+P walks: omp's `cycleOrder` setting, the roles of it that resolve to an available model (omp skips the
   * others, and `default` falls back to the live model), and the one the live model is (null when none is).
   */
  readonly get_role_models: {
    readonly params: EmptyParams;
    readonly result: {
      readonly order: readonly string[];
      readonly roles: readonly RoleModel[];
      readonly current: string | null;
    };
  };
  /**
   * Switches the live model to the next or previous role's, as Ctrl+P and Shift+Ctrl+P do in omp; only the session
   * changes, not the settings. null when fewer than two roles have a model ("Only one role model available").
   */
  readonly cycle_role_models: {
    readonly params: CycleRoleModelsParams;
    readonly result: RoleModel | null;
  };
  /**
   * Switches the live model to a role's, with the thinking level the role names, as omp's Ctrl+P does for the next one
   * (`applyRoleModel`): only the session changes, and omp records the role, so it stays the chat's role when another
   * role has the same model (#2838). null when the role has no model.
   */
  readonly use_role_model: {
    readonly params: UseRoleModelParams;
    readonly result: RoleModel | null;
  };
  /**
   * What omp's model hub (Alt+M) shows: the roles with the model each resolves to (omp's own auto-selection for a role
   * that has none) and the models a role can take. Read as the catalog is, like `get_role_models`.
   */
  readonly get_model_hub: {
    readonly params: EmptyParams;
    readonly result: ModelHub;
  };
  /**
   * The chat's model menu: omp's available models by provider, newest first, and the ones it used most recently. Waits
   * for omp's background model refresh first, as `get_available_models` does.
   */
  readonly get_model_menu: {
    readonly params: EmptyParams;
    readonly result: ModelMenu;
  };
  /**
   * Gives a role a model, as the hub's `onAssign` does: `default` also switches the live chat (unless a higher settings
   * layer shadows the target), and other roles only write the setting. `applied` is false where omp's hub returns false;
   * `status` is the line omp shows. Refused with omp's own message where the hub shows an error.
   */
  readonly assign_model_role: {
    readonly params: AssignModelRoleParams;
    readonly result: { readonly applied: boolean; readonly status: string };
  };
  /**
   * Clears a role's setting, as the hub's `onUnassign` does. `status` is omp's "… role cleared — auto-selection
   * applies"; `switchedTo` is `provider/id` when clearing `default` exposed another persisted default and the live chat
   * switched to it (omp's second line, "Default model: provider/id"), else null.
   */
  readonly clear_model_role: {
    readonly params: ClearModelRoleParams;
    readonly result: { readonly status: string; readonly switchedTo: string | null };
  };
  /**
   * Sets a role's fallback chain, as the hub's `onFallbackChainChange` does (#2838): an empty chain clears it. `status`
   * is omp's line, "… fallbacks: a → b" or "… fallbacks cleared".
   */
  readonly set_role_fallbacks: {
    readonly params: SetRoleFallbacksParams;
    readonly result: { readonly status: string };
  };
  /**
   * Saves the current role assignments and default thinking level as a preset, as omp's hub and `/modelpreset save` do
   * (#2838); `status` is omp's line. Refused with omp's message for a name it does not take.
   */
  readonly save_model_preset: {
    readonly params: ModelPresetParams;
    readonly result: { readonly status: string };
  };
  /**
   * Switches to a preset, as omp's hub does: its roles are written and this chat moves to its default model (#2838).
   * `status` is omp's line; `clean` is false where it did not apply whole (not found, not available, roles another
   * settings layer still decides).
   */
  readonly apply_model_preset: {
    readonly params: ModelPresetParams;
    readonly result: { readonly status: string; readonly clean: boolean };
  };
  /** Deletes a preset from the global settings, as `/modelpreset delete` does (#2838); `status` is omp's line. */
  readonly delete_model_preset: {
    readonly params: ModelPresetParams;
    readonly result: { readonly status: string; readonly deleted: boolean };
  };
  /**
   * omp's live line for a typed compaction limit (#2838), as its hub shows it beside the field: `compacts at 340K · 85%
   * of 400K base`, `resets: …` for empty input; null for text that does not parse or fit.
   */
  readonly preview_compaction_point: {
    readonly params: CompactionPointParams;
    readonly result: { readonly preview: string | null };
  };
  /**
   * Sets or removes a model's own compaction limit, as omp's hub does (#2838): `saved` with omp's line, or `confirm`
   * with omp's warning when the limit opens the model's extended window, written once sent again `confirmed`. Refused
   * with omp's message for text it does not take.
   */
  readonly set_compaction_point: {
    readonly params: CompactionPointParams;
    readonly result:
      | { readonly kind: "saved"; readonly status: string }
      | { readonly kind: "confirm"; readonly message: string };
  };
  readonly set_thinking_level: {
    readonly params: ThinkingLevelParams;
    readonly result: EmptyParams;
  };
  /** null when the model has no levels to cycle. */
  readonly cycle_thinking_level: {
    readonly params: EmptyParams;
    readonly result: {
      readonly level: NonNullable<ReturnType<Session["cycleThinkingLevel"]>>;
    } | null;
  };
  /** `off` and the live model's own levels (omp's `auto` and `inherit` are not listed, as in omp). */
  readonly get_available_thinking_levels: {
    readonly params: EmptyParams;
    readonly result: { readonly levels: readonly ThinkingLevel[] };
  };
  readonly set_fast_mode: {
    readonly params: EnabledParams;
    readonly result: { readonly enabled: boolean; readonly active: boolean };
  };
  readonly set_slow_mode: {
    readonly params: EnabledParams;
    readonly result: { readonly enabled: boolean };
  };
  readonly compact: {
    readonly params: CustomInstructionsParams;
    readonly result: Awaited<ReturnType<Session["compact"]>>;
  };
  readonly set_auto_compaction: { readonly params: EnabledParams; readonly result: EmptyParams };
  readonly set_session_name: { readonly params: SessionNameParams; readonly result: EmptyParams };
  readonly get_session_stats: {
    readonly params: EmptyParams;
    readonly result: ReturnType<Session["getSessionStats"]>;
  };
  readonly export_html: {
    readonly params: ExportHtmlParams;
    readonly result: { readonly path: string };
  };
  /** null when omp made no handoff. Refused while a reply streams. */
  readonly handoff: {
    readonly params: CustomInstructionsParams;
    readonly result: {
      readonly savedPath: NonNullable<Awaited<ReturnType<Session["handoff"]>>>["savedPath"];
    } | null;
  };
  readonly set_todos: {
    readonly params: SetTodosParams;
    readonly result: { readonly todoPhases: ReturnType<Session["getTodoPhases"]> };
  };
  readonly get_entries: {
    readonly params: EntriesParams;
    readonly result: {
      readonly entries: ReturnType<SessionManagerOf["getEntries"]>;
      readonly leafId: LeafId;
    };
  };
  readonly get_tree: {
    readonly params: EmptyParams;
    readonly result: {
      readonly tree: ReturnType<SessionManagerOf["getTree"]>;
      readonly leafId: LeafId;
    };
  };
  /** Refused while a reply streams or a compaction runs. */
  readonly get_messages_page: {
    readonly params: MessagesPageParams;
    readonly result: MessagesPage;
  };
  /** The user prompts a branch can start from. */
  readonly get_branch_messages: {
    readonly params: EmptyParams;
    readonly result: { readonly messages: ReturnType<Session["getUserMessagesForBranching"]> };
  };
  readonly new_session: {
    readonly params: NewSessionParams;
    readonly result: { readonly cancelled: boolean };
  };
  /** A new session file from the entry; `text` is the prompt it starts from. */
  readonly branch: {
    readonly params: EntryParams;
    readonly result: { readonly text: string; readonly cancelled: boolean };
  };
  /** A copy of the session up to the entry, or of the whole session without one. Refused while the session is busy. */
  readonly fork: { readonly params: ForkParams; readonly result: { readonly cancelled: boolean } };
  /** Rewinds in place. Refused while the session is busy. */
  readonly navigate_tree: { readonly params: EntryParams; readonly result: NavigateTreeResult };
  /** Turns the host's `ui.ask` dialog on or off; off, omp asks with selects and editors. */
  readonly set_ask_dialog: {
    readonly params: EnabledParams;
    readonly result: { readonly enabled: boolean };
  };
  readonly get_login_providers: {
    readonly params: EmptyParams;
    readonly result: { readonly providers: readonly LoginProvider[] };
  };
  /** omp's sign-in; runs in the background, so other requests do not wait for the browser. */
  readonly login: {
    readonly params: LoginParams;
    readonly result: LoginResult;
  };
  /** Stops the sign-in running in this chat, a provider's or an MCP server's (#2784); answers whether one ran. */
  readonly cancel_sign_in: {
    readonly params: EmptyParams;
    readonly result: { readonly cancelled: boolean };
  };
  /**
   * omp's `/mcp reauth <name>`, from the device in use: the server's sign-in page opens there (`ui_open_url`), and the
   * address the browser ends on is pasted back (a `ui.input`), since omp listens for the callback on its own computer.
   * Runs in the background like `login`; answers the server's connection once it is signed in.
   */
  readonly mcp_reauth: {
    readonly params: McpReauthParams;
    readonly result: McpReauthResult;
  };
  /** The accounts omp stores for a provider (omp's `/logout` list). */
  readonly get_provider_accounts: {
    readonly params: LoginParams;
    readonly result: ProviderAccounts;
  };
  /**
   * Signs one stored account out (omp's `/logout`) and reads the provider's models again; answers whether it was
   * still stored, and the provider's accounts after.
   */
  readonly logout_account: {
    readonly params: LogoutAccountParams;
    readonly result: ProviderAccounts & { readonly removed: boolean };
  };
  /** Replaces the app's tools in the session; answers the names omp registered. */
  readonly set_host_tools: {
    readonly params: SetHostToolsParams;
    readonly result: { readonly toolNames: readonly string[] };
  };
  /** Replaces the app's URI schemes in omp's router; answers the schemes, normalized. */
  readonly set_host_uri_schemes: {
    readonly params: SetHostUriSchemesParams;
    readonly result: { readonly schemes: readonly string[] };
  };
  /** A running host tool call's progress; `delivered` is false once the call has ended. */
  readonly host_tool_update: {
    readonly params: HostToolUpdateParams;
    readonly result: { readonly delivered: boolean };
  };
  /** Which subagent events the host sends; answers the level now in force. */
  readonly set_subagent_subscription: {
    readonly params: SubagentSubscriptionParams;
    readonly result: SubagentSubscriptionParams;
  };
  readonly get_subagents: {
    readonly params: EmptyParams;
    readonly result: { readonly subagents: readonly SubagentSnapshot[] };
  };
  /**
   * Ends the chat in this host the clean way, so another omp (the terminal) can open it: the host answers, finishes a
   * turn that runs, closes its link and exits (D2, a host on a socket; on pipes the host ends as when its input closes).
   */
  readonly hand_back: {
    readonly params: EmptyParams;
    readonly result: { readonly handedBack: true };
  };
  /**
   * For a server that attached to the host after it started (D2): sends, before its answer, what is live now: a run
   * under way (`agent_start`), each unfinished message as a `message_start` holding what it has so far, each running
   * tool's start, the statuses, widgets and title on show, and each question still waiting for an answer, under its
   * own id.
   */
  readonly replay_live: { readonly params: EmptyParams; readonly result: EmptyParams };
  readonly get_subagent_messages: {
    readonly params: SubagentMessagesParams;
    readonly result: SubagentTranscript;
  };
  /** omp's hard kill of a running subagent; `cancelled: false` for one that is not running. */
  readonly cancel_subagent: {
    readonly params: SubagentIdParams;
    readonly result: { readonly cancelled: boolean };
  };
  /** Sends the app's message to a running subagent, answered once it is accepted; runs in the background. */
  readonly steer_subagent: { readonly params: SteerSubagentParams; readonly result: EmptyParams };
  /**
   * The chat's background jobs (omp's `getAsyncJobTree`): running and recent, its subagents' too; null when the session
   * has no job manager.
   */
  readonly get_jobs: {
    readonly params: JobsParams;
    readonly result: { readonly jobs: JobList | null };
  };
  /** One job's command, pids, exit code and output, from omp's job manager (never its widget); null for an unknown one. */
  readonly inspect_job: {
    readonly params: JobIdParams;
    readonly result: { readonly job: JobDetail | null };
  };
  /** Cancels one of the chat's own running jobs (omp's `cancelAsyncJob`); false for a subagent's, a settled or an unknown one. */
  readonly cancel_job: {
    readonly params: JobIdParams;
    readonly result: { readonly cancelled: boolean };
  };
  /** omp's goal mode: read, create, resume, pause or drop the chat's goal. */
  readonly goal: { readonly params: GoalParams; readonly result: GoalAnswer };
  readonly get_plan_mode: { readonly params: EmptyParams; readonly result: PlanModeStatus };
  /** omp's `/plan`, without its switch to the plan model. Refused while work runs or a goal is active. */
  readonly set_plan_mode: { readonly params: EnabledParams; readonly result: PlanModeStatus };
  /** A plan file's text: the one plan mode writes unless `planFilePath` names another. */
  readonly get_plan: { readonly params: GetPlanParams; readonly result: PlanFile };
  /**
   * omp's "Approve and keep context": plan mode ends and the run on the plan starts in the same chat. Answered once
   * omp admitted the run; refused while work runs or when plan mode is off.
   */
  readonly approve_plan: { readonly params: ApprovePlanParams; readonly result: ApprovePlanResult };
  /**
   * omp's live voice session on this chat's session, answered once it records; one at a time. Runs outside the
   * one-at-a-time order, as in omp.
   */
  readonly live_start: {
    readonly params: LiveStartParams;
    readonly result: { readonly voice: string };
  };
  /** Ends the live session once it has stopped; nothing without one. */
  readonly live_stop: { readonly params: EmptyParams; readonly result: EmptyParams };
  /** Refused without a live session. */
  readonly live_mute: {
    readonly params: LiveMuteParams;
    readonly result: { readonly muted: boolean };
  };
  /**
   * A message for omp's steering queue (delivered after the running tool step) or its follow-up queue (delivered when
   * the run would end), after the extensions' input hooks, as omp's. No prompt result follows; runs outside the
   * one-at-a-time order, as `prompt` does.
   */
  readonly steer: { readonly params: QueuedInputParams; readonly result: EmptyParams };
  readonly follow_up: { readonly params: QueuedInputParams; readonly result: EmptyParams };
  /** Stops the running `!` command. */
  readonly abort_bash: { readonly params: EmptyParams; readonly result: EmptyParams };
  /** The queue and interrupt modes, for this chat only: omp's settings and later chats stay as they are. */
  readonly set_steering_mode: { readonly params: SteeringModeParams; readonly result: EmptyParams };
  readonly set_follow_up_mode: {
    readonly params: FollowUpModeParams;
    readonly result: EmptyParams;
  };
  readonly set_interrupt_mode: {
    readonly params: InterruptModeParams;
    readonly result: EmptyParams;
  };
}

export const GetPlanParams = z.object({ planFilePath: z.string().min(1).optional() });
export type GetPlanParams = z.infer<typeof GetPlanParams>;

export const ApprovePlanParams = z.object({
  /** The plan to run: the `planFilePath` omp's `xd://propose` result reported. */
  planFilePath: z.string().min(1),
  /** The plan's title from that result; it names an unnamed chat. */
  title: z.string().optional(),
});
export type ApprovePlanParams = z.infer<typeof ApprovePlanParams>;

export interface PlanModeStatus {
  readonly enabled: boolean;
  /** omp's `plan.enabled` setting: false means omp offers no plan mode in this chat. */
  readonly available: boolean;
  /** The plan file while plan mode is on, for example `local://PLAN.md`. */
  readonly planFilePath?: string;
}

export interface PlanFile {
  readonly planFilePath: string;
  readonly content: string;
}

export interface ApprovePlanResult {
  readonly planFilePath: string;
  /** Where omp saved a copy of the plan, when its `plan.autosave` setting is on. */
  readonly autosavedPath?: string;
}

/** omp's goal operations, with its own field names (`token_budget`). */
export const GoalParams = z.object({
  op: z.enum(["get", "create", "resume", "pause", "drop"]),
  /** Required to create. */
  objective: z.string().optional(),
  /** A whole number of tokens the goal may use. */
  token_budget: z.int().positive().optional(),
});
export type GoalParams = z.infer<typeof GoalParams>;

/** The chat's goal and goal-mode state after the operation; null without a goal. */
export interface GoalAnswer {
  readonly goal: Goal | null;
  readonly state: NonNullable<ReturnType<Session["getGoalModeState"]>> | null;
}
export type ChatHostMethod = keyof ChatHostMethodMap;

const PARAMS: { readonly [M in ChatHostMethod]: z.ZodType<ChatHostMethodMap[M]["params"]> } = {
  prompt: PromptParams,
  abort: EmptyParams,
  get_state: EmptyParams,
  set_event_options: EventOptions,
  remove_queued_message: RemoveQueuedMessageParams,
  promote_queued_message: PromoteQueuedMessageParams,
  abort_and_restore_queue: EmptyParams,
  local_folder: EmptyParams,
  pause: EmptyParams,
  resume: EmptyParams,
  get_available_commands: EmptyParams,
  bash: BashParams,
  python: PythonParams,
  set_model: SetModelParams,
  get_available_models: EmptyParams,
  get_role_models: EmptyParams,
  cycle_role_models: CycleRoleModelsParams,
  use_role_model: UseRoleModelParams,
  btw: BtwParams,
  btw_cancel: BtwCancelParams,
  get_btw_history: EmptyParams,
  get_model_hub: EmptyParams,
  get_model_menu: EmptyParams,
  assign_model_role: AssignModelRoleParams,
  clear_model_role: ClearModelRoleParams,
  set_role_fallbacks: SetRoleFallbacksParams,
  save_model_preset: ModelPresetParams,
  apply_model_preset: ModelPresetParams,
  delete_model_preset: ModelPresetParams,
  preview_compaction_point: CompactionPointParams,
  set_compaction_point: CompactionPointParams,
  set_thinking_level: ThinkingLevelParams,
  cycle_thinking_level: EmptyParams,
  get_available_thinking_levels: EmptyParams,
  set_fast_mode: EnabledParams,
  set_slow_mode: EnabledParams,
  compact: CustomInstructionsParams,
  set_auto_compaction: EnabledParams,
  set_session_name: SessionNameParams,
  get_session_stats: EmptyParams,
  export_html: ExportHtmlParams,
  handoff: CustomInstructionsParams,
  set_todos: SetTodosParams,
  get_entries: EntriesParams,
  get_tree: EmptyParams,
  get_messages_page: MessagesPageParams,
  get_branch_messages: EmptyParams,
  new_session: NewSessionParams,
  branch: EntryParams,
  fork: ForkParams,
  navigate_tree: EntryParams,
  set_ask_dialog: EnabledParams,
  get_login_providers: EmptyParams,
  login: LoginParams,
  cancel_sign_in: EmptyParams,
  mcp_reauth: McpReauthParams,
  get_provider_accounts: LoginParams,
  logout_account: LogoutAccountParams,
  set_host_tools: SetHostToolsParams,
  set_host_uri_schemes: SetHostUriSchemesParams,
  host_tool_update: HostToolUpdateParams,
  set_subagent_subscription: SubagentSubscriptionParams,
  get_subagents: EmptyParams,
  hand_back: EmptyParams,
  replay_live: EmptyParams,
  get_subagent_messages: SubagentMessagesParams,
  cancel_subagent: SubagentIdParams,
  steer_subagent: SteerSubagentParams,
  get_jobs: JobsParams,
  inspect_job: JobIdParams,
  cancel_job: JobIdParams,
  goal: GoalParams,
  get_plan_mode: EmptyParams,
  set_plan_mode: EnabledParams,
  get_plan: GetPlanParams,
  approve_plan: ApprovePlanParams,
  live_start: LiveStartParams,
  live_stop: EmptyParams,
  live_mute: LiveMuteParams,
  steer: QueuedInputParams,
  follow_up: QueuedInputParams,
  abort_bash: EmptyParams,
  set_steering_mode: SteeringModeParams,
  set_follow_up_mode: FollowUpModeParams,
  set_interrupt_mode: InterruptModeParams,
};

/** The methods of protocol version 1, in the order `hello` lists them (`method-names.ts`, checked against the map). */
export const CHAT_HOST_METHODS: readonly ChatHostMethod[] = CHAT_HOST_METHOD_NAMES;

/** Fails to compile when `method-names.ts` misses a method of `ChatHostMethodMap`. */
type NoMethodMissing<Missing extends never> = Missing;
export type ChatHostMethodNamesComplete = NoMethodMissing<
  Exclude<ChatHostMethod, ChatHostMethodName>
>;

export function isChatHostMethod(method: string): method is ChatHostMethod {
  return Object.hasOwn(PARAMS, method);
}

/** Checks a request's params against its method. A failure names the failing fields. */
export function parseChatHostParams<M extends ChatHostMethod>(
  method: M,
  params: unknown,
): ParseResult<ChatHostMethodMap[M]["params"]> {
  const result = PARAMS[method].safeParse(params ?? {});
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    error: { code: "invalid_args", message: z.prettifyError(result.error), retryable: false },
  };
}

// The app's own events

/** Why a prompt failed, read from the reply's last message as omp reports it. */
export interface PromptFailure {
  readonly message: string;
  readonly provider?: string;
  readonly model?: string;
  readonly httpStatus?: number;
  /** omp classifies the failure as transient (a retry may succeed). */
  readonly retryable: boolean;
}

/**
 * The outcome of one prompt whose answer said `resultFollows`: sent when the run that carried the prompt yields.
 * `agentInvoked` is false when the prompt ended without reaching the model (an extension's command handled it).
 */
export interface PromptResultEvent {
  readonly type: "prompt_result";
  readonly requestId: string;
  readonly agentInvoked: boolean;
  readonly status: "completed" | "aborted" | "error";
  readonly error?: PromptFailure;
  /**
   * Whether the session was done when the result was written: nothing live, admitted or queued, and no background work
   * that could wake it. A run that yielded is not always a settled session; `session_settled` follows when it is.
   */
  readonly sessionSettled: boolean;
}

/** A stretch of agent activity is over: the final run yielded and nothing left can wake the session. */
export interface SessionSettledEvent {
  readonly type: "session_settled";
}

/**
 * Plan mode turned on or off in the chat (a page's switch, an approved plan, the session's own mode at start), with its
 * status after: every page that shows the chat shows it (#2812). omp's own plan mode state sends no event.
 */
export interface PlanModeChangedEvent extends PlanModeStatus {
  readonly type: "plan_mode_changed";
}

/**
 * An extension's handler failed (omp's `reportRuntimeError`), with the fields omp's RPC sends for it
 * (18.12.6 `modes/rpc/rpc-mode.ts:1659-1661`): the extension's file, the event it was handling, and the error's message.
 */
export interface ExtensionErrorEvent {
  readonly type: "extension_error";
  readonly extensionPath: string;
  readonly event: string;
  readonly error: string;
}

/** omp's command list, at start and whenever it changes (skills, extensions and command files reloaded). */
export interface AvailableCommandsEvent {
  readonly type: "available_commands";
  readonly commands: readonly ChatHostCommand[];
}

/** What a built-in slash command printed (`/session info`, `/usage`, …). */
export interface CommandOutputEvent {
  readonly type: "command_output";
  readonly text: string;
}

/** A built-in command renamed the chat (omp's `notifyTitleChanged`). */
export interface SessionInfoUpdateEvent {
  readonly type: "session_info_update";
  readonly sessionId: string;
  readonly title: string | null;
}

/** A built-in command changed the chat's model or thinking level (omp's `notifyConfigChanged`). */
export interface ConfigUpdateEvent {
  readonly type: "config_update";
  readonly model?: ChatHostState["model"];
  readonly thinkingLevel?: ChatHostState["thinkingLevel"];
}

/** The chat was paused or resumed (omp's pause gate, by `pause`, `resume` or a typed `/pause`). */
export interface PauseChangedEvent {
  readonly type: "pause_changed";
  /** When the pause began (epoch ms); null once resumed. */
  readonly pausedAt: number | null;
}

type MessageEventType = "message_start" | "message_update" | "message_end";
type MessageEvent = Extract<AgentSessionEvent, { readonly type: MessageEventType }>;
type MessageUpdate = Extract<AgentSessionEvent, { readonly type: "message_update" }>;

/** An event without the field `K`, member by member. */
type OmitEach<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A message's start, update or end with its id (`msg-1`, `msg-2`, …, as omp's own protocol hosts give them). */
export type StampedMessageEvent = MessageEvent & { readonly messageId: string };

/** A `message_update` in the `delta` form: the increment only, without the message so far and the `partial`. */
export interface DeltaMessageUpdate {
  readonly type: "message_update";
  readonly messageId: string;
  readonly message: { readonly role: MessageUpdate["message"]["role"] };
  readonly assistantMessageEvent: OmitEach<AssistantMessageEvent, "partial">;
}

/** Every event the chat host writes: omp's session events, and the app's own. */
export type ChatEvent =
  | Exclude<AgentSessionEvent, { readonly type: MessageEventType }>
  | StampedMessageEvent
  | DeltaMessageUpdate
  | PromptResultEvent
  | AvailableCommandsEvent
  | CommandOutputEvent
  | SessionInfoUpdateEvent
  | ConfigUpdateEvent
  | UiEvent
  | UiAnsweredEvent
  | ToolCancelEvent
  | UriCancelEvent
  | SubagentEvent
  | SessionSettledEvent
  | ExtensionErrorEvent
  | LiveEvent
  | BtwDeltaEvent
  | BtwRecordEvent
  | PauseChangedEvent
  | PlanModeChangedEvent;

/** omp's `/btw` answering: the next piece of a side question's answer (omp's `btw_delta`). */
export interface BtwDeltaEvent {
  readonly type: "btw_delta";
  readonly recordId: string;
  readonly delta: string;
}
/**
 * A side question started or ended (complete, cancelled, an error): its whole record (omp's `btw_record`). A side
 * question omp could not save comes as omp's `notice` with source `btw-history`.
 */
export interface BtwRecordEvent {
  readonly type: "btw_record";
  readonly record: BtwHistoryRecord;
}
