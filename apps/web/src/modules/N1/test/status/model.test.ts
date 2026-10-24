import { FolderPath, type GithubReference, type GitState, ThreadId } from "@omp-app/contracts";
import { describe, expect, test } from "vitest";
import { thinkingLevelLabel } from "@/modules/D1/thinking";
import type { SessionInfoState } from "@/modules/R0/store";
import { StatusSegment } from "../../contract";
import { N2_STATUS_DESCRIPTORS } from "../../descriptors/descriptors";
import { buildStatusChips, type StatusChip, type StatusInputs } from "../../status/model";

const NOW = new Date(2026, 9, 9, 14, 3).getTime();
const threadId = ThreadId.parse("01903e7a-0000-7000-8000-000000000001");

function gitState(overrides: Partial<GitState> = {}): GitState {
  return {
    repositoryRoot: FolderPath.parse("/work/app"),
    branch: "main",
    head: "abcdef1234567890",
    detached: false,
    dirtyFiles: [],
    ahead: 0,
    behind: 0,
    worktrees: [],
    observedAt: "2026-10-09T14:03:00.000Z",
    ...overrides,
  };
}

function pullRequest(overrides: Partial<GithubReference> = {}): GithubReference {
  return {
    kind: "pull-request",
    number: 42,
    title: "Fix the build",
    body: "",
    url: "https://github.com/acme/app/pull/42",
    state: "open",
    ...overrides,
  };
}

const NO_SESSION: SessionInfoState = {
  model: null,
  thinkingLevel: null,
  sessionName: null,
  contextUsage: null,
  isCompacting: false,
  autoCompactionEnabled: null,
  tokensPerSecond: null,
  goal: null,
  revision: 0,
};

function inputs(overrides: Partial<StatusInputs> = {}): StatusInputs {
  return {
    now: NOW,
    threadId,
    host: { state: "ready", value: { hostname: "devbox", displayPath: "~/code/app" } },
    git: { state: "ready", value: gitState() },
    pullRequest: { state: "ready", value: null },
    session: NO_SESSION,
    subagents: { state: "ready", value: 0 },
    activeMs: 0,
    ...overrides,
  };
}

function chipFor(id: string, overrides: Partial<StatusInputs> = {}): StatusChip {
  const found = buildStatusChips(inputs(overrides)).find((chip) => chip.segment.id === id);
  if (found === undefined) throw new Error(`no chip ${id}`);
  return found;
}

/** The visible text of a chip, or `null` when its value is unavailable. */
function textOf(chip: StatusChip): string | null {
  return chip.segment.value.state === "available" ? String(chip.segment.value.value) : null;
}

function reasonOf(chip: StatusChip): string | null {
  return chip.segment.value.state === "unavailable" ? chip.segment.value.reason : null;
}

describe("buildStatusChips", () => {
  test("keeps every N2 row once, in display order", () => {
    expect(buildStatusChips(inputs()).map((chip) => chip.segment.id)).toEqual([
      "N2.pi",
      "N2.hostname",
      "N2.path",
      "N2.git",
      "N2.pr",
      "N2.session",
      "N2.session-name",
      "N2.model",
      "N2.mode",
      "N2.subagents",
      "N2.collab",
      "N2.time-spent",
      "N2.time",
    ]);
  });

  test("the Pi mark is always shown, and collaboration stays unavailable until I4 supplies its state", () => {
    expect(textOf(chipFor("N2.pi"))).toBe("Pi");
    expect(textOf(chipFor("N2.collab"))).toBeNull();
    expect(reasonOf(chipFor("N2.collab"))).toBe("Collaboration is not available yet.");
  });

  test("every chip is an N2 row that a status descriptor claims, and a valid N1 status segment", () => {
    const covered: readonly string[] = N2_STATUS_DESCRIPTORS.flatMap(
      (descriptor) => descriptor.covers,
    );
    for (const chip of buildStatusChips(inputs())) {
      expect(covered).toContain(chip.segment.id);
      expect(() => StatusSegment.parse(chip.segment)).not.toThrow();
    }
  });
});

