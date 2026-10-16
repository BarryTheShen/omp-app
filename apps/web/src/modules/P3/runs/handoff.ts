import type { AppFailure, ThreadId } from "@omp-app/contracts";
import type { PromptIntent } from "@/modules/R0/runtime";
import { runFailure } from "./failure";

/** A chat's runtime as a run needs it: it sends a prompt. R0.3's runtime controller is one. */
export interface P3PromptRuntime {
  submitPrompt(intent: PromptIntent): Promise<void>;
}

export interface P3ThreadHandoffOptions {
  /** Runs once omp admits a prompt on the chat a branch opened. The composition arms its sidebar refresh here. */
  readonly onAdmitted?: (() => void) | undefined;
  /** How long a send waits for the new chat to mount before it gives up. */
  readonly mountTimeoutMs?: number;
}

interface Waiter {
  readonly threadId: string;
  readonly resolve: (runtime: P3PromptRuntime) => void;
  readonly reject: (failure: AppFailure) => void;
  readonly timer: number;
}

const DEFAULT_MOUNT_TIMEOUT_MS = 30_000;

/**
 * Sends a branch's prompt on the chat the branch opened. Opening a chat unmounts the chat that started
 * the branch, so its runtime can no longer send: the prompt waits for the new chat's runtime to mount
 * and goes through that one.
 */
export class P3ThreadHandoff {
  private readonly runtimes = new Map<string, P3PromptRuntime>();
  private readonly onAdmitted: (() => void) | undefined;
  private readonly mountTimeoutMs: number;
  private waiter: Waiter | null = null;
  private opened: ThreadId | null = null;
  private branchOpened = false;

  public constructor(options: P3ThreadHandoffOptions = {}) {
    this.onAdmitted = options.onAdmitted;
    this.mountTimeoutMs = options.mountTimeoutMs ?? DEFAULT_MOUNT_TIMEOUT_MS;
  }

  /** The chat the current run opened, or null before a branch opens one. */
  public get target(): ThreadId | null {
    return this.opened;
  }

  /** Whether omp accepted a branch for the current run, even if its new session is not reconciled yet. */
  public get branched(): boolean {
    return this.branchOpened;
  }

  /** A run starts: no chat is open for it yet, and a send still waiting for an earlier run is dropped. */
  public beginRun(): void {
    this.opened = null;
    this.branchOpened = false;
    this.dropWaiter(runFailure("cancelled", "The earlier send was replaced by a new one.", false));
  }

  /** Records omp's successful branch response before the follow-up state read. */
  public markBranched(): void {
    this.branchOpened = true;
  }

  /** A branch opened `threadId`: the run's next send goes to that chat. */
  public expect(threadId: ThreadId): void {
    this.opened = threadId;
    if (this.waiter !== null && this.waiter.threadId !== String(threadId)) {
      this.dropWaiter(
        runFailure("cancelled", "The new chat was replaced before the message was sent.", false),
      );
    }
  }

  /** A chat's runtime mounted. The returned function detaches it when the chat unmounts. */
  public attach(threadId: ThreadId, runtime: P3PromptRuntime): () => void {
    const key = String(threadId);
    this.runtimes.set(key, runtime);
    if (this.waiter !== null && this.waiter.threadId === key) {
      const waiter = this.waiter;
      this.waiter = null;
      window.clearTimeout(waiter.timer);
      waiter.resolve(runtime);
    }
    return () => {
      if (this.runtimes.get(key) === runtime) this.runtimes.delete(key);
    };
  }

  /**
   * Sends `intent` on the chat the run opened, once that chat's runtime is mounted. Resolves with that
   * chat's id once omp admits the prompt.
   */
  public async submit(intent: PromptIntent): Promise<ThreadId> {
    const threadId = this.opened;
    if (threadId === null) {
      throw runFailure("conflict", "No new chat is open for this message.", false);
    }
    const runtime = this.runtimes.get(String(threadId)) ?? (await this.waitForRuntime(threadId));
    await runtime.submitPrompt(intent);
    this.onAdmitted?.();
    return threadId;
  }

  private waitForRuntime(threadId: ThreadId): Promise<P3PromptRuntime> {
    this.dropWaiter(runFailure("cancelled", "The earlier send was replaced by a new one.", false));
    const { promise, resolve, reject } = Promise.withResolvers<P3PromptRuntime>();
    const timer = window.setTimeout(() => {
      if (this.waiter?.timer === timer) this.waiter = null;
      reject(runFailure("timeout", "The new chat did not open in time. Try again.", true));
    }, this.mountTimeoutMs);
    this.waiter = { threadId: String(threadId), resolve, reject, timer };
    return promise;
  }

  private dropWaiter(failure: AppFailure): void {
    if (this.waiter === null) return;
    const waiter = this.waiter;
    this.waiter = null;
    window.clearTimeout(waiter.timer);
    waiter.reject(failure);
  }
}
