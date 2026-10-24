import type { AppClient } from "@omp-app/client";
import {
  AppFailure,
  type CapabilityMap,
  FolderPath,
  type GithubReference,
  GithubRefsPort,
  type GitState,
  GitStatePort,
  type HostMetadata,
  HostMetadataPort,
  ThreadId,
} from "@omp-app/contracts";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { AgentRosterStoreSnapshot } from "@/modules/P1/roster";
import type { RuntimeSnapshot, SessionInfoState } from "@/modules/R0/store";
import {
  StatusBarController,
  type StatusRoster,
  type StatusRuntime,
} from "../../status/controller";

const folder = FolderPath.parse("/work/app");
const otherFolder = FolderPath.parse("/work/other");
const threadId = ThreadId.parse("01903e7a-0000-7000-8000-000000000001");
const START = new Date(2026, 9, 9, 14, 3).getTime();

const READY: CapabilityMap = {
  "host.metadata": { state: "available", via: "host" },
  "host.git-state": { state: "available", via: "host" },
  "host.github-refs": { state: "available", via: "host" },
  "omp.subagent-events": { state: "available", via: "rpc" },
};

const HOST: HostMetadata = { hostname: "devbox", displayPath: "~/code/app" };

function gitState(branch: string): GitState {
  return {
    repositoryRoot: folder,
    branch,
    head: "abcdef1234567890",
    detached: false,
    dirtyFiles: [],
    ahead: 0,
    behind: 0,
    worktrees: [],
    observedAt: "2026-10-09T14:03:00.000Z",
  };
}

const PULL_REQUEST: GithubReference = {
  kind: "pull-request",
  number: 42,
  title: "Fix the build",
  body: "",
  url: "https://github.com/acme/app/pull/42",
  state: "open",
};

/** Lets every resolved promise and its continuations run. */
async function settle(): Promise<void> {
  for (let step = 0; step < 20; step += 1) await Promise.resolve();
}

interface Reads {
  host: number;
  git: number;
  pr: number;
}

interface PortHandlers {
  host(folderPath: FolderPath, signal: AbortSignal): Promise<HostMetadata>;
  git(folderPath: FolderPath, signal: AbortSignal): Promise<GitState>;
  pr(folderPath: FolderPath, signal: AbortSignal): Promise<{ pullRequest: GithubReference | null }>;
}

/** The port client the bar reads through: each call is counted and answered by a handler. */
function fakeClient(handlers: PortHandlers): { client: Pick<AppClient, "port">; reads: Reads } {
  const reads: Reads = { host: 0, git: 0, pr: 0 };
  const port = (target: unknown) => {
    if (target === HostMetadataPort) {
      return {
        read: (args: { folder: FolderPath }, options?: { signal?: AbortSignal }) => {
          reads.host += 1;
          return handlers.host(args.folder, options?.signal ?? new AbortController().signal);
        },
      };
    }
    if (target === GitStatePort) {
      return {
        read: (args: { folder: FolderPath }, options?: { signal?: AbortSignal }) => {
          reads.git += 1;
          return handlers.git(args.folder, options?.signal ?? new AbortController().signal);
        },
      };
    }
    if (target === GithubRefsPort) {
      return {
        currentPullRequest: (args: { folder: FolderPath }, options?: { signal?: AbortSignal }) => {
          reads.pr += 1;
          return handlers.pr(args.folder, options?.signal ?? new AbortController().signal);
        },
      };
    }
    throw new Error("unexpected port");
  };
  return { client: { port } as unknown as Pick<AppClient, "port">, reads };
}

function answering(branch = "main"): PortHandlers {
  return {
    host: async () => HOST,
    git: async () => gitState(branch),
    pr: async () => ({ pullRequest: PULL_REQUEST }),
  };
}

interface FakeRuntime extends StatusRuntime {
  setStreaming(value: boolean): void;
  setSessionName(name: string | null): void;
  setGoal(goal: NonNullable<SessionInfoState["goal"]> | null): void;
  subscribers(): number;
}

