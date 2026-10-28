import type { AppendMessage } from "@assistant-ui/react";
import {
  type AppError,
  AppFailure,
  type CapabilityKey,
  type ChatSessionRequest,
  type EntryId,
  type Omp,
  type ThreadId,
} from "@omp-app/contracts";
import { renderHook } from "@testing-library/react";
import type { PromptIntent } from "@/modules/R0/runtime";
import { OmpRuntimeStore } from "@/modules/R0/store";
import type { EditRunDecorator } from "../contract";
import {
  ASSISTANT_ANSWER,
  BRANCH_ACCEPTED,
  SOURCE_CHAT,
  STATE_AFTER_BRANCH,
  storedAssistant,
  storedUserText,
  storedUserWithImage,
  USER_TEXT_ONLY,
  USER_WITH_IMAGE,
} from "../fixtures/omp-branch";
import type { P3RunHandlers } from "../runs/handlers";
import type { P3PromptRuntime } from "../runs/handoff";
import { useP3RunHandlers } from "../runs/hooks";
import { createP3Runs, type P3Runs } from "../runs/runs";

/** One request the app sent to omp, as the transport saw it. */
export interface SentCommand {
  readonly threadId: string;
  readonly type: string;
  readonly entryId?: string;
}

/** The prompt runtime of one chat: every prompt it was asked to send, and the ones omp admitted. */
export interface ChatRuntime extends P3PromptRuntime {
  readonly attempts: PromptIntent[];
  readonly admitted: PromptIntent[];
}

export interface RunOptions {
  /** The source chat's store. Defaults to `sourceStore()`. */
  readonly store?: OmpRuntimeStore;
  /**
   * omp's answers to successive `branch` commands: a result, or the failure omp raises. The last answer
   * repeats. Defaults to an accepted branch.
   */
  readonly branch?: readonly (Omp.BranchResult | Error)[];
  /** omp's answer to `get_state` after a branch. Defaults to the branched chat. */
  readonly getState?: { readonly sessionId: string } | Error;
  /** Opening the new chat fails with this error. */
  readonly openFails?: Error;
  /** False: the new chat's runtime never mounts, so a prompt for it waits. Defaults to true. */
  readonly mountsNewChat?: boolean;
  /** Errors the new chat's prompt raises, one per attempt, in order. */
  readonly promptFailures?: readonly Error[];
  /** How long a prompt waits for its new chat to mount. Defaults to the app's own default. */
  readonly mountTimeoutMs?: number;
  readonly decorator?: EditRunDecorator;
}

export interface RunHarness {
  readonly store: OmpRuntimeStore;
  readonly stores: Map<string, OmpRuntimeStore>;
  readonly handlers: P3RunHandlers;
  readonly runs: P3Runs;
  /** Every command the app sent to omp, in order. */
  readonly sent: SentCommand[];
  /** Chats the composition asked to open, in order. */
  readonly opened: string[];
  /** The runtime of each chat that mounted, by thread id. */
  readonly chats: Map<string, ChatRuntime>;
  mount(threadId: ThreadId): ChatRuntime;
  /** Opens another chat, as the app does when a person follows a chat link. */
  open(threadId: ThreadId): Promise<void>;
}

/** A recording prompt runtime; `failures` are raised by the attempts that come first. */
export function chatRuntime(failures: readonly Error[] = []): ChatRuntime {
  const queue = [...failures];
  const attempts: PromptIntent[] = [];
  const admitted: PromptIntent[] = [];
  return {
    attempts,
    admitted,
    async submitPrompt(intent) {
      attempts.push(intent);
      const failure = queue.shift();
      if (failure) throw failure;
      admitted.push(intent);
    },
  };
}

/** omp's answer to one command: the value, or the error it raises. */
function answer<T>(value: T | Error): T {
  if (value instanceof Error) throw value;
  return value;
}

/**
 * The transport omp sits behind. It answers the two requests a branch sends and nothing else: every other request
 * throws, so a flow that sends an unexpected request fails loudly instead of passing.
 */
export function ompTransport(options: Pick<RunOptions, "branch" | "getState">): {
  readonly send: ChatSessionRequest;
  readonly sent: SentCommand[];
} {
  const sent: SentCommand[] = [];
  const branchAnswers = options.branch ?? [BRANCH_ACCEPTED];
  let branchCalls = 0;
  const send = (async (args: {
    threadId: ThreadId;
    method: string;
    params: { readonly entryId?: string };
  }) => {
    const entry = args.params.entryId === undefined ? {} : { entryId: args.params.entryId };
    sent.push({ threadId: String(args.threadId), type: args.method, ...entry });
    switch (args.method) {
      case "branch": {
        const last = branchAnswers.length - 1;
        if (last < 0) throw new Error("The run harness needs at least one branch answer");
        const next = branchAnswers[Math.min(branchCalls, last)];
        branchCalls += 1;
        return answer(next ?? BRANCH_ACCEPTED);
      }
      case "get_state":
        return answer(options.getState ?? STATE_AFTER_BRANCH);
      default:
        throw new Error(`The run harness does not answer ${args.method}`);
    }
  }) as unknown as ChatSessionRequest;
  return { send, sent };
}

