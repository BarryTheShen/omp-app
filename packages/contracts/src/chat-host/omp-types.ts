/**
 * omp's own objects as the app types them (`Omp.*`): omp's SDK types, from the `@oh-my-pi/*` packages the app pins, and
 * for omp's answers to the chat host's methods, the host protocol's result types, which are built from them. They replace
 * the copy of omp's RPC schema (`omp-wire`) the app typed omp's objects with before the SDK move (SDK plan H5.6e).
 *
 * Type-only: nothing of omp runs where this file is imported.
 */

import type { ThinkingLevel as SdkThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import type {
  AssistantMessage as SdkAssistantMessage,
  Effort as SdkEffort,
  ThinkingConfig as SdkThinkingConfig,
  UserMessage as SdkUserMessage,
} from "@oh-my-pi/pi-ai";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type {
  ChatHostCommand,
  ChatHostMethodMap,
  ChatHostState,
  PromptResultEvent as HostPromptResultEvent,
  InterruptModeParams,
  RestoredQueue,
  StampedMessageEvent,
  SteeringModeParams,
} from "./protocol";
import type {
  SubagentLifecycleEvent,
  SubagentProgressEvent,
  SubagentSessionEvent,
} from "./subagents";

/** omp's answer to one of the chat host's methods. */
type ResultOf<M extends keyof ChatHostMethodMap> = ChatHostMethodMap[M]["result"];

/** One of omp's session events by its type. */
type SessionEventOf<T extends AgentSessionEvent["type"]> = Extract<AgentSessionEvent, { type: T }>;

// Messages and their parts.
export type {
  AssistantMessageEvent,
  ImageContent,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
} from "@oh-my-pi/pi-ai";
/** A reasoning effort as omp writes it: the values of omp's `Effort` (a const enum). */
export type Effort = `${SdkEffort}`;
export type { AgentMessage } from "@oh-my-pi/pi-agent-core";
export type {
  BranchSummaryMessage,
  CompactionSummaryMessage,
  CustomMessage,
} from "@oh-my-pi/pi-agent-core/compaction/messages";
/** A thinking level as omp writes it: the values of omp's `ThinkingLevel` (`inherit`, `off` and the efforts). */
export type ThinkingLevel = `${SdkThinkingLevel}`;
/** A level a session can be set to: a thinking level, or `auto` (omp's `ConfiguredThinkingLevel`). */
export type ConfiguredThinkingLevel = ThinkingLevel | "auto";
export type AssistantMessage = SdkAssistantMessage;
export type UserMessage = SdkUserMessage;
/** What a user message holds: its text, or its parts. */
export type MessageContent = SdkUserMessage["content"];

// The session's events.
/**
 * One of omp's session events as the chat host passes it on: a message's start, update or end carries the host's
 * `messageId` (`StampedMessageEvent`).
 */
export type SessionEvent =
  | Exclude<
      AgentSessionEvent,
      { readonly type: "message_start" | "message_update" | "message_end" }
    >
  | StampedMessageEvent;
export type QueueUpdateEvent = SessionEventOf<"queue_update">;
export type AutoCompactionStartEvent = SessionEventOf<"auto_compaction_start">;
export type AutoCompactionEndEvent = SessionEventOf<"auto_compaction_end">;
export type AutoCompactionReason = AutoCompactionStartEvent["reason"];
export type AutoCompactionAction = AutoCompactionStartEvent["action"];
export type CacheWarmingStartEvent = SessionEventOf<"cache_warming_start">;
export type CacheWarmingEndEvent = SessionEventOf<"cache_warming_end">;
export type PromptResultEvent = HostPromptResultEvent;
export type PromptStatus = HostPromptResultEvent["status"];
export type PromptError = NonNullable<HostPromptResultEvent["error"]>;
export type {
  MessagesPage,
  RemoveQueuedMessageResult,
  SessionSettledEvent,
} from "./protocol";

// The state and the host's answers.
/** A model's thinking capabilities as the app reads them: omp's `ThinkingConfig`, its efforts in their string form. */
export type ModelThinking = Omit<SdkThinkingConfig, "efforts" | "defaultLevel" | "effortMap"> & {
  readonly efforts: readonly Effort[];
  readonly defaultLevel?: Effort;
};
/** A model as the app reads it: the fields of omp's `Model` its pickers, labels and limits use. */
export type ModelInfo = Pick<
  ResultOf<"get_available_models">["models"][number],
  | "id"
  | "name"
  | "api"
  | "provider"
  | "baseUrl"
  | "reasoning"
  | "input"
  | "cost"
  | "contextWindow"
  | "maxTokens"
  | "headers"
  | "premiumMultiplier"
> & { readonly thinking?: ModelThinking };
/**
 * The chat's state as the app reads it: the host's `ChatHostState`, with the model as `ModelInfo` and the thinking level
 * in its string form (the host's answer is assignable to it).
 */
export type SessionState = Omit<ChatHostState, "model" | "thinkingLevel"> & {
  readonly model?: ModelInfo;
  readonly thinkingLevel?: ThinkingLevel;
};
/** The host's `get_available_models` answer as the app reads it (the host's answer is assignable to it). */
export interface GetAvailableModelsResult {
  readonly models: readonly ModelInfo[];
}
/** The host's `get_available_thinking_levels` answer, the levels in their string form. */
export interface GetAvailableThinkingLevelsResult {
  readonly levels: readonly ThinkingLevel[];
}
/** The host's `cycle_thinking_level` answer (omp's `cycleThinkingLevel`, which can land on `auto`); null when the model has none to cycle. */
export type ThinkingLevelCycleResult = { readonly level: ConfiguredThinkingLevel } | null;
export type CompactionResult = ResultOf<"compact">;
export type SessionStats = ResultOf<"get_session_stats">;
export type SessionEntries = ResultOf<"get_entries">;
export type SessionTree = ResultOf<"get_tree">;
export type BranchResult = ResultOf<"branch">;
export type CancellationResult = ResultOf<"cancel_subagent">;
export type PromoteQueuedMessageResult = ResultOf<"promote_queued_message">;
export type AbortAndRestoreQueueResult = RestoredQueue;
export type RestoredQueuedMessage = RestoredQueue["steering"][number];
export type LiveStartResult = ResultOf<"live_start">;
export type LiveMuteResult = ResultOf<"live_mute">;
export type QueueMode = SteeringModeParams["mode"];
export type InterruptMode = InterruptModeParams["mode"];
export type SlashCommandSource = ChatHostCommand["source"];
export type ContextUsage = NonNullable<ChatHostState["contextUsage"]>;
export type { BashResult } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
export type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
export type { Goal } from "@oh-my-pi/pi-tui/tools/goal";
export type { TodoItem, TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";

// Subagents.
export type {
  SubagentEvent,
  SubagentLifecycleEvent,
  SubagentProgressEvent,
  SubagentSessionEvent,
} from "./subagents";
export type SubagentLifecyclePayload = SubagentLifecycleEvent["payload"];
export type SubagentProgressPayload = SubagentProgressEvent["payload"];
export type SubagentEventPayload = SubagentSessionEvent["payload"];
