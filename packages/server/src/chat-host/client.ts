/**
 * The server's side of the chat host protocol (SDK plan H5.1): requests to one chat host and its events, over the host's
 * stdin and stdout. It works on any line duplex; `OmpProcess` (`process/omp-process.ts`) is one.
 *
 * - `hello` resolves with the host's first line, and rejects if the host ends before sending it.
 * - `request` resolves with the method's result, or rejects with `ChatHostRequestError` (the host's code and message,
 *   or `closed` when the host ended first). Requests may be answered out of order; each answer carries its id.
 * - Events reach `onEvent` listeners in the order the host wrote them.
 */
import {
  type ChatHostErrorCode,
  type ChatHostHello,
  type ChatHostMethod,
  type ChatHostMethodMap,
  parseHostLine,
} from "@omp-app/contracts/chat-host";
import type { ChatEvent } from "./events";

/** A transport of lines: the host's stdin to write, its stdout to read. */
export interface LineDuplex {
  /** Writes one line, including its newline. */
  writeLine(line: string): void | PromiseLike<void>;
  onChunk(listener: (chunk: Uint8Array) => void): () => void;
  onClose(listener: (cause?: unknown) => void): () => void;
}

export class ChatHostRequestError extends Error {
  readonly code: ChatHostErrorCode | "closed";
  constructor(code: ChatHostErrorCode | "closed", message: string) {
    super(message);
    this.name = "ChatHostRequestError";
    this.code = code;
  }
}

export type ChatEventListener = (event: ChatEvent, seq: number) => void;

interface Pending {
  readonly resolve: (result: unknown) => void;
  readonly reject: (error: ChatHostRequestError) => void;
}

export class ChatHostClient {
  readonly hello: Promise<ChatHostHello>;
  readonly #duplex: LineDuplex;
  readonly #pending = new Map<string, Pending>();
  readonly #listeners = new Set<ChatEventListener>();
  readonly #onInvalidLine: (reason: string) => void;
  readonly #helloSettled: {
    resolve: (hello: ChatHostHello) => void;
    reject: (error: Error) => void;
  };
  readonly #unsubscribe: (() => void)[];
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #nextId = 0;
  #closed: ChatHostRequestError | undefined;

  constructor(
    duplex: LineDuplex,
    options: { readonly onInvalidLine?: (reason: string) => void } = {},
  ) {
    this.#duplex = duplex;
    this.#onInvalidLine = options.onInvalidLine ?? (() => undefined);
    const hello = Promise.withResolvers<ChatHostHello>();
    this.hello = hello.promise;
    // A host that never says hello rejects it; a caller that never asks must not see an unhandled rejection.
    this.hello.catch(() => undefined);
    this.#helloSettled = hello;
    this.#unsubscribe = [
      duplex.onChunk((chunk) => this.#read(chunk)),
      duplex.onClose(() => this.#end(new ChatHostRequestError("closed", "The chat host ended."))),
    ];
  }

  request<M extends ChatHostMethod>(
    method: M,
    params: ChatHostMethodMap[M]["params"],
  ): Promise<ChatHostMethodMap[M]["result"]> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = String(++this.#nextId);
    const answer = Promise.withResolvers<ChatHostMethodMap[M]["result"]>();
    this.#pending.set(id, {
      resolve: (result) => answer.resolve(result as ChatHostMethodMap[M]["result"]),
      reject: answer.reject,
    });
    Promise.resolve(
      this.#duplex.writeLine(`${JSON.stringify({ kind: "request", id, method, params })}\n`),
    ).catch((error: unknown) => {
      this.#settle(id, () =>
        answer.reject(
          new ChatHostRequestError(
            "closed",
            `The request could not be sent: ${error instanceof Error ? error.message : String(error)}`,
          ),
        ),
      );
    });
    return answer.promise;
  }

  onEvent(listener: ChatEventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Stops reading the host; open requests reject as closed. */
  dispose(): void {
    this.#end(new ChatHostRequestError("closed", "The chat host client was closed."));
  }

  #read(chunk: Uint8Array): void {
    this.#buffer += this.#decoder.decode(chunk, { stream: true });
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      newline = this.#buffer.indexOf("\n");
      if (line.trim() !== "") this.#handle(line);
    }
  }

  #handle(line: string): void {
    const parsed = parseHostLine(line);
    if (!parsed.ok) {
      this.#onInvalidLine(parsed.error.message);
      return;
    }
    const message = parsed.value;
    switch (message.kind) {
      case "hello":
        this.#helloSettled.resolve(message);
        return;
      case "response":
        this.#settle(message.id, (pending) => {
          if (message.ok) pending.resolve(message.result);
          else pending.reject(new ChatHostRequestError(message.error.code, message.error.message));
        });
        return;
      case "event": {
        // The host writes the events it builds; the envelope check above is the boundary.
        const event = message.event as ChatEvent;
        for (const listener of this.#listeners) listener(event, message.seq);
        return;
      }
    }
  }

  #settle(id: string, settle: (pending: Pending) => void): void {
    const pending = this.#pending.get(id);
    if (!pending) {
      this.#onInvalidLine(`an answer to no open request (${id})`);
      return;
    }
    this.#pending.delete(id);
    settle(pending);
  }

  #end(reason: ChatHostRequestError): void {
    if (this.#closed) return;
    this.#closed = reason;
    for (const unsubscribe of this.#unsubscribe) unsubscribe();
    this.#helloSettled.reject(reason);
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
  }
}
