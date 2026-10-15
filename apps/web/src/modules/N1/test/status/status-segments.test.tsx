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
  "omp.subagent-events": { state: "available", via: "rpc" },
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
function runtimeFake(): StatusRuntime & {
  setStreaming(value: boolean): void;
  setSessionName(name: string): void;
} {
  let streaming = false;
  let sessionName = SESSION.sessionName;
  const listeners = new Set<(snapshot: RuntimeSnapshot) => void>();
  const current = (): RuntimeSnapshot =>
    ({
      prompt: { streaming },
      session: { ...SESSION, sessionName },
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
        runtime={options.runtime ?? runtimeFake()}
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
});

describe("StatusSegments", () => {
  test("shows each segment that has a value, with its words for screen readers", async () => {
    renderBar({ pr: pullRequest("https://github.com/acme/app/pull/42") });
    const region = await bar();
    await waitFor(() => {
      expect(within(region).getByText("Host name: devbox")).toBeTruthy();
    });
    expect(within(region).getByText("Workspace folder: ~/code/app")).toBeTruthy();
    expect(within(region).getByText("Git branch: main, clean")).toBeTruthy();
    expect(within(region).getByText("Session name: Refactor auth")).toBeTruthy();
    expect(within(region).getByText("Session ID: 01903e7a")).toBeTruthy();
  });

  test("the segments stay on one line, and the folder keeps its full text in its title", async () => {
    renderBar({ pr: null });
    const region = await bar();
    await waitFor(() => {
      expect(within(region).getByText("Host name: devbox")).toBeTruthy();
    });
    expect(region.className).toContain("flex-nowrap");
    expect(region.className).not.toContain("flex-wrap");
    const path = region.querySelector('[data-segment="N2.path"]');
    expect(path?.getAttribute("title")).toBe("Workspace folder: ~/code/app");
  });

  test("leaves out a segment that has no value", async () => {
    const { container } = renderBar({ pr: null });
    await bar();
    await waitFor(() => {
      expect(container.querySelector('[data-segment="N2.hostname"]')).not.toBeNull();
    });
    expect(container.querySelector('[data-segment="N2.pr"]')).toBeNull();
    expect(container.querySelector('[data-segment="N2.subagents"]')).toBeNull();
    expect(container.querySelector('[data-segment="N2.mode"]')).toBeNull();
  });

  test("links a pull request to its https address, in a new tab", async () => {
    renderBar({ pr: pullRequest("https://github.com/acme/app/pull/42") });
    const link = await screen.findByRole("link", {
      name: "Pull request #42: Fix the build, open, opens in a new tab",
    });
    expect(link.getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.textContent).toBe("#42");
  });

  test("shows a pull request whose address is not https as plain text", async () => {
    renderBar({ pr: pullRequest("http://example.com/pr/42") });
    const region = await bar();
    await waitFor(() => {
      expect(within(region).getByText("Pull request #42: Fix the build, open")).toBeTruthy();
    });
    expect(screen.queryByRole("link", { name: /Pull request/ })).toBeNull();
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

  test("with no folder open the local clock still shows, and the folder segments do not", async () => {
    const { container } = renderBar({ pr: null, folder: null });
    await bar();
    expect(screen.getByText(/^Local time \d{1,2}:\d{2}$/)).toBeTruthy();
    expect(container.querySelector('[data-segment="N2.hostname"]')).toBeNull();
    expect(container.querySelector('[data-segment="N2.git"]')).toBeNull();
  });
});