describe("host and folder", () => {
  test("shows the host name and the home-relative folder", () => {
    expect(textOf(chipFor("N2.hostname"))).toBe("devbox");
    expect(textOf(chipFor("N2.path"))).toBe("app");
    expect(chipFor("N2.path").tooltip).toBe(
      `Workspace folder: ~/code/app\nServer ID: devbox\nSession ID: ${threadId}`,
    );
  });

  test("a long folder path shows its name, and the whole path in the accessible label", () => {
    const long = "/home/user/workspace/projects/omp-app/.data/run/workspace";
    const host = { state: "ready", value: { hostname: "devbox", displayPath: long } } as const;
    const chip = chipFor("N2.path", { host });
    expect(textOf(chip)).toBe("workspace");
    expect(chip.segment.accessibleLabel).toBe(`Workspace folder: ${long}`);
  });

  test("a host or folder that could not be read keeps its reason and shows nothing", () => {
    const host = { state: "unavailable", reason: "The host policy withholds it." } as const;
    expect(textOf(chipFor("N2.hostname", { host }))).toBeNull();
    expect(reasonOf(chipFor("N2.hostname", { host }))).toBe("The host policy withholds it.");
    expect(textOf(chipFor("N2.path", { host }))).toBeNull();
  });

  test("an empty host name is not shown", () => {
    const host = { state: "ready", value: { hostname: "", displayPath: "~/x" } } as const;
    expect(textOf(chipFor("N2.hostname", { host }))).toBeNull();
  });
});

describe("git branch", () => {
  test("a clean branch says so", () => {
    const chip = chipFor("N2.git");
    expect(textOf(chip)).toBe("main");
    expect(chip.tone).toBe("clean");
    expect(chip.segment.accessibleLabel).toBe("Git branch: main, clean");
  });

  test("counts changed, staged and untracked files; an untracked file is not also a change", () => {
    const git = {
      state: "ready",
      value: gitState({
        dirtyFiles: [
          { path: "a.ts", status: "modified", staged: false, worktree: true },
          { path: "b.ts", status: "modified", staged: true, worktree: false },
          { path: "c.ts", status: "untracked", staged: false, worktree: true },
        ],
      }),
    } as const;
    const chip = chipFor("N2.git", { git });
    expect(textOf(chip)).toBe("main");
    expect(chip.segment.accessibleLabel).toBe("Git branch: main, 1 changed, 1 staged, 1 untracked");
    expect(chip.tone).toBe("changed");
  });

  test("a detached head shows the short commit", () => {
    const git = { state: "ready", value: gitState({ branch: null, detached: true }) } as const;
    expect(textOf(chipFor("N2.git", { git }))).toBe("detached at abcdef1");
  });

  test("a folder outside a repository, or a repository with no commits, shows nothing", () => {
    const outside = {
      state: "ready",
      value: gitState({ repositoryRoot: null, branch: null, head: null }),
    } as const;
    expect(reasonOf(chipFor("N2.git", { git: outside }))).toBe(
      "This folder is not in a git repository.",
    );
    const unborn = { state: "ready", value: gitState({ branch: null, head: null }) } as const;
    expect(reasonOf(chipFor("N2.git", { git: unborn }))).toBe(
      "This repository has no commits yet.",
    );
  });
});

