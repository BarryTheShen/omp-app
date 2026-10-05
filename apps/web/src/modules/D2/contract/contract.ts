import {
  AppError as AppErrorSchema,
  AttachmentRef,
  type ComposerDescriptor,
} from "@omp-app/contracts";
import { z } from "zod";
import type { ComposerTriggerProvider } from "../../U2/contract";

export type { PromptDelivery, PromptIntent, PromptMode } from "../../U2/contract";

export const TriggerKind = z.enum([
  "slash",
  "file",
  "github",
  "prompt-action",
  "emoji",
  "internal-url",
]);
export type TriggerKind = z.infer<typeof TriggerKind>;

export const TriggerSource = z.enum([
  "builtin",
  "extension",
  "skill",
  "custom",
  "mcp_prompt",
  "file",
  "a1.file-search",
  "a1.github-refs",
  "a1.url-catalog",
  "client",
]);
export type TriggerSource = z.infer<typeof TriggerSource>;

export const TextRange = z.strictObject({
  start: z.int().nonnegative(),
  end: z.int().nonnegative(),
});
export type TextRange = z.infer<typeof TextRange>;

export const TriggerPosition = z.strictObject({
  range: TextRange,
  line: z.int().nonnegative().optional(),
  column: z.int().nonnegative().optional(),
});
export type TriggerPosition = z.infer<typeof TriggerPosition>;

