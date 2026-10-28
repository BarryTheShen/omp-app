import type { AppClient } from "@omp-app/client";
import {
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
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { RuntimeSnapshot, SessionInfoState } from "@/modules/R0/store";
import { StatusSegments } from "../../status";
import type { StatusRuntime } from "../../status/controller";

const folder = FolderPath.parse("/work/app");
const threadId = ThreadId.parse("01903e7a-0000-7000-8000-000000000001");

const CAPABILITIES: CapabilityMap = {
  "host.metadata": { state: "available", via: "host" },
  "host.git-state": { state: "available", via: "host" },
  "host.github-refs": { state: "available", via: "host" },
  "omp.subagent-events": { state: "available", via: "omp" },
};

const HOST: HostMetadata = { hostname: "devbox", displayPath: "~/code/app" };

const GIT: GitState = {
  repositoryRoot: folder,
  branch: "main",
  head: "abcdef1234567890",
  detached: false,
  dirtyFiles: [],
  ahead: 0,
  behind: 0,
  worktrees: [],
  observedAt: "2026-10-09T14:03:00.000Z",
};

function pullRequest(url: string): GithubReference {
  return {
    kind: "pull-request",
    number: 42,
    title: "Fix the build",
    body: "",
    url,
    state: "open",
  };
}

/** The port client the bar reads through, answering with the given pull request. */
function clientWith(pr: GithubReference | null): Pick<AppClient, "port"> {
  const port = (target: unknown) => {
    if (target === HostMetadataPort) return { read: async () => HOST };
    if (target === GitStatePort) return { read: async () => GIT };
    if (target === GithubRefsPort) return { currentPullRequest: async () => ({ pullRequest: pr }) };
    throw new Error("unexpected port");
  };
  return { port } as unknown as Pick<AppClient, "port">;
}

const SESSION: SessionInfoState = {
  model: null,
  thinkingLevel: null,
  sessionName: "Refactor auth",
  contextUsage: null,
  isCompacting: false,
  autoCompactionEnabled: null,
  tokensPerSecond: null,
  goal: null,
  revision: 0,
};

/** A runtime store with the state the bar reads, and a way to change it the way the app does. */
function runtimeFake(overrides: Partial<SessionInfoState> = {}): StatusRuntime & {
  setStreaming(value: boolean): void;
  setSessionName(name: string): void;
} {
  let streaming = false;
  let sessionName = overrides.sessionName ?? SESSION.sessionName;
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  const current = (): RuntimeSnapshot =>
    ({
      prompt: { streaming },
      session: { ...SESSION, ...overrides, sessionName },
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
      streaming = value;
      emit();
    },
    setSessionName(name) {
      sessionName = name;
      emit();
    },
  };
}

function renderBar(options: {
  readonly pr: GithubReference | null;
  readonly folder?: FolderPath | null;
  readonly runtime?: StatusRuntime;
  readonly session?: Partial<SessionInfoState>;
}) {
  return render(
    <>
      <button type="button">Other control</button>
      <StatusSegments
        capabilities={CAPABILITIES}
        client={clientWith(options.pr)}
        folder={options.folder === undefined ? folder : options.folder}
        reportFailure={vi.fn()}
        roster={null}
        runtime={options.runtime ?? runtimeFake(options.session)}
        threadId={threadId}
      />
    </>,
  );
}

async function bar(): Promise<HTMLElement> {
  return screen.findByRole("region", { name: "Session and workspace status" });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/** A session that has reported its model, its thinking level and a name. */
const REPORTED: Partial<SessionInfoState> = {
  model: { id: "gpt-6-luna", name: "GPT-6 Luna", reasoning: true } as never,
  thinkingLevel: "high",
};

describe("StatusSegments", () => {
  test("draws the folder, the model and the branch, and none of the other rows", async () => {
    renderBar({ pr: pullRequest("https://github.com/acme/app/pull/42"), session: REPORTED });
    const region = await bar();
    await waitFor(() => {
      expect(within(region).getByText("Workspace folder: ~/code/app")).toBeTruthy();
    });
    expect(within(region).getByText("Git branch: main, clean")).toBeTruthy();
    expect(within(region).getByText("Model: GPT-6 Luna, thinking high")).toBeTruthy();
    for (const id of [
      "N2.pi",
      "N2.hostname",
      "N2.session",
      "N2.session-name",
      "N2.pr",
      "N2.goal",
      "N2.subagents",
      "N2.time-spent",
      "N2.time",
    ]) {
      expect(region.querySelector(`[data-segment="${id}"]`), id).toBeNull();
    }
  });

  test("the folder shows its name, and its tooltip carries the full path and the server and session ids", async () => {
    renderBar({ pr: null });
    const folder = await waitFor(() => {
      const element = document.querySelector('[data-segment="N2.path"]');
      if (element === null) throw new Error("the folder is not drawn yet");
      return element;
    });
    expect(folder.querySelector("[data-segment-value]")?.textContent).toBe("app");
    expect(folder.getAttribute("title")).toBe(
      `Workspace folder: ~/code/app\nServer ID: devbox\nSession ID: ${threadId}`,
    );
  });

  test("the bar stays on one line", async () => {
    renderBar({ pr: null });
    const region = await bar();
    expect(region.className).toContain("flex-nowrap");
    expect(region.className).not.toContain("flex-wrap");
  });

  test("leaves out a segment that has no value", async () => {
    const { container } = renderBar({ pr: null });
    await bar();
    await waitFor(() => {
      expect(container.querySelector('[data-segment="N2.path"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-segment="N2.model"]')).toBeNull();
    expect(container.querySelector('[data-segment="N2.pr"]')).toBeNull();
    expect(container.querySelector('[data-segment="N2.subagents"]')).toBeNull();
  });

  test("when the bar is short, the branch goes first and no segment is cut", async () => {
    // jsdom lays nothing out, so each segment is as wide as its text (8 px a character, plus its icon) and the bar has
    // 200 px: the folder (44 px) and the model (156 px) fit together, and the branch (52 px) does not.
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      const text = this.querySelector("[data-segment-value]")?.textContent ?? "";
      return this.dataset.segment === undefined ? 0 : text.length * 8 + 20;
    });
    vi.spyOn(Element.prototype, "clientWidth", "get").mockImplementation(function (this: Element) {
      return this.getAttribute("aria-label") === "Session and workspace status" ? 200 : 0;
    });
    const { container } = renderBar({ pr: null, session: REPORTED });
    await bar();
    const classOf = (id: string) =>
      container.querySelector(`[data-segment="${id}"]`)?.className ?? "";
    await waitFor(() => {
      expect(classOf("N2.git")).toContain("invisible");
    });
    expect(classOf("N2.path")).not.toContain("invisible");
    expect(classOf("N2.model")).not.toContain("invisible");
  });

  test("with no folder open and no model yet, the bar draws nothing", () => {
    renderBar({ pr: null, folder: null });
    expect(screen.queryByRole("region", { name: "Session and workspace status" })).toBeNull();
  });

  test("a passive update leaves focus where it was", async () => {
    const runtime = runtimeFake();
    renderBar({ pr: null, runtime });
    const other = screen.getByRole("button", { name: "Other control" });
    other.focus();
    await bar();
    act(() => {
      runtime.setSessionName("Second name");
    });
    act(() => {
      runtime.setStreaming(true);
    });
    expect(document.activeElement).toBe(other);
  });

  test("the bar is not a live region: nothing in it is announced as it changes", async () => {
    renderBar({ pr: null });
    const region = await bar();
    expect(region.getAttribute("aria-live")).toBeNull();
    expect(region.querySelector('[aria-live], [role="status"], [role="alert"]')).toBeNull();
  });
});