describe("pull request", () => {
  test("shows the number with its title and state, and links to the https address", () => {
    const chip = chipFor("N2.pr", { pullRequest: { state: "ready", value: pullRequest() } });
    expect(textOf(chip)).toBe("#42");
    expect(chip.segment.accessibleLabel).toBe("Pull request #42: Fix the build, open");
    expect(chip.href).toBe("https://github.com/acme/app/pull/42");
  });

  test("the title is plain text: controls and bidi overrides are removed", () => {
    const title = "Fix\u0007 the \u202ebuild";
    const chip = chipFor("N2.pr", {
      pullRequest: { state: "ready", value: pullRequest({ title }) },
    });
    expect(chip.segment.accessibleLabel).toBe("Pull request #42: Fix the build, open");
  });

  test("an unknown state is left out of the words", () => {
    const chip = chipFor("N2.pr", {
      pullRequest: { state: "ready", value: pullRequest({ state: "unknown" }) },
    });
    expect(chip.segment.accessibleLabel).toBe("Pull request #42: Fix the build");
  });

  test("an address that is not https shows the number without a link", () => {
    const chip = chipFor("N2.pr", {
      pullRequest: { state: "ready", value: pullRequest({ url: "http://example.com/pr/42" }) },
    });
    expect(textOf(chip)).toBe("#42");
    expect(chip.href).toBeUndefined();
  });

  test("a branch with no pull request, or no GitHub CLI, shows nothing", () => {
    expect(reasonOf(chipFor("N2.pr", { pullRequest: { state: "ready", value: null } }))).toBe(
      "This branch has no pull request.",
    );
    const missing = { state: "unavailable", reason: "It could not be read." } as const;
    expect(textOf(chipFor("N2.pr", { pullRequest: missing }))).toBeNull();
  });
});

describe("session", () => {
  test("the session id is the first eight characters of omp's session id", () => {
    expect(textOf(chipFor("N2.session"))).toBe("01903e7a");
    expect(chipFor("N2.session").segment.accessibleLabel).toBe("Session ID: 01903e7a");
  });

  test("the session name is shown as plain text with a stable accent", () => {
    const session = { ...NO_SESSION, sessionName: "Refactor\u0000 auth" };
    const chip = chipFor("N2.session-name", { session });
    expect(textOf(chip)).toBe("Refactor auth");
    expect(chip.accent).toBeGreaterThanOrEqual(1);
    expect(chip.accent).toBeLessThanOrEqual(5);
    expect(chip.icon).toBeUndefined();
  });

  test("a missing or blank session name shows nothing", () => {
    expect(reasonOf(chipFor("N2.session-name"))).toBe("This chat has no name yet.");
    const blank = { ...NO_SESSION, sessionName: " \n " };
    expect(textOf(chipFor("N2.session-name", { session: blank }))).toBeNull();
  });
});

describe("model", () => {
  const model = {
    id: "claude-x",
    name: "Claude X",
    api: "anthropic",
    provider: "anthropic",
    baseUrl: "https://example.invalid",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: null,
    maxTokens: null,
  } as unknown as NonNullable<SessionInfoState["model"]>;

  test("shows the model name, and the thinking level in words", () => {
    const session = { ...NO_SESSION, model, thinkingLevel: "high" as const };
    const label = thinkingLevelLabel("high").toLowerCase();
    const chip = chipFor("N2.model", { session });
    expect(textOf(chip)).toBe(`Claude X · ${label}`);
    expect(chip.segment.accessibleLabel).toBe(`Model: Claude X, thinking ${label}`);
  });

  test("a level that is off, or a model that does not reason, adds no level", () => {
    const off = { ...NO_SESSION, model, thinkingLevel: "off" as const };
    expect(textOf(chipFor("N2.model", { session: off }))).toBe("Claude X");
    const plain = {
      ...NO_SESSION,
      model: { ...model, reasoning: false },
      thinkingLevel: "high" as const,
    };
    expect(textOf(chipFor("N2.model", { session: plain }))).toBe("Claude X");
  });

  test("a level omp uses under its raw name is shown in words, never raw", () => {
    const session = { ...NO_SESSION, model, thinkingLevel: "xhigh" as const };
    const text = textOf(chipFor("N2.model", { session })) ?? "";
    expect(text).toContain(thinkingLevelLabel("xhigh").toLowerCase());
    expect(text).not.toContain("xhigh");
  });

  test("no model yet shows nothing", () => {
    expect(reasonOf(chipFor("N2.model"))).toBe("omp has not reported a model yet.");
  });
});

