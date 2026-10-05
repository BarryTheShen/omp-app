import type { EntryId, OmpMessage, OmpWire, RpcSessionSend, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type { PromptIntent } from "../runtime/runtime";
import type { OmpRuntimeStore, RuntimeMessage, TranscriptEntry } from "../store/store";

export interface BranchingOptions {
  readonly store: OmpRuntimeStore;
  readonly send: RpcSessionSend;
  /** R0.3's one prompt admission path; branching never sends a prompt itself. */
  readonly submitPrompt: (intent: PromptIntent) => Promise<void>;
  /** R0.2's history reload for the newly selected session/head. */
  readonly reloadHistory: () => Promise<void>;
  /** Switches the app's selected thread; R1/R0.3 owns the thread-list/runtime composition. */
  readonly switchThread: (threadId: ThreadId) => Promise<void>;
}

export interface ReadOnlyBranchView {
  readonly readOnly: true;
  readonly entryId: EntryId;
  readonly headId: EntryId;
  readonly entries: readonly TranscriptEntry[];
  readonly messages: readonly RuntimeMessage[];
}

function asFailure(error: unknown, fallback: string): AppFailure {
  if (error instanceof AppFailure) return error;
  return new AppFailure(
    {
      code: "internal",
      message: error instanceof Error ? error.message : fallback,
      retryable: true,
    },
    { cause: error },
  );
}

function notFound(entryId: EntryId): AppFailure {
  return new AppFailure({
    code: "not_found",
    message: `Session entry ${entryId} was not found`,
    retryable: false,
  });
}

function cancelled(message: string): AppFailure {
  return new AppFailure({ code: "cancelled", message, retryable: false });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function entryMessage(entry: TranscriptEntry): OmpMessage | undefined {
  if (!isRecord(entry.raw) || !isRecord(entry.raw.message)) return undefined;
  const role = entry.raw.message.role;
  return role === "user" || role === "developer" || role === "assistant" || role === "toolResult"
    ? (entry.raw.message as unknown as OmpMessage)
    : undefined;
}

function promptFromUserEntry(message: OmpMessage): PromptIntent {
  if (message.role !== "user") {
    throw new AppFailure({
      code: "invalid_args",
      message: "Only a user entry can be regenerated",
      retryable: false,
    });
  }
  const textParts: string[] = [];
  const images: OmpWire.ImageContent[] = [];
  if (typeof message.content === "string") {
    textParts.push(message.content);
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === "text") textParts.push(part.text);
      if (part.type === "image") images.push({ ...part });
    }
  }
  return {
    mode: "prompt",
    text: textParts.join(""),
    ...(images.length > 0 ? { images } : {}),
    delivery: "new",
  };
}

function pathToEntry(
  entries: Readonly<Record<EntryId, TranscriptEntry>>,
  entryId: EntryId,
): TranscriptEntry[] {
  const path: TranscriptEntry[] = [];
  const seen = new Set<EntryId>();
  let current = entries[entryId];
  while (current) {
    if (seen.has(current.id)) break;
    seen.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : entries[current.parentId];
  }
  return path.reverse();
}

/**
 * R0.4's head-changing adapter. Branching changes omp's conversation/session axis only; it never
 * writes files or silently changes the workspace/checkpoint axis. The caller supplies R0.3's sole
 * prompt path and the R0.2 reload/switch seams.
 */
export class OmpBranchingController {
  private readonly store: OmpRuntimeStore;
  private readonly send: RpcSessionSend;
  private readonly submitPrompt: (intent: PromptIntent) => Promise<void>;
  private readonly reloadHistory: () => Promise<void>;
  private readonly switchThread: (threadId: ThreadId) => Promise<void>;

  public constructor(options: BranchingOptions) {
    this.store = options.store;
    this.send = options.send;
    this.submitPrompt = options.submitPrompt;
    this.reloadHistory = options.reloadHistory;
    this.switchThread = options.switchThread;
  }

  /** Branches from a user entry, switches to omp's reported new session, reloads, then submits the edit through R0.3. */
  public async editFrom(entryId: EntryId, intent: PromptIntent): Promise<void> {
    this.requireEntry(entryId);
    await this.branchAndReload(entryId);
    try {
      await this.submitPrompt({ ...intent, delivery: "new" });
    } catch (error) {
      throw asFailure(error, "The edited prompt failed after branching");
    }
  }

  /** Regenerates from an existing user entry without creating a second prompt-send path. */
  public async regenerateFrom(entryId: EntryId): Promise<void> {
    const entry = this.requireEntry(entryId);
    const message = entryMessage(entry);
    if (!message) throw notFound(entryId);
    await this.editFrom(entryId, promptFromUserEntry(message));
  }

  /** Switches to an existing session/thread and reloads its R0 history. */
  public async switchTo(threadId: ThreadId): Promise<void> {
    try {
      await this.switchThread(threadId);
      await this.reloadHistory();
    } catch (error) {
      throw asFailure(error, "Switching the session branch failed");
    }
  }

  /** Returns a read-only root-to-entry projection for branch previews; no store state is changed. */
  public readOnlyBranch(entryId: EntryId): ReadOnlyBranchView {
    this.requireEntry(entryId);
    const snapshot = this.store.getSnapshot();
    const entries = pathToEntry(snapshot.transcript.entries, entryId);
    const ids = new Set(entries.map((entry) => entry.id));
    const messages = snapshot.messageOrder
      .map((key) => snapshot.messages[key])
      .filter(
        (message): message is RuntimeMessage =>
          message !== undefined && message.entryId !== undefined && ids.has(message.entryId),
      );
    return { readOnly: true, entryId, headId: entryId, entries, messages };
  }

  private requireEntry(entryId: EntryId): TranscriptEntry {
    const entry = this.store.getSnapshot().transcript.entries[entryId];
    if (!entry) throw notFound(entryId);
    return entry;
  }

  private async branchAndReload(entryId: EntryId): Promise<ThreadId> {
    const sourceThreadId = this.store.getSnapshot().threadId;
    let result: OmpWire.BranchResult;
    try {
      result = (await this.send({
        threadId: sourceThreadId,
        command: { type: "branch", entryId },
      })) as OmpWire.BranchResult;
    } catch (error) {
      throw asFailure(error, "Branching the session failed");
    }
    if (result.cancelled) throw cancelled("omp cancelled the branch");

    let state: OmpWire.SessionState;
    try {
      state = (await this.send({
        threadId: sourceThreadId,
        command: { type: "get_state" },
      })) as OmpWire.SessionState;
      const nextThreadId = state.sessionId as ThreadId;
      await this.switchThread(nextThreadId);
      await this.reloadHistory();
      return nextThreadId;
    } catch (error) {
      throw asFailure(error, "The branched session did not become available");
    }
  }
}

export function createOmpBranchingController(options: BranchingOptions): OmpBranchingController {
  return new OmpBranchingController(options);
}
