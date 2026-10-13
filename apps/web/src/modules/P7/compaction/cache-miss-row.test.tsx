import type { MessageState } from "@assistant-ui/react";
import type { OmpWire } from "@omp-app/contracts";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { CacheMissRow, cacheMissOfRow } from "./cache-miss-row";

afterEach(cleanup);

function usage(input: number, cacheRead: number, cacheWrite: number): OmpWire.Usage {
  return {
    input,
    output: 5,
    cacheRead,
    cacheWrite,
    totalTokens: input + cacheRead + cacheWrite + 5,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

const warm = usage(300, 4_000, 0);
const cold = usage(300, 0, 800);

function rowWith(custom: Record<string, unknown>): MessageState {
  return { id: "entry:thread:a1", metadata: { custom } } as unknown as MessageState;
}

describe("cacheMissOfRow", () => {
  test("gives the cold turn's usage and the usage of the turn before it", () => {
    expect(
      cacheMissOfRow(rowWith({ ompRole: "assistant", ompUsage: cold, ompPreviousUsage: warm })),
    ).toEqual({ previousAssistantUsage: warm, currentAssistantUsage: cold });
  });

  test("gives undefined for a warm turn, a session's first turn, a turn without usage and other rows", () => {
    expect(
      cacheMissOfRow(rowWith({ ompRole: "assistant", ompUsage: warm, ompPreviousUsage: warm })),
    ).toBeUndefined();
    expect(
      cacheMissOfRow(rowWith({ ompRole: "assistant", ompUsage: cold, ompPreviousUsage: null })),
    ).toBeUndefined();
    expect(
      cacheMissOfRow(rowWith({ ompRole: "assistant", ompPreviousUsage: warm })),
    ).toBeUndefined();
    expect(
      cacheMissOfRow(rowWith({ ompRole: "user", ompUsage: cold, ompPreviousUsage: warm })),
    ).toBeUndefined();
  });
});

describe("CacheMissRow", () => {
  test("draws the miss above a cold turn with the reprocessed count, and draws nothing for a warm one", () => {
    const { container, getByText, unmount } = render(
      <CacheMissRow
        message={rowWith({ ompRole: "assistant", ompUsage: cold, ompPreviousUsage: warm })}
      />,
    );
    expect(container.querySelector("[data-p7-cache-miss-divider]")).not.toBeNull();
    expect(
      getByText("The prompt cache went cold, so omp processed 1,100 tokens again."),
    ).toBeTruthy();
    unmount();

    const { container: other } = render(
      <CacheMissRow
        message={rowWith({ ompRole: "assistant", ompUsage: warm, ompPreviousUsage: warm })}
      />,
    );
    expect(other.innerHTML).toBe("");
  });
});
