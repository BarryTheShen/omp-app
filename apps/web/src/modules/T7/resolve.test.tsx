import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { ResolveCard } from "./resolve";

afterEach(cleanup);

function props(
  toolName: "resolve" | "reject",
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
  args: Record<string, unknown> = { action: toolName === "resolve" ? "apply" : "discard" },
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: `${toolName}-1`,
    toolName,
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

const discardEnvelope = {
  content: [{ type: "text", text: "Discarded: Edit. Reason: R" }],
  details: { action: "discard", reason: "R", sourceToolName: "ast_edit", label: "Edit" },
};

describe("ResolveCard", () => {
  test("uses the action argument while running and shows the waiting reason", () => {
    render(
      <ResolveCard
        rendererProps={props(
          "resolve",
          undefined,
          { type: "running" },
          {
            action: "apply",
            reason: "Approve device access",
          },
        )}
      />,
    );
    expandToolCards();
    const card = screen.getByTestId("t7-resolve-status-resolve-1");
    expect(card.textContent).toContain("Pending decision");
    expect(screen.getByText("Apply the staged change")).toBeTruthy();
    expect(card.textContent).toContain("Pending decision");
    expect(card.textContent).toContain("Approve device access");
  });

  test("decodes omp's exact result envelope and uses details label/action instead of args", () => {
    render(
      <ResolveCard
        rendererProps={props(
          "resolve",
          discardEnvelope,
          { type: "complete" },
          {
            action: "apply",
            reason: "wrong argument reason",
          },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Discarded: Edit")).toBeTruthy();
    expect(screen.getByTestId("t7-resolve-status-resolve-1").textContent).toContain("R");
    expect(screen.queryByText("Applied: the staged change")).toBeNull();
    expect(screen.queryByText("wrong argument reason")).toBeNull();
  });
  test("a completed apply result is explicitly approved, while reject uses the tool name", () => {
    render(
      <>
        <ResolveCard
          rendererProps={props("resolve", {
            content: [{ type: "text", text: "Applied: Edit" }],
            details: { action: "apply", label: "Edit" },
          })}
        />
        <ResolveCard
          rendererProps={props("reject", {
            content: [{ type: "text", text: "Discarded: Edit" }],
            details: {},
          })}
        />
      </>,
    );
    expandToolCards();
    expect(screen.getByTestId("t7-resolve-status-resolve-1").textContent).toContain("Approved");
    expect(screen.getByTestId("t7-resolve-status-reject-1").textContent).toContain("Rejected");
  });

  test("uses plain cancellation and action-specific error words", () => {
    render(
      <>
        <ResolveCard
          rendererProps={props("resolve", undefined, { type: "incomplete", reason: "cancelled" })}
        />
        <ResolveCard
          rendererProps={props(
            "reject",
            {
              content: [{ type: "text", text: "Could not discard" }],
              details: { action: "discard", label: "Edit" },
            },
            { type: "incomplete", reason: "error" },
          )}
        />
      </>,
    );
    expandToolCards();
    expect(screen.getByTestId("t7-resolve-status-resolve-1").textContent).toContain("Cancelled");
    expect(screen.getByTestId("t7-resolve-status-reject-1").textContent).toContain(
      "Could not discard the staged change.",
    );
    expect(screen.queryByText("Rejected")).toBeNull();
  });

  test("an apply error says it could not apply the staged change", () => {
    render(
      <ResolveCard
        rendererProps={props(
          "resolve",
          {
            content: [{ type: "text", text: "failure" }],
            details: { action: "apply", label: "Edit" },
          },
          { type: "incomplete", reason: "error" },
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("Could not apply the staged change.")).toBeTruthy();
  });

  test("malformed details preserve the raw envelope and show a safe alert", () => {
    render(
      <ResolveCard
        rendererProps={props(
          "resolve",
          {
            content: [{ type: "text", text: "raw" }],
            details: { action: "not-an-action" },
          },
          { type: "incomplete", reason: "error" },
        )}
      />,
    );
    expandToolCards();
    expect(
      screen
        .getAllByRole("alert")
        .some((alert) => alert.textContent?.includes("malformed") === true),
    ).toBe(true);
  });
});