function fakeRuntime(streaming = false): FakeRuntime {
  let working = streaming;
  let sessionName: string | null = "Chat";
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  let session: SessionInfoState = {
    model: null,
    thinkingLevel: null,
    sessionName,
    contextUsage: null,
    isCompacting: false,
    autoCompactionEnabled: null,
    tokensPerSecond: null,
    goal: null,
    revision: 0,
  };
  // Only the fields the bar reads are present.
  const current = (): RuntimeSnapshot =>
    ({
      prompt: { streaming: working },
      session: { ...session, sessionName },
    }) as unknown as RuntimeSnapshot;
  const emit = () => {
    for (const listener of [...listeners]) listener(current());
  };
  return {
    getSnapshot: current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setStreaming(value) {
      working = value;
      emit();
    },
    setSessionName(name) {
      sessionName = name;
      emit();
    },
    setGoal(goal) {
      session = { ...session, goal };
      emit();
    },
    subscribers: () => listeners.size,
  };
}

interface FakeRoster extends StatusRoster {
  setActive(keys: readonly string[]): void;
}

function fakeRoster(active: readonly string[]): FakeRoster {
  let current = active;
  const listeners = new Set<(snapshot: AgentRosterStoreSnapshot) => void>();
  const snapshot = (): AgentRosterStoreSnapshot =>
    ({
      threadId,
      revision: 0,
      lastSeq: 0,
      agents: {},
      order: current,
      active: current,
      recent: [],
    }) as AgentRosterStoreSnapshot;
  return {
    getSnapshot: snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setActive(keys) {
      current = keys;
      for (const listener of [...listeners]) listener(snapshot());
    },
  };
}

function clockAt(start: number): { now(): number; advance(ms: number): void } {
  let current = start;
  return {
    now: () => current,
    advance(ms) {
      current += ms;
    },
  };
}

function chipText(controller: StatusBarController, id: string): string | null {
  const chip = controller.getSnapshot().chips.find((candidate) => candidate.segment.id === id);
  if (chip === undefined) throw new Error(`no chip ${id}`);
  return chip.segment.value.state === "available" ? String(chip.segment.value.value) : null;
}

/** Starts the bar the way the React hook does: start, then the folder, the capabilities and the roster. */
function startAsHook(
  controller: StatusBarController,
  options: {
    folder?: FolderPath | null;
    capabilities?: CapabilityMap;
    roster?: StatusRoster | null;
  } = {},
): void {
  controller.start();
  controller.setFolder(options.folder === undefined ? folder : options.folder);
  controller.setCapabilities(options.capabilities ?? READY);
  controller.setRoster(options.roster ?? null);
}

