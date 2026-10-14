import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import { groupLateDiagnostics, LateDiagnosticsCard, summaryOf } from "./late-diagnostics";

afterEach(cleanup);

/** omp's late diagnostics message: `details.files[]` of path, summary, errored and its lines as text. */
function lateMessage(files: readonly unknown[], extra: Record<string, unknown> = {}): unknown {
  return { customType: "lsp-late-diagnostic", details: { files }, ...extra };
}

const CART = {
  path: "/tmp/cart.ts",
  summary: "1 error(s)",
  errored: true,
  messages: ["cart.ts:41:9 [error] [typescript] Property 'total' does not exist (2339)"],
};
const TAX = { path: "/tmp/tax.ts", summary: "no issues", errored: false, messages: [] };

describe("T2.6 late diagnostics: grouping and summary", () => {
  test("groups each file in omp's order, with its summary and errored state", () => {
    const groups = groupLateDiagnostics([CART, TAX]);
    expect(groups.map((group) => [group.path, group.summary, group.errored])).toEqual([
      ["/tmp/cart.ts", "1 error(s)", true],
      ["/tmp/tax.ts", "no issues", false],
    ]);
    expect(groups[0]?.lines).toEqual(CART.messages);
    expect(summaryOf(groups)).toBe("2 files: 1 error(s); no issues");
  });

  test("one file is named in the summary, and no files say there is nothing new", () => {
    expect(summaryOf(groupLateDiagnostics([CART]))).toBe("1 file: 1 error(s)");
    expect(summaryOf(groupLateDiagnostics([]))).toBe("No new diagnostics");
  });
});

describe("T2.6 late diagnostics: the card", () => {
  test("a file lists five of omp's lines, and 'Show more' reveals the rest of that file", () => {
    const messages = Array.from(
      { length: 7 },
      (_, index) => `big.ts:${index + 1}:1 [warning] line ${index + 1}`,
    );
    render(
      <LateDiagnosticsCard
        identity="omp:custom:1:lsp-late-diagnostic"
        snapshot={lateMessage([
          { path: "/tmp/big.ts", summary: "7 warning(s)", errored: false, messages },
        ])}
      />,
    );
    expandToolCards();
    expect(screen.getByText("big.ts:5:1 [warning] line 5")).toBeTruthy();
    expect(screen.queryByText("big.ts:6:1 [warning] line 6")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show 2 more in this file" }));
    expect(screen.getByText("big.ts:7:1 [warning] line 7")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Show \d+ more in this file/ })).toBeNull();
  });

  test("no files is said in plain words, in the summary and in the body", () => {
    render(<LateDiagnosticsCard identity="late-empty" snapshot={lateMessage([])} />);
    expect(screen.getByText("No new diagnostics")).toBeTruthy();
    expandToolCards();
    expect(screen.getByText("No diagnostics were reported for the changed files.")).toBeTruthy();
  });

  test("a message that cannot be read is an explicit error, never a blank card", () => {
    render(
      <LateDiagnosticsCard
        identity="late-bad"
        snapshot={lateMessage([{ path: "/tmp/x.ts", messages: ["x.ts:1:1 [error] bad"] }])}
      />,
    );
    expect(screen.getByText("The diagnostics could not be read")).toBeTruthy();
  });

  test("a message with no tool call says it came after the edit or write finished", () => {
    const { unmount } = render(
      <LateDiagnosticsCard identity="late-unattached" snapshot={lateMessage([CART])} />,
    );
    expandToolCards();
    expect(screen.getByText("Reported after the edit or write finished.")).toBeTruthy();
    unmount();

    render(
      <LateDiagnosticsCard
        identity="late-attached"
        snapshot={lateMessage([CART], { relatedToolCallId: "call-edit-7" })}
      />,
    );
    expandToolCards();
    expect(screen.queryByText("Reported after the edit or write finished.")).toBeNull();
  });

  test("the card is keyed by the message's own identity, and no tool call id is invented", () => {
    const { container } = render(
      <LateDiagnosticsCard
        identity="omp:custom:42:lsp-late-diagnostic"
        snapshot={lateMessage([])}
      />,
    );
    expect(
      container.querySelector(
        '[data-testid="t2-late-diagnostics-omp:custom:42:lsp-late-diagnostic"]',
      ),
    ).not.toBeNull();
  });

  test("a file that errored is marked, and a clean one is not", () => {
    const { container } = render(
      <LateDiagnosticsCard identity="late-errored" snapshot={lateMessage([CART, TAX])} />,
    );
    expandToolCards();
    expect(container.querySelector('[data-errored="true"]')?.textContent).toContain("/tmp/cart.ts");
    expect(container.querySelector('[data-errored="false"]')?.textContent).toContain("/tmp/tax.ts");
  });

  test("omp's lines are shown as text, never as markup", () => {
    const { container } = render(
      <LateDiagnosticsCard
        identity="late-markup"
        snapshot={lateMessage([
          {
            path: "/tmp/a.ts",
            summary: "1 error(s)",
            errored: true,
            messages: ["<img src=x onerror=alert(1)>"],
          },
        ])}
      />,
    );
    expandToolCards();
    expect(screen.getByText("<img src=x onerror=alert(1)>")).toBeTruthy();
    expect(container.querySelector("img")).toBeNull();
  });
});
