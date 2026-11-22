/**
 * The chats allowed to reach this computer (#20, PLAN §7f): a chat asks, the person allows it with their password, and
 * the grant stays until they remove it. Kept by the person's agent in its data folder (`chat-grants.json`, owner-only),
 * one entry per chat of a server; requests wait in memory until answered.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

export const ChatGrant = z.strictObject({
  threadId: z.string().min(1).max(200),
  /** The chat's name when it was allowed. */
  chat: z.string().max(120),
  /** The server the chat runs on (the link's address). */
  server: z.string().max(500),
  grantedAt: z.string(),
});
export type ChatGrant = z.infer<typeof ChatGrant>;

/** A chat asking to reach this computer, waiting for the person. */
export interface ChatRequest {
  readonly threadId: string;
  readonly chat: string;
  readonly server: string;
  readonly askedAt: string;
}

const GrantsFile = z.strictObject({ version: z.literal(1), grants: z.array(ChatGrant) });

/** Control and direction characters: a chat's name is shown as one plain line. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: removing control characters is the point
const UNSHOWN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g;

/** A chat's name as one plain line, at most 120 characters. */
export const chatName = (text: string): string =>
  text.replace(UNSHOWN, " ").trim().slice(0, 120) || "A chat";

export class ChatGrants {
  readonly #file: string;
  #grants: ChatGrant[] = [];
  readonly #requests = new Map<string, ChatRequest>();

  private constructor(file: string) {
    this.#file = file;
  }

  /** The list in `file`; one that cannot be read counts as no grants. */
  static async open(file: string): Promise<ChatGrants> {
    const grants = new ChatGrants(file);
    try {
      grants.#grants = GrantsFile.parse(JSON.parse(await readFile(file, "utf8"))).grants;
    } catch {
      grants.#grants = [];
    }
    return grants;
  }

  /** The grants of the chats of `server`. */
  of(server: string): readonly ChatGrant[] {
    return this.#grants.filter((grant) => grant.server === server);
  }

  allowed(server: string, threadId: string | null): boolean {
    return (
      threadId !== null &&
      this.#grants.some((each) => each.server === server && each.threadId === threadId)
    );
  }

  get requests(): readonly ChatRequest[] {
    return [...this.#requests.values()];
  }

  /** A chat asked; true when the request is new (the person is told once while it waits). */
  ask(server: string, threadId: string, chat: string, now: Date): boolean {
    if (this.allowed(server, threadId) || this.#requests.has(threadId)) return false;
    this.#requests.set(threadId, {
      threadId,
      chat: chatName(chat),
      server,
      askedAt: now.toISOString(),
    });
    return true;
  }

  deny(threadId: string): boolean {
    return this.#requests.delete(threadId);
  }

  /** Allows a waiting request (after the person's password). */
  async allow(threadId: string, now: Date): Promise<ChatGrant | null> {
    const request = this.#requests.get(threadId);
    if (request === undefined) return null;
    return this.grant(request.server, threadId, request.chat, now);
  }

  /**
   * Allows a chat the person picked themselves, without its asking (after their password); a request it had waiting is
   * answered by it.
   */
  async grant(server: string, threadId: string, chat: string, now: Date): Promise<ChatGrant> {
    const grant: ChatGrant = {
      threadId,
      chat: chatName(chat),
      server,
      grantedAt: now.toISOString(),
    };
    await this.#save([...this.#grants.filter((each) => each.threadId !== threadId), grant]);
    this.#requests.delete(threadId);
    return grant;
  }

  async remove(threadId: string): Promise<boolean> {
    const kept = this.#grants.filter((each) => each.threadId !== threadId);
    if (kept.length === this.#grants.length) return false;
    await this.#save(kept);
    return true;
  }

  /** Forgets every grant and request (agent access is removed). */
  async clear(): Promise<void> {
    this.#requests.clear();
    await this.#save([]);
  }

  async #save(grants: ChatGrant[]): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, grants })}\n`, { mode: 0o600 });
    await rename(temporary, this.#file);
    this.#grants = grants;
  }
}
