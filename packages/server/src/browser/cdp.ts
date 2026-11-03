/** An event from the browser over the Chrome DevTools Protocol; `sessionId` names the page session it came from. */
export interface CdpEvent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId?: string;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

/**
 * One WebSocket to a browser's DevTools endpoint (the browser's own target, sessions flattened onto it): numbered
 * requests and their answers, and the events to every listener. When the browser goes away, every request still waiting
 * fails with a plain error, and the close listeners hear it.
 */
export class CdpConnection {
  readonly #socket: WebSocket;
  readonly #pending = new Map<number, Pending>();
  readonly #listeners = new Set<(event: CdpEvent) => void>();
  readonly #closeListeners = new Set<() => void>();
  #next = 1;
  #closed = false;

  private constructor(socket: WebSocket) {
    this.#socket = socket;
    socket.addEventListener("message", (message) => this.#receive(String(message.data)));
    socket.addEventListener("close", () => this.#close());
    socket.addEventListener("error", () => this.#close());
  }

  /** Connects to a `ws://` DevTools address; fails when the browser does not answer within `timeoutMs`. */
  static open(url: string, timeoutMs = 10_000): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const timer = setTimeout(() => {
        socket.close();
        reject(new Error("The browser did not answer on its DevTools address."));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpConnection(socket));
      });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new Error("The browser refused its DevTools connection."));
      });
    });
  }

  get closed(): boolean {
    return this.#closed;
  }

  send<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.#closed) return Promise.reject(new Error("The browser is not running."));
    const id = this.#next++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.#socket.send(
        JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }),
      );
    });
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#closeListeners.add(listener);
    return () => this.#closeListeners.delete(listener);
  }

  close(): void {
    this.#socket.close();
    this.#close();
  }

  #receive(text: string): void {
    let message: {
      id?: number;
      result?: unknown;
      error?: { message?: string };
      method?: string;
      params?: Record<string, unknown>;
      sessionId?: string;
    };
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (pending === undefined) return;
      this.#pending.delete(message.id);
      if (message.error !== undefined)
        pending.reject(new Error(message.error.message ?? "The browser refused the request."));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (message.method === undefined) return;
    const event: CdpEvent = {
      method: message.method,
      params: message.params ?? {},
      ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
    };
    for (const listener of this.#listeners) listener(event);
  }

  #close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values())
      pending.reject(new Error("The browser closed the connection."));
    this.#pending.clear();
    for (const listener of this.#closeListeners) listener();
  }
}
