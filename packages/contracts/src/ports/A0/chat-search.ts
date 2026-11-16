import { z } from "zod";
import type { PortClient, PortHandlers } from "../../core/envelope";
import { definePort } from "../../core/envelope";
import { FolderPath, SessionFilePath, ThreadId } from "../../core/ids";

/**
 * Search chats by meaning: an embedding service (any OpenAI-style `/embeddings` address) turns what you and omp wrote in
 * each chat into vectors, kept in an index on the server, and a search finds the chats whose talk is closest to its
 * words. Settings → App → Search by meaning sets the service; its key stays on the server.
 */
export const ChatSearchSettings = z
  .object({
    enabled: z.boolean(),
    /** The service's address up to `/embeddings` (`https://embed.example.com/v1`); empty: none set. */
    address: z.string(),
    /** The model's name as the service knows it; empty: none set. */
    model: z.string(),
    /** Whether a key is kept for the service; the key itself never leaves the server. */
    hasKey: z.boolean(),
  })
  .strict();
export type ChatSearchSettings = z.infer<typeof ChatSearchSettings>;

/** How far the index is. */
export const ChatSearchStatus = z
  .object({
    /** The chats the index covers (top-level chats, every folder). */
    chats: z.number().int().min(0),
    /** Of those, the ones whose talk is in the index as it is now. */
    indexed: z.number().int().min(0),
    /** The index is being brought up to date now. */
    indexing: z.boolean(),
    /** Why indexing stopped (the service failed), until it works again; null when nothing is wrong. */
    problem: z.string().nullable(),
  })
  .strict();
export type ChatSearchStatus = z.infer<typeof ChatSearchStatus>;

export const ChatSearchState = z
  .object({ settings: ChatSearchSettings, status: ChatSearchStatus })
  .strict();
export type ChatSearchState = z.infer<typeof ChatSearchState>;

/** A change to the settings: any of them, at least one. A key of "" removes the kept key. */
export const SetChatSearchSettingsArgs = z
  .object({
    enabled: z.boolean().optional(),
    address: z.string().max(2_000).optional(),
    model: z.string().max(200).optional(),
    key: z.string().max(4_000).optional(),
  })
  .strict()
  .refine((args) => Object.keys(args).length > 0, { message: "Name a setting to change." });
export type SetChatSearchSettingsArgs = z.infer<typeof SetChatSearchSettingsArgs>;

/** One line embedded by the service as set: how long it took and how many numbers a vector has, or why it failed. */
export const ChatSearchTest = z.union([
  z.object({ ok: z.literal(true), ms: z.number(), dimensions: z.number().int().min(1) }).strict(),
  z.object({ ok: z.literal(false), ms: z.number(), message: z.string().min(1) }).strict(),
]);
export type ChatSearchTest = z.infer<typeof ChatSearchTest>;

/** A chat whose talk is close to the search's words, with the passage closest to them. */
export const ChatSearchMatch = z
  .object({
    threadId: ThreadId,
    title: z.string(),
    folder: FolderPath,
    sessionFile: SessionFilePath,
    /** The passage that matched best, as written (up to ~1,500 characters). */
    passage: z.string(),
    /** How close, from 0 to 1 (cosine similarity). */
    score: z.number(),
  })
  .strict();
export type ChatSearchMatch = z.infer<typeof ChatSearchMatch>;

export const SearchChatsArgs = z
  .object({
    query: z.string().min(1).max(1_000),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type SearchChatsArgs = z.infer<typeof SearchChatsArgs>;

export const ChatSearchPort = definePort({
  name: "A0.chatSearch",
  methods: {
    state: { args: z.object({}).strict(), result: ChatSearchState },
    setSettings: { args: SetChatSearchSettingsArgs, result: ChatSearchState },
    /** Embeds one line with the service as set, to see that it answers. */
    test: { args: z.object({}).strict(), result: ChatSearchTest },
    /** The chats closest in meaning, best first, one per chat; empty while search by meaning is off. */
    search: {
      args: SearchChatsArgs,
      result: z.object({ matches: z.array(ChatSearchMatch) }).strict(),
    },
  },
  events: {
    /** The settings or the index's progress changed. */
    changed: { payload: z.object({ at: z.number() }).strict() },
  },
});
export type ChatSearchPort = typeof ChatSearchPort;
export type ChatSearchClient = PortClient<ChatSearchPort>;
export type ChatSearchHandlers<Context> = PortHandlers<ChatSearchPort, Context>;