describe("StatusBarController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("reads the host, the git state and the pull request once when started with a folder", async () => {
    const { client, reads } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime: fakeRuntime(),
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    startAsHook(controller);
    await settle();
    expect(reads).toEqual({ host: 1, git: 1, pr: 1 });
    expect(chipText(controller, "N2.hostname")).toBe("devbox");
    expect(chipText(controller, "N2.path")).toBe("app");
    expect(chipText(controller, "N2.git")).toBe("main");
    expect(chipText(controller, "N2.pr")).toBe("#42");
    controller.stop();
  });

  test("never calls a port whose capability is not available", async () => {
    const { client, reads } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime: fakeRuntime(),
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    const capabilities: CapabilityMap = {
      ...READY,
      "host.github-refs": { state: "fallback", via: "host" },
    };
    startAsHook(controller, { capabilities });
    await settle();
    expect(reads.pr).toBe(0);
    expect(chipText(controller, "N2.pr")).toBeNull();
    expect(chipText(controller, "N2.git")).toBe("main");
    controller.stop();
  });

  test("a turn that ends reads git and the pull request again, not the host", async () => {
    const runtime = fakeRuntime(false);
    const { client, reads } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime,
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    startAsHook(controller);
    await settle();
    runtime.setStreaming(true);
    runtime.setStreaming(false);
    await settle();
    expect(reads).toEqual({ host: 1, git: 2, pr: 2 });
    controller.stop();
  });

  test("does not poll: an idle bar reads no port while the clock moves on", async () => {
    const clock = clockAt(START);
    const { client, reads } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime: fakeRuntime(),
      threadId,
      reportFailure: vi.fn(),
      clock,
    });
    startAsHook(controller);
    await settle();
    const before = { ...reads };
    for (let minute = 0; minute < 10; minute += 1) {
      clock.advance(60_000);
      vi.advanceTimersByTime(60_000);
      await settle();
    }
    expect(reads).toEqual(before);
    expect(chipText(controller, "N2.time")).toBe("14:13");
    controller.stop();
  });

  test("a read that was replaced by a new folder is not applied", async () => {
    let releaseFirst: ((value: GitState) => void) | undefined;
    let calls = 0;
    const { client } = fakeClient({
      host: async () => HOST,
      git: (folderPath) => {
        calls += 1;
        if (calls === 1) return new Promise<GitState>((resolve) => (releaseFirst = resolve));
        return Promise.resolve({ ...gitState("feature"), repositoryRoot: folderPath });
      },
      pr: async () => ({ pullRequest: null }),
    });
    const controller = new StatusBarController({
      client,
      runtime: fakeRuntime(),
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    startAsHook(controller);
    controller.setFolder(otherFolder);
    await settle();
    releaseFirst?.(gitState("main"));
    await settle();
    expect(chipText(controller, "N2.git")).toBe("feature");
    controller.stop();
  });

  test("stop cancels reads in flight, leaves no timer, and start reads again", async () => {
    let release: ((value: GitState) => void) | undefined;
    const { client, reads } = fakeClient({
      host: async () => HOST,
      git: () => new Promise<GitState>((resolve) => (release = resolve)),
      pr: async () => ({ pullRequest: null }),
    });
    const controller = new StatusBarController({
      client,
      runtime: fakeRuntime(),
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    startAsHook(controller);
    await settle();
    controller.stop();
    release?.(gitState("main"));
    await settle();
    expect(chipText(controller, "N2.git")).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    controller.start();
    await settle();
    expect(reads.host).toBe(2);
    controller.stop();
  });

  test("an unexpected failure goes to the log and leaves the segment out; 'unavailable' does not", async () => {
    const reportFailure = vi.fn();
    const failure = new Error("gh exploded");
    const { client } = fakeClient({
      host: () => Promise.reject(failure),
      git: async () => gitState("main"),
      pr: () =>
        Promise.reject(
          new AppFailure({
            code: "unavailable",
            message: "GitHub CLI is not authenticated.",
            retryable: false,
          }),
        ),
    });
    const controller = new StatusBarController({
      client,
      runtime: fakeRuntime(),
      threadId,
      reportFailure,
      clock: clockAt(START),
    });
    startAsHook(controller);
    await settle();
    expect(reportFailure).toHaveBeenCalledTimes(1);
    expect(reportFailure).toHaveBeenCalledWith(failure);
    expect(chipText(controller, "N2.hostname")).toBeNull();
    expect(chipText(controller, "N2.pr")).toBeNull();
    controller.stop();
  });

  test("active time counts while omp works, and stops counting when it ends", async () => {
    const clock = clockAt(START);
    const runtime = fakeRuntime(false);
    const { client } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime,
      threadId,
      reportFailure: vi.fn(),
      clock,
    });
    startAsHook(controller);
    await settle();
    expect(chipText(controller, "N2.time-spent")).toBeNull();
    runtime.setStreaming(true);
    clock.advance(5_000);
    vi.advanceTimersByTime(5_000);
    expect(chipText(controller, "N2.time-spent")).toBe("5.0s");
    runtime.setStreaming(false);
    clock.advance(60_000);
    vi.advanceTimersByTime(60_000);
    expect(chipText(controller, "N2.time-spent")).toBe("5.0s");
    controller.stop();
  });

  test("a change to the runtime's session goal changes the goal row at once", () => {
    const goalState = (status: string, enabled = true) =>
      ({
        enabled,
        mode: "active",
        goal: {
          id: "g1",
          objective: "Ship the release",
          status,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 0,
          updatedAt: 0,
        },
      }) as unknown as NonNullable<SessionInfoState["goal"]>;
    const runtime = fakeRuntime(false);
    const { client } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime,
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    startAsHook(controller);
    expect(chipText(controller, "N2.mode")).toBeNull();
    runtime.setGoal(goalState("active"));
    expect(chipText(controller, "N2.mode")).toBe("Goal active");
    runtime.setGoal(goalState("paused", false));
    expect(chipText(controller, "N2.mode")).toBe("Goal paused");
    controller.stop();
  });

  test("active time is kept for a chat when the person leaves it and comes back", () => {
    const clock = clockAt(START);
    const { client } = fakeClient(answering());
    const otherChat = ThreadId.parse("01903e7a-0000-7000-8000-000000000002");
    const open = (runtime: FakeRuntime, chat: ThreadId) => {
      const controller = new StatusBarController({
        client,
        runtime,
        threadId: chat,
        reportFailure: vi.fn(),
        clock,
      });
      startAsHook(controller);
      return controller;
    };
    const first = fakeRuntime(false);
    const chat = open(first, threadId);
    first.setStreaming(true);
    clock.advance(5_000);
    vi.advanceTimersByTime(5_000);
    first.setStreaming(false);
    chat.stop();
    // Another chat, then this one again. The app opens a new store each time a chat is opened.
    open(fakeRuntime(false), otherChat).stop();
    const back = open(fakeRuntime(false), threadId);
    expect(chipText(back, "N2.time-spent")).toBe("5.0s");
    back.stop();
  });

  test("the session name follows omp's session state at once", () => {
    const runtime = fakeRuntime(false);
    const { client } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime,
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    startAsHook(controller);
    expect(chipText(controller, "N2.session-name")).toBe("Chat");
    runtime.setSessionName("Refactor auth");
    expect(chipText(controller, "N2.session-name")).toBe("Refactor auth");
    controller.stop();
  });

  test("the subagent count is the roster's live workers, and it follows the roster", () => {
    const roster = fakeRoster(["a", "b"]);
    const { client } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime: fakeRuntime(),
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    startAsHook(controller, { roster });
    expect(chipText(controller, "N2.subagents")).toBe("2 running");
    roster.setActive([]);
    expect(chipText(controller, "N2.subagents")).toBeNull();
    controller.stop();
  });

  test("no roster yet means the count is not known; no subagent events from omp means it is not known either", () => {
    const { client } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime: fakeRuntime(),
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    startAsHook(controller, { roster: null });
    expect(chipText(controller, "N2.subagents")).toBeNull();
    controller.setRoster(fakeRoster(["a"]));
    expect(chipText(controller, "N2.subagents")).toBe("1 running");
    controller.setCapabilities({
      ...READY,
      "omp.subagent-events": { state: "unavailable", via: "rpc" },
    });
    expect(chipText(controller, "N2.subagents")).toBeNull();
    controller.stop();
  });

  test("listeners hear about changes only when the content the bar shows changes", async () => {
    const runtime = fakeRuntime(false);
    const { client } = fakeClient(answering());
    const controller = new StatusBarController({
      client,
      runtime,
      threadId,
      reportFailure: vi.fn(),
      clock: clockAt(START),
    });
    startAsHook(controller);
    await settle();
    const listener = vi.fn();
    const unsubscribe = controller.subscribe(listener);
    runtime.setStreaming(false);
    controller.setCapabilities({ ...READY });
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
    expect(runtime.subscribers()).toBe(1);
    controller.stop();
    expect(runtime.subscribers()).toBe(0);
  });
});
