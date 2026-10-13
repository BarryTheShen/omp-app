import type { AppClient } from "@omp-app/client";
import { ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OmpRuntimeStore } from "@/modules/R0/store";
import { compactionStateOf, SessionContextPanel } from "./context-panel";

afterEach(() => cleanup());

const threadId = ThreadId.parse("thread-context-panel");

function fakeStore(overrides: Readonly<Record<string, unknown>> = {}): OmpRuntimeStore {
  const session = {
    isCompacting: false,
    autoCompactionEnabled: false,
    contextUsage: null,
    tokensPerSecond: null,
    revision: 1,
    ...overrides,
  };
  return {
    getSnapshot: () => ({ session }),
    subscribe: () => () => undefined,
    applySessionState: () => undefined,
  } as unknown as OmpRuntimeStore;
}

const fakeClient = {
  port: () => ({ send: async () => ({}) }),
} as unknown as AppClient;

describe("the Context panel's compaction state", () => {
  test("a running compaction reads as running, and auto-compaction is on only when omp says so", () => {
    expect(
      compactionStateOf(fakeStore({ isCompacting: true, autoCompactionEnabled: true })),
    ).toMatchObject({ phase: "running", auto: true });
    expect(compactionStateOf(fakeStore({ autoCompactionEnabled: null }))).toMatchObject({
      phase: "idle",
      auto: false,
    });
  });
});

describe("the Context panel", () => {
  test("shows the context meter and the compaction controls once omp reports auto-compaction", () => {
    render(
      <SessionContextPanel
        client={fakeClient}
        store={fakeStore({ autoCompactionEnabled: false })}
        threadId={threadId}
      />,
    );
    expect(screen.getByText("Context usage is unavailable from this host.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compact now" })).toBeTruthy();
    expect(screen.getByRole("checkbox", { name: "Auto-compaction" })).toBeTruthy();
  });

  test("leaves the compaction controls out until omp reports the setting", () => {
    render(
      <SessionContextPanel
        client={fakeClient}
        store={fakeStore({ autoCompactionEnabled: null })}
        threadId={threadId}
      />,
    );
    expect(screen.getByText("Context usage is unavailable from this host.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Compact now" })).toBeNull();
  });

  test("after a compaction the panel reports how many tokens it compacted", async () => {
    const compactingClient = {
      port: () => ({
        send: async () => ({ summary: "done", firstKeptEntryId: "entry-1", tokensBefore: 120_000 }),
      }),
    } as unknown as AppClient;
    render(
      <SessionContextPanel
        client={compactingClient}
        store={fakeStore({ autoCompactionEnabled: false })}
        threadId={threadId}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect(await screen.findByText(`Compacted ${(120_000).toLocaleString()} tokens.`)).toBeTruthy();
  });

  test("after a compaction the transcript is read again, because the compaction writes an entry the transcript does not show yet", async () => {
    const compactingClient = {
      port: () => ({
        send: async () => ({ summary: "done", firstKeptEntryId: "entry-1", tokensBefore: 120_000 }),
      }),
    } as unknown as AppClient;
    const onCompacted = vi.fn();
    render(
      <SessionContextPanel
        client={compactingClient}
        onCompacted={onCompacted}
        store={fakeStore({ autoCompactionEnabled: false })}
        threadId={threadId}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
    expect(await screen.findByText(`Compacted ${(120_000).toLocaleString()} tokens.`)).toBeTruthy();
    expect(onCompacted).toHaveBeenCalledTimes(1);
  });
});
