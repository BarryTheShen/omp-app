import {
  AssistantRuntimeProvider,
  MessageByIndexProvider,
  MessagePrimitive,
  type ThreadMessageLike,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import type { ThreadId } from "@omp-app/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { BranchPicker } from "../branch-picker";
import type { BranchRepositoryItem } from "../contract";
import { SOURCE_CHAT } from "../fixtures/omp-branch";
import {
  type AssistantBranchRepository,
  type BranchHeadStorage,
  createBranchRepository,
} from "../repository";
import { HEAD_KEY_PREFIX } from "../repository/repository";

afterEach(cleanup);

const threadId: ThreadId = SOURCE_CHAT;

function message(id: string, text: string): ThreadMessageLike {
  return { role: "assistant", id, content: [{ type: "text", text }], metadata: { custom: {} } };
}

/** A root with two answers. `child` is listed first on purpose: import must put the parent first. */
function siblingItems(): readonly BranchRepositoryItem<ThreadMessageLike>[] {
  return [
    { message: message("child", "first answer"), parentId: "root" },
    { message: message("root", "question"), parentId: null },
    { message: message("sibling", "second answer"), parentId: "root" },
  ];
}

function memoryStorage(): BranchHeadStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}

/**
 * The message's branch picker, mounted the way a message row mounts it: inside the message, at its index.
 * `setMessages` is what lets assistant-ui offer branch switching at all (its `switchToBranch` capability).
 */
function PickerAt({
  repository,
  index,
}: {
  readonly repository: AssistantBranchRepository<ThreadMessageLike>;
  readonly index: number;
}) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages: repository.snapshot().items.map((item) => item.message),
    messageRepository: repository.exported(),
    setMessages: () => undefined,
    onNew: async () => undefined,
    convertMessage: (value) => value,
  });
  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <MessageByIndexProvider index={index}>
        <MessagePrimitive.Root>
          <BranchPicker />
        </MessagePrimitive.Root>
      </MessageByIndexProvider>
    </AssistantRuntimeProvider>
  );
}

describe("acceptance: assistant-ui branches import, switch, persist and reload", () => {
  test("two sibling answers import parents first, the picked head is persisted, and a reload reads it back", async () => {
    const storage = memoryStorage();
    const options = {
      threadId,
      items: siblingItems(),
      storage,
    };
    const first = createBranchRepository({ ...options, headId: "child" });

    expect(first.snapshot().items.map((item) => item.message.id)).toEqual([
      "root",
      "child",
      "sibling",
    ]);
    expect(first.exported()).toMatchObject({
      headId: "child",
      messages: [
        { parentId: null, message: { id: "root" } },
        { parentId: "root", message: { id: "child" } },
        { parentId: "root", message: { id: "sibling" } },
      ],
    });

    await first.switchHead("sibling");
    expect(first.snapshot().headId).toBe("sibling");
    expect(storage.getItem(`${HEAD_KEY_PREFIX}${threadId}`)).toBe("sibling");

    // The reload starts from the head it was given, "child": only a stored "sibling" can make it read "sibling".
    const reloaded = createBranchRepository({ ...options, headId: "child" });
    expect(reloaded.snapshot().headId).toBe("sibling");
    expect(reloaded.snapshot().items.map((item) => item.message.id)).toEqual([
      "root",
      "child",
      "sibling",
    ]);
  });

  test("at the last of two versions Next is disabled and Previous is enabled", () => {
    const repository = createBranchRepository({
      threadId,
      items: siblingItems(),
      headId: "sibling",
      storage: memoryStorage(),
    });

    render(<PickerAt index={1} repository={repository} />);

    expect(screen.getByLabelText("Branch position").textContent).toBe("2 / 2");
    expect(screen.getByRole("button", { name: "Next branch" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Previous branch" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  test("at the first of two versions Previous is disabled and Next is enabled", () => {
    const repository = createBranchRepository({
      threadId,
      items: siblingItems(),
      headId: "child",
      storage: memoryStorage(),
    });

    render(<PickerAt index={1} repository={repository} />);

    expect(screen.getByLabelText("Branch position").textContent).toBe("1 / 2");
    expect(screen.getByRole("button", { name: "Previous branch" })).toHaveProperty(
      "disabled",
      true,
    );
    expect(screen.getByRole("button", { name: "Next branch" })).toHaveProperty("disabled", false);
  });

  test("a message with one version shows no picker", () => {
    const repository = createBranchRepository({
      threadId,
      items: [{ message: message("only", "one answer"), parentId: null }],
      storage: memoryStorage(),
    });

    render(<PickerAt index={0} repository={repository} />);

    expect(screen.queryByLabelText("Branch position")).toBeNull();
  });

  test("a head that is not a message in the repository is refused as not found, and the head stays", async () => {
    const repository = createBranchRepository({
      threadId,
      items: siblingItems(),
      headId: "child",
      storage: memoryStorage(),
    });

    await expect(repository.switchHead("missing-message")).rejects.toMatchObject({
      appError: { code: "not_found" },
    });
    expect(repository.snapshot().headId).toBe("child");
  });

  test("a refetch takes the head it reads back", async () => {
    const repository = createBranchRepository({
      threadId,
      items: siblingItems(),
      headId: "child",
      storage: memoryStorage(),
      refetch: async () => ({ threadId, headId: "sibling", items: siblingItems() }),
    });

    await repository.refetch();

    expect(repository.snapshot().headId).toBe("sibling");
  });

  test("a refetch that names a missing head is refused as invalid, and the head stays", async () => {
    const repository = createBranchRepository({
      threadId,
      items: siblingItems(),
      headId: "child",
      storage: memoryStorage(),
      refetch: async () => ({ threadId, headId: "missing-message", items: siblingItems() }),
    });

    await expect(repository.refetch()).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });
    expect(repository.snapshot().headId).toBe("child");
  });

  test("a refused refetch keeps the visible items as well as the head (spec §4.1; follow-up #1723)", async () => {
    const repository = createBranchRepository({
      threadId,
      items: siblingItems(),
      headId: "child",
      storage: memoryStorage(),
      refetch: async () => ({ threadId, headId: "missing-message", items: [] }),
    });
    const before = repository.snapshot().items;

    await expect(repository.refetch()).rejects.toMatchObject({
      appError: { code: "invalid_args" },
    });

    expect(repository.snapshot().items).toEqual(before);
  });

  test("a head switch never needs omp: with no branch command the picker still switches the visible repository (spec §4.1 and §5.9)", async () => {
    const repository = createBranchRepository({
      threadId,
      items: siblingItems(),
      headId: "child",
      storage: memoryStorage(),
    });

    await repository.switchHead("sibling");

    expect(repository.snapshot().headId).toBe("sibling");
  });
});