/**
 * The source chat: a text-only message, then a text-and-image message with its answer, all on one branch.
 * Seeded the way omp's session file is read: `pairEndedMessages` takes the stored entries as they are.
 */
export function sourceStore(): OmpRuntimeStore {
  const store = new OmpRuntimeStore({ threadId: SOURCE_CHAT });
  store.pairEndedMessages(
    [
      storedUserText(USER_TEXT_ONLY, null, "Earlier question"),
      storedUserWithImage(USER_WITH_IMAGE, USER_TEXT_ONLY),
      storedAssistant(ASSISTANT_ANSWER, USER_WITH_IMAGE),
    ],
    ASSISTANT_ANSWER,
  );
  return store;
}

/**
 * The composition P3 mounts in the app: `useP3RunHandlers`, with R0's real branching controller, the store and
 * P3's handoff. The doubles are omp's transport (its answers, and its failures), the composition's `switchChat` (which
 * opens a chat and can be told to fail or not mount), and the new chat's prompt runtime (its refusals).
 */
export function renderRun(options: RunOptions = {}): RunHarness {
  const store = options.store ?? sourceStore();
  const activeStores = new Map([[String(store.getSnapshot().threadId), store]]);
  const transport = ompTransport(options);
  const runs = createP3Runs(
    options.mountTimeoutMs === undefined ? {} : { mountTimeoutMs: options.mountTimeoutMs },
  );
  const opened: string[] = [];
  const chats = new Map<string, ChatRuntime>();
  let rerender: ((props: { readonly store: OmpRuntimeStore }) => void) | undefined;
  const mount = (threadId: ThreadId): ChatRuntime => {
    const runtime = chatRuntime(options.promptFailures);
    chats.set(String(threadId), runtime);
    runs.handoff.attach(threadId, runtime);
    return runtime;
  };
  // The app's switchChat: switching to the new chat loads a distinct runtime store before its prompt can settle.
  const switchChat = async (threadId: ThreadId): Promise<void> => {
    opened.push(String(threadId));
    if (options.openFails) throw options.openFails;
    const nextStore = new OmpRuntimeStore({ threadId });
    activeStores.set(String(threadId), nextStore);
    rerender?.({ store: nextStore });
    if (options.mountsNewChat === false) return;
    mount(threadId);
  };
  const hook = renderHook(
    ({ store: currentStore }: { readonly store: OmpRuntimeStore }) =>
      useP3RunHandlers({
        store: currentStore,
        send: transport.send,
        switchChat,
        runs,
        decorator: options.decorator,
      }),
    { initialProps: { store } },
  );
  rerender = hook.rerender;
  return {
    store,
    stores: activeStores,
    handlers: hook.result.current,
    runs,
    sent: transport.sent,
    opened,
    chats,
    mount,
    open: (threadId) => switchChat(threadId),
  };
}

/**
 * The append assistant-ui hands `onEdit`: the replacement text and images, and the id of the message it edits
 * (`sourceId`). assistant-ui's AppendMessage has more fields than the handlers read, so the rest is left out.
 */
export function editAppend(
  sourceId: string | null,
  text: string,
  images: readonly Omp.ImageContent[] = [],
): AppendMessage {
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((image) => ({
        type: "image",
        image: `data:${image.mimeType};base64,${image.data}`,
      })),
    ],
    attachments: [],
    metadata: { custom: {} },
    createdAt: new Date(0),
    parentId: null,
    sourceId,
    runConfig: undefined,
  } as unknown as AppendMessage;
}

/** The row key assistant-ui knows a stored message by (what `onReload` receives as its parent id). */
export function rowKeyOf(store: OmpRuntimeStore, entryId: EntryId): string {
  const snapshot = store.getSnapshot();
  const key = snapshot.messageOrder.find((candidate) => {
    const message = snapshot.messages[candidate];
    return message?.entryId === entryId;
  });
  if (key === undefined) throw new Error(`No row holds ${String(entryId)}`);
  return key;
}

/** A failure the way the app's transport raises one: an AppFailure with the given code. */
export function failure(
  code: AppError["code"],
  message: string,
  retryable: boolean,
  capability?: CapabilityKey,
): AppFailure {
  return new AppFailure({
    code,
    message,
    retryable,
    ...(capability === undefined ? {} : { capability }),
  });
}