describe("goal", () => {
  function goal(
    overrides: Record<string, unknown> = {},
    goalOverrides: Record<string, unknown> = {},
  ) {
    return {
      enabled: true,
      mode: "active",
      goal: {
        id: "g1",
        objective: "Ship the release",
        status: "active",
        tokensUsed: 38_000,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0,
        tokenBudget: 50_000,
        ...goalOverrides,
      },
      ...overrides,
    } as unknown as NonNullable<SessionInfoState["goal"]>;
  }

  test("an active goal shows its status and the tokens left in its budget", () => {
    const session = { ...NO_SESSION, goal: goal() };
    expect(textOf(chipFor("N2.mode", { session }))).toBe("Goal active · 12K tokens left");
  });

  test("each goal status has its own words; a finished or dropped goal is not shown", () => {
    const words = (status: string, overrides: Record<string, unknown> = {}) =>
      textOf(
        chipFor("N2.mode", {
          session: {
            ...NO_SESSION,
            goal: goal({}, { status, tokenBudget: undefined, ...overrides }),
          },
        }),
      );
    expect(words("active")).toBe("Goal active");
    expect(words("paused")).toBe("Goal paused");
    expect(words("budget-limited")).toBe("Goal: budget reached");
    expect(words("complete")).toBeNull();
    expect(words("dropped")).toBeNull();
    expect(
      textOf(chipFor("N2.mode", { session: { ...NO_SESSION, goal: goal({ mode: "exiting" }) } })),
    ).toBe("Goal finishing · 12K tokens left");
  });

  // omp keeps a paused goal with `enabled: false` (goals/runtime.ts:445-460), and its status line shows a goal that
  // is enabled or paused (modes/interactive-mode.ts:4582-4584, omp v18.8.9).
  test("a goal that is on or paused is shown; a finished goal, or one that is off, is not", () => {
    const shown = (enabled: boolean, mode: string, status: string) =>
      textOf(
        chipFor("N2.mode", {
          session: { ...NO_SESSION, goal: goal({ enabled, mode }, { status }) },
        }),
      );
    expect(shown(true, "active", "active")).toBe("Goal active · 12K tokens left");
    expect(shown(true, "active", "budget-limited")).toBe("Goal: budget reached · 12K tokens left");
    expect(shown(false, "active", "paused")).toBe("Goal paused · 12K tokens left");
    expect(shown(false, "exiting", "complete")).toBeNull();
    expect(shown(false, "active", "active")).toBeNull();
  });

  test("no goal shows the reason", () => {
    expect(reasonOf(chipFor("N2.mode"))).toBe("No goal is set for this chat.");
  });
});

describe("subagents", () => {
  test("counts the running subagents in words", () => {
    expect(textOf(chipFor("N2.subagents", { subagents: { state: "ready", value: 1 } }))).toBe(
      "1 running",
    );
    const three = chipFor("N2.subagents", { subagents: { state: "ready", value: 3 } });
    expect(textOf(three)).toBe("3 running");
    expect(three.segment.accessibleLabel).toBe("3 subagents running");
  });

  test("none running, or a count that could not be read, shows nothing", () => {
    expect(reasonOf(chipFor("N2.subagents", { subagents: { state: "ready", value: 0 } }))).toBe(
      "No subagents are running.",
    );
    const unknown = {
      state: "unavailable",
      reason: "This omp does not report subagent events.",
    } as const;
    expect(reasonOf(chipFor("N2.subagents", { subagents: unknown }))).toBe(
      "This omp does not report subagent events.",
    );
  });
});

describe("active time and clock", () => {
  test("active time shows once it passes one second, approximately", () => {
    expect(reasonOf(chipFor("N2.time-spent", { activeMs: 999 }))).toBe(
      "No work has run in this chat yet.",
    );
    const chip = chipFor("N2.time-spent", { activeMs: 42_300 });
    expect(textOf(chip)).toBe("42.3s");
    expect(chip.segment.accessibleLabel).toBe("Time spent working: about 42.3s");
  });

  test("the local clock is always shown, in 24-hour time", () => {
    const chip = chipFor("N2.time");
    expect(textOf(chip)).toBe("14:03");
    expect(chip.segment.accessibleLabel).toBe("Local time 14:03");
  });
});