/** A bounded source-agnostic item that U2's trigger slot can render. */
export const TriggerCandidate = z.strictObject({
  id: z.string().min(1).max(512),
  kind: TriggerKind,
  source: TriggerSource,
  label: z.string().min(1).max(512),
  description: z.string().max(2_000).optional(),
  insertText: z.string().max(8_192).optional(),
  position: TriggerPosition.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type TriggerCandidate = z.infer<typeof TriggerCandidate>;

export const TriggerCatalogState = z.enum([
  "idle",
  "loading",
  "ready",
  "stale",
  "error",
  "unavailable",
]);
export type TriggerCatalogState = z.infer<typeof TriggerCatalogState>;

export const TriggerCatalogError = z.strictObject({
  error: AppErrorSchema,
  state: z.enum(["error", "unavailable"]),
});
export type TriggerCatalogError = z.infer<typeof TriggerCatalogError>;

export const TriggerSearchResult = z.strictObject({
  state: TriggerCatalogState,
  candidates: z.array(TriggerCandidate).max(200),
  revision: z.string().min(1).optional(),
  error: TriggerCatalogError.optional(),
});
export type TriggerSearchResult = z.infer<typeof TriggerSearchResult>;

export interface TriggerProvider extends ComposerTriggerProvider {
  readonly kind: TriggerKind;
  readonly source: TriggerSource;
  readonly searchTyped: (
    query: string,
    position?: TriggerPosition,
  ) => TriggerSearchResult | Promise<TriggerSearchResult>;
}

export interface MentionProvider extends TriggerProvider {
  readonly trigger: "@" | "#" | `${string}://`;
}

export const SlashSubcommand = z.strictObject({
  name: z.string().min(1),
  description: z.string().optional(),
  usage: z.string().optional(),
});
export type SlashSubcommand = z.infer<typeof SlashSubcommand>;

/** A0's command metadata with aliases/source/subcommand details preserved for D2. */
export const SlashCommand = z.strictObject({
  name: z.string().min(1),
  source: z.enum(["builtin", "skill", "extension", "custom", "mcp_prompt", "file"]),
  aliases: z.array(z.string().min(1)).max(32).optional(),
  description: z.string().optional(),
  input: z.strictObject({ hint: z.string().optional() }).optional(),
  subcommands: z.array(SlashSubcommand).max(200).optional(),
});
export type SlashCommand = z.infer<typeof SlashCommand>;

export const SlashCommandCatalog = z.strictObject({
  state: TriggerCatalogState,
  commands: z.array(SlashCommand).max(500),
  revision: z.string().min(1),
  error: TriggerCatalogError.optional(),
});
export type SlashCommandCatalog = z.infer<typeof SlashCommandCatalog>;

export const FileMentionCandidate = z.strictObject({
  path: z.string().min(1),
  kind: z.enum(["file", "directory"]),
  score: z.number().finite().nonnegative(),
  lineRange: z.strictObject({ start: z.int().positive(), end: z.int().positive() }).optional(),
});
export type FileMentionCandidate = z.infer<typeof FileMentionCandidate>;

export const GitHubReferenceCandidate = z.strictObject({
  kind: z.enum(["issue", "pull-request"]),
  number: z.int().positive(),
  title: z.string().min(1),
  url: z.string().url(),
  repository: z.string().min(1),
  state: z.enum(["open", "closed", "merged"]).optional(),
});
export type GitHubReferenceCandidate = z.infer<typeof GitHubReferenceCandidate>;

export const InternalUrlCandidate = z.strictObject({
  scheme: z.string().regex(/^[a-z][a-z0-9+.-]*$/),
  uri: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  source: z.enum(["omp", "app"]),
});
export type InternalUrlCandidate = z.infer<typeof InternalUrlCandidate>;

export const EmojiCandidate = z.strictObject({
  name: z.string().min(1),
  unicode: z.string().min(1),
  label: z.string().min(1),
});
export type EmojiCandidate = z.infer<typeof EmojiCandidate>;

export const PromptAction = z.enum([
  "copy-current-line",
  "copy-prompt",
  "undo",
  "cursor-start",
  "cursor-end",
]);
export type PromptAction = z.infer<typeof PromptAction>;

export const PromptActionCandidate = z.strictObject({
  action: PromptAction,
  label: z.string().min(1),
  description: z.string().optional(),
});
export type PromptActionCandidate = z.infer<typeof PromptActionCandidate>;

export const PromptExpansionSuccess = z.strictObject({
  kind: z.literal("expanded"),
  text: z.string(),
  replace: TextRange,
  cursor: z.int().nonnegative(),
  attachmentRefs: z.array(AttachmentRef).max(100),
  images: z.array(z.unknown()).max(100).optional(),
  action: PromptAction.optional(),
});
export type PromptExpansionSuccess = z.infer<typeof PromptExpansionSuccess>;

export const PromptExpansionError = z.strictObject({
  kind: z.literal("error"),
  error: AppErrorSchema,
  replace: TextRange,
  preserveText: z.literal(true),
});
export type PromptExpansionError = z.infer<typeof PromptExpansionError>;

export const PromptExpansionResult = z.discriminatedUnion("kind", [
  PromptExpansionSuccess,
  PromptExpansionError,
]);
export type PromptExpansionResult = z.infer<typeof PromptExpansionResult>;

export interface PromptIntentBoundary {
  /** Applies local expansion to composer text; it never submits a PromptIntent. */
  readonly applyExpansion: (
    currentText: string,
    result: PromptExpansionSuccess,
  ) => {
    readonly text: string;
    readonly cursor: number;
    readonly attachmentRefs: readonly z.output<typeof AttachmentRef>[];
  };
}

export const D2_TRIGGER_DESCRIPTORS = [
  {
    kind: "composer",
    id: "D2.slashTrigger",
    owner: "D2",
    title: "Slash command trigger",
    covers: ["D3.slash-command-autocomplete"],
    requires: ["omp.cmd.get_available_commands"],
    feature: { slot: "trigger", trigger: "/" },
  },
  {
    kind: "composer",
    id: "D2.fileMentionTrigger",
    owner: "D2",
    title: "File mention trigger",
    covers: ["D7.file-autocomplete"],
    requires: ["host.file-search"],
    feature: { slot: "trigger", trigger: "@" },
  },
  {
    kind: "composer",
    id: "D2.hashTrigger",
    owner: "D2",
    title: "Prompt action and GitHub reference trigger",
    covers: ["D7.prompt-actions", "D7.github-issue-pr-autocomplete"],
    requires: [],
    feature: { slot: "trigger", trigger: "#" },
  },
  {
    kind: "composer",
    id: "D2.emojiTrigger",
    owner: "D2",
    title: "Emoji trigger",
    covers: ["D7.emoji-autocomplete-and-inline-replacement"],
    requires: [],
    feature: { slot: "trigger", trigger: ":" },
  },
  {
    kind: "composer",
    id: "D2.internalUrlTrigger",
    owner: "D2",
    title: "Internal URL trigger",
    covers: ["D7.internal-url-autocomplete"],
    requires: ["host.url-catalog"],
    feature: { slot: "trigger", trigger: "scheme://" },
  },
] as const satisfies readonly ComposerDescriptor[];

export type D2TriggerDescriptor = (typeof D2_TRIGGER_DESCRIPTORS)[number];
