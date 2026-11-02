/**
 * One sign-in in a chat, a provider's (`login`) or an MCP server's (`mcp_reauth`) (#2784): its stop, handed to omp as
 * the sign-in's `signal`, and its questions, each carrying the page the sign-in waits on, so wherever a question is
 * answered (the chat, Settings) the page can be opened or copied. A question cancelled or left unanswered stops the
 * sign-in; a question omp ends itself (its own browser answered first) does not.
 */
import type { SignInLink } from "@omp-app/contracts/chat-host";

/** What a sign-in needs from the host's dialogs: `ui.input`, with the sign-in's page. */
export interface SignInDialogs {
  input(
    title: string,
    placeholder?: string,
    dialogOptions?: { readonly timeout?: number; readonly signal?: AbortSignal },
    extra?: { readonly signIn?: SignInLink },
  ): Promise<string | undefined>;
}

/** How long a sign-in's question waits, as omp's own sign-in waits for its browser. */
export const SIGN_IN_QUESTION_MS = 600_000;

/** Thrown into omp's sign-in when its question is cancelled; the command answers `cancelled` instead of failing. */
export class SignInCancelled extends Error {
  constructor() {
    super("Sign-in cancelled");
    this.name = "SignInCancelled";
  }
}

export class SignIn {
  readonly #dialogs: SignInDialogs;
  readonly #name: string;
  readonly #stop = new AbortController();
  #link: SignInLink | null = null;

  constructor(dialogs: SignInDialogs, name: string) {
    this.#dialogs = dialogs;
    this.#name = name;
  }

  /** Aborted once the sign-in is stopped: omp's sign-in takes it as its `signal`. */
  get signal(): AbortSignal {
    return this.#stop.signal;
  }

  get cancelled(): boolean {
    return this.#stop.signal.aborted;
  }

  /** Whether omp has given the page to open yet. */
  get pageOpened(): boolean {
    return this.#link !== null;
  }

  /** The page omp gave to open; every question after carries it. */
  opened(url: string): void {
    this.#link = { url, name: this.#name };
  }

  cancel(): void {
    if (!this.cancelled) this.#stop.abort(new SignInCancelled());
  }

  /**
   * Asks one of the sign-in's questions. `omp` is omp's own signal for the question, when it has one: omp aborts it when
   * its browser answered first, and then nothing waits for this answer.
   */
  async ask(title: string, placeholder?: string, omp?: AbortSignal): Promise<string> {
    const signal = omp === undefined ? this.signal : AbortSignal.any([this.signal, omp]);
    const answer = await this.#dialogs.input(
      title,
      placeholder,
      { timeout: SIGN_IN_QUESTION_MS, signal },
      this.#link === null ? undefined : { signIn: this.#link },
    );
    if (answer !== undefined) return answer;
    if (omp?.aborted === true && !this.cancelled) return "";
    this.cancel();
    throw new SignInCancelled();
  }

  /**
   * Runs omp's sign-in until it ends or is stopped: a stop answers at once, even when the provider's own waiting does
   * not watch the signal. Answers whether it was cancelled; any other failure is thrown.
   */
  async run(signIn: Promise<unknown>): Promise<{ readonly cancelled: boolean }> {
    // A failure after a stop is the stop's, not news.
    signIn.catch(() => undefined);
    const stopped = Promise.withResolvers<void>();
    if (this.cancelled) stopped.resolve();
    else this.signal.addEventListener("abort", () => stopped.resolve(), { once: true });
    try {
      await Promise.race([signIn, stopped.promise]);
    } catch (error) {
      if (this.cancelled) return { cancelled: true };
      throw error;
    }
    return { cancelled: this.cancelled };
  }
}
