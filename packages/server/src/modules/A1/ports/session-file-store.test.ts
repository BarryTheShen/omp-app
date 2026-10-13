import { describe, expect, test } from "bun:test";
import type { A1PortContext } from "./context";
import { createSessionFileStoreRegistration } from "./session-file-store";

const PARENT_PATH = "/home/u/.omp/agent/sessions/-w/parent.jsonl";

function internalSession(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    sessionFile: `/home/u/.omp/agent/sessions/-w/${id}.jsonl`,
    version: 3,
    title: "A chat",
    firstPrompt: null,
    cwd: "/w",
    createdAt: "2026-10-07T02:39:26.959Z",
    updatedAt: "2026-10-07T02:40:00.000Z",
    messageCount: 2,
    assistantTurns: 1,
    sizeBytes: 100,
    status: "complete" as const,
    liveness: { lease: "free" as const, serverProcess: false },
    subagents: [],
    parseWarnings: [],
    entries: [],
    ...overrides,
  };
}

interface Warning {
  readonly event: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

/** The registration's list handler over a fake store, and the lines it wrote to the debug log. */
function lister(sessions: readonly unknown[]) {
  const warnings: Warning[] = [];
  const context = {
    sessionFileStore: { listSessions: async () => ({ sessions, nextCursor: null, running: [] }) },
    publish: () => undefined,
    watchStreamActivity: () => () => undefined,
    logger: {
      warn: (event: string, fields?: Record<string, unknown>) => warnings.push({ event, fields }),
    },
  } as unknown as A1PortContext;
  const registration = createSessionFileStoreRegistration(context);
  const call = async () => {
    const handler = registration.handlers.listSessions;
    if (handler === undefined) throw new Error("no listSessions handler");
    return (await handler({ folder: "/w" }, {
      signal: new AbortController().signal,
      connectionId: "c",
      requestId: "r",
      portContext: undefined,
    } as never)) as {
      sessions: { id: string; parentSession: string | null }[];
      nextCursor: string | null;
    };
  };
  return { call, warnings };
}

describe("listing sessions", () => {
  test("a fork whose parent is a session id is listed, with no parent (omp writes an id, not a path)", async () => {
    const { call, warnings } = lister([
      internalSession("fork", { parentSession: "01a11405-b2e2-7321-bcc1-4c256aa64d3d" }),
    ]);
    const result = await call();
    expect(result.sessions.map((session) => [session.id, session.parentSession])).toEqual([
      ["fork", null],
    ]);
    expect(warnings).toEqual([]);
  });

  test("a parent that is a path is kept as it is", async () => {
    const { call } = lister([internalSession("child", { parentSession: PARENT_PATH })]);
    expect((await call()).sessions[0]?.parentSession).toBe(PARENT_PATH);
  });

  test("a chat without a parent is listed without one", async () => {
    const { call } = lister([internalSession("plain")]);
    expect((await call()).sessions[0]?.parentSession).toBeNull();
  });

  test("a chat that does not fit the contract is skipped and logged; the rest are listed, never the page refused", async () => {
    const { call, warnings } = lister([
      internalSession("before"),
      internalSession("broken", { cwd: "not-an-absolute-folder" }),
      internalSession("after"),
    ]);
    const result = await call();
    expect(result.sessions.map((session) => session.id)).toEqual(["before", "after"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.event).toBe("sessions.skipped");
    expect(warnings[0]?.fields?.count).toBe(1);
    expect(String(warnings[0]?.fields?.first_problem)).toContain("cwd");
  });
});
