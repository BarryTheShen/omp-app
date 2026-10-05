import { ExportedMessageRepository, type ThreadMessageLike } from "@assistant-ui/react";
import type { CapabilityKey, ThreadId } from "@omp-app/contracts";
import { AppFailure } from "@omp-app/contracts";
import type {
  BranchRepositoryItem,
  BranchRepositoryPort,
  BranchRepositorySnapshot,
} from "../contract";

export interface BranchHeadStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface BranchRepositoryOptions<TMessage extends ThreadMessageLike> {
  readonly threadId: ThreadId;
  readonly items: readonly BranchRepositoryItem<TMessage>[];
  readonly headId?: string | null;
  readonly storage?: BranchHeadStorage;
  readonly switchBranch?: (headId: string) => Promise<BranchRepositorySnapshot<TMessage>>;
  readonly refetch?: () => Promise<BranchRepositorySnapshot<TMessage>>;
}

export interface AssistantBranchRepository<TMessage extends ThreadMessageLike>
  extends BranchRepositoryPort<TMessage> {
  exported(): ReturnType<typeof ExportedMessageRepository.fromBranchableArray>;
}

const HEAD_KEY_PREFIX = "omp-app:p3:branch-head:";

function defaultStorage(): BranchHeadStorage | undefined {
  return typeof window === "undefined" ? undefined : window.sessionStorage;
}

function storageKey(threadId: ThreadId): string {
  return `${HEAD_KEY_PREFIX}${threadId}`;
}

function failure(code: "invalid_args" | "not_found" | "internal", message: string): AppFailure {
  return new AppFailure({ code, message, retryable: code === "internal" });
}

function parentsFirst<TMessage extends ThreadMessageLike>(
  items: readonly BranchRepositoryItem<TMessage>[],
): readonly BranchRepositoryItem<TMessage>[] {
  const pending = [...items];
  const ordered: BranchRepositoryItem<TMessage>[] = [];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const before = pending.length;
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const item = pending[index];
      if (!item) continue;
      if (item.parentId !== null && !seen.has(item.parentId)) continue;
      pending.splice(index, 1);
      const id = item.message.id;
      if (!id) throw failure("invalid_args", "Branch repository messages need stable ids");
      if (seen.has(id)) throw failure("invalid_args", `Duplicate branch message id: ${id}`);
      seen.add(id);
      ordered.push(item);
    }
    if (pending.length === before) {
      throw failure("invalid_args", "Branch repository contains an orphaned or cyclic parent");
    }
  }
  return ordered;
}

export function createBranchRepository<TMessage extends ThreadMessageLike>(
  options: BranchRepositoryOptions<TMessage>,
): AssistantBranchRepository<TMessage> {
  const storage = options.storage ?? defaultStorage();
  const key = storageKey(options.threadId);
  let ordered = parentsFirst(options.items);
  const validHeads = () =>
    new Set(ordered.map((item) => item.message.id).filter((id): id is string => Boolean(id)));
  let headId = options.headId ?? ordered.at(-1)?.message.id ?? null;
  if (headId !== null && !validHeads().has(headId)) {
    throw failure("invalid_args", "Initial branch head is not present in the repository");
  }
  try {
    const persisted = storage?.getItem(key);
    if (
      persisted !== null &&
      persisted !== undefined &&
      (persisted === "" || validHeads().has(persisted))
    )
      headId = persisted || null;
  } catch {
    // Session storage is an optional persistence layer; the in-memory head remains usable.
  }
  const currentSnapshot = (): BranchRepositorySnapshot<TMessage> => ({
    threadId: options.threadId,
    headId,
    items: ordered,
  });
  const persist = async (nextHead: string | null): Promise<void> => {
    try {
      storage?.setItem(key, nextHead ?? "");
    } catch (error) {
      throw new AppFailure(
        {
          code: "internal",
          message: "The selected branch could not be persisted",
          retryable: true,
        },
        { cause: error },
      );
    }
    headId = nextHead;
  };
  return {
    snapshot: currentSnapshot,
    async switchHead(nextHead) {
      if (!validHeads().has(nextHead))
        throw failure("not_found", "The selected branch is no longer present");
      if (!options.switchBranch) {
        throw new AppFailure({
          code: "unavailable",
          message: "Branch switching requires R0.4's branch action",
          retryable: false,
          capability: "omp.cmd.branch" satisfies CapabilityKey,
        });
      }
      const next = await options.switchBranch(nextHead);
      ordered = parentsFirst(next.items);
      const resolvedHead = next.headId ?? nextHead;
      if (!validHeads().has(resolvedHead)) {
        throw failure("invalid_args", "R0.4 returned a branch head that is not present");
      }
      await persist(resolvedHead);
      return currentSnapshot();
    },
    async persistHead(nextHead) {
      if (nextHead !== null && !validHeads().has(nextHead)) {
        throw failure("not_found", "The selected branch is no longer present");
      }
      await persist(nextHead);
    },
    async refetch() {
      if (!options.refetch) return currentSnapshot();
      const next = await options.refetch();
      ordered = parentsFirst(next.items);
      if (next.headId !== null && !validHeads().has(next.headId)) {
        throw failure("invalid_args", "Refetched branch head is not present in the repository");
      }
      headId = next.headId;
      return currentSnapshot();
    },
    exported() {
      return ExportedMessageRepository.fromBranchableArray(ordered, { headId });
    },
  };
}

export { HEAD_KEY_PREFIX };
