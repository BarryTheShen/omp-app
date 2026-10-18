import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import { SecurityScanCard } from "./security";

afterEach(cleanup);

function props(
  args: Record<string, unknown>,
  result: unknown,
  status: ToolRendererProps["status"] = { type: "complete" },
  toolCallId = "security-1",
): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId,
    toolName: "security_scan",
    args,
    argsText: JSON.stringify(args),
    result,
    status,
  } as unknown as ToolRendererProps;
}

/** omp v18.6.1 result envelope: `{ content, details }`. */
function scanResult(details: Record<string, unknown>): unknown {
  return { content: [{ type: "text", text: "Security scan scan-1: completed." }], details };
}

function operation(fields: Record<string, unknown>): Record<string, unknown> {
  return {
    operationId: "op-1",
    planId: "plan-1",
    scanId: "scan-1",
    createdAt: "2026-10-05T10:00:00Z",
    updatedAt: "2026-10-05T10:05:00Z",
    ...fields,
  };
}

function header(): HTMLElement {
  const trigger = document.querySelector<HTMLElement>("[data-slot='u3-tool-card-trigger']");
  if (!trigger) throw new Error("Tool card header is missing.");
  return trigger;
}

function card(): HTMLElement {
  return screen.getByTestId("t7-security-card-security-1");
}

/** The card's text minus its raw-details disclosure (the raw arguments and result). */
function shownText(element: HTMLElement): string {
  const raw = element.querySelector<HTMLElement>("[data-slot='u3-tool-card-raw']");
  return (element.textContent ?? "").replace(raw?.textContent ?? "", "");
}

describe("SecurityScanCard", () => {
  test("scan progress shows the phase and the finding count", () => {
    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "status", operation_id: "op-1" },
          scanResult({
            action: "status",
            operation: operation({ phase: "reviewing", findingCount: 3 }),
          }),
        )}
      />,
    );
    expandToolCards();
    expect(header().textContent).toContain("Check scan progress");
    expect(screen.getByTestId("t7-security-operation").textContent).toBe(
      "Reviewing code · 3 findings",
    );
    expect(shownText(card())).not.toContain("op-1");
  });

  test("a clean finished scan reads as zero findings", () => {
    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "status", operation_id: "op-1" },
          scanResult({
            action: "status",
            operation: operation({ phase: "completed", findingCount: 0 }),
          }),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByTestId("t7-security-operation").textContent).toBe("Completed · 0 findings");
  });

  test("cloud stats show severity chips with tones and a cloud-only note", () => {
    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "cloud_status", cloud_configuration_id: "cfg-1" },
          scanResult({
            action: "cloud_status",
            cloudStats: {
              configurationId: "cfg-1",
              currentStep: "scanning_commits",
              pendingCommits: 2,
              finishedCommits: 1,
              failedCommits: 0,
              findingCounts: { critical: 1, high: 0, medium: 4, low: 2, informational: 0 },
            },
          }),
        )}
      />,
    );
    expandToolCards();
    expect(header().textContent).toContain("Check cloud scan");
    expect(card().textContent).toContain("Scanning commits · 1 commit scanned · 2 pending");
    const chips = Array.from(screen.getByTestId("t7-security-severities").children);
    expect(chips.map((chip) => chip.textContent)).toEqual(["1 critical", "4 medium", "2 low"]);
    expect(chips[0]?.className).toContain("bg-danger-surface");
    expect(chips[1]?.className).toContain("bg-warning-surface");
    expect(chips[2]?.className).toContain("bg-muted");
    expect(card().textContent).toContain(
      "Results stay in Codex Security cloud until you import them.",
    );
    expect(card().querySelector("a")).toBeNull();
  });

  test("cloud stats with no severities say there are no findings", () => {
    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "cloud_status" },
          scanResult({
            action: "cloud_status",
            cloudStats: {
              finishedCommits: 5,
              pendingCommits: 0,
              failedCommits: 0,
              findingCounts: { critical: 0, high: 0, medium: 0, low: 0, informational: 0 },
            },
          }),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getByText("No findings so far.")).toBeTruthy();
    expect(screen.queryByTestId("t7-security-severities")).toBeNull();
  });

  test("a long cloud scan list is cut at 20 and says how much", () => {
    const configurations = Array.from({ length: 25 }, (_, index) => ({
      id: `cfg-${index}`,
      repositoryId: `repo-${index}`,
      repositoryUrl: `https://github.com/example/repo-${index}`,
      environmentId: "env-1",
      currentStep: "idle",
    }));
    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "cloud_scans" },
          scanResult({ action: "cloud_scans", cloudConfigurations: configurations }),
        )}
      />,
    );
    expandToolCards();
    expect(header().textContent).toContain("List cloud scans");
    expect(card().querySelectorAll("li")).toHaveLength(20);
    expect(screen.getByText("Showing 20 of 25")).toBeTruthy();
    expect(shownText(card())).not.toContain("repo-24");
  });

  test("validation shows the finding and a toned outcome chip", () => {
    render(
      <SecurityScanCard
        rendererProps={props(
          {
            action: "validate",
            scan_id: "scan-1",
            finding_id: "F-12",
            validation_status: "validated",
          },
          scanResult({
            action: "validate",
            finding: { id: "F-12", validationStatus: "validated" },
          }),
        )}
      />,
    );
    expandToolCards();
    expect(header().textContent).toContain("Validate finding F-12");
    const chip = screen.getByText("Confirmed");
    expect(chip.className).toContain("bg-danger-surface");
    expect(screen.getByText("Finding F-12")).toBeTruthy();
  });

  test("a failed validation and an operation error each show once", () => {
    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "validate", finding_id: "F-7" },
          scanResult({ action: "validate", finding: { id: "F-7", validationStatus: "error" } }),
        )}
      />,
    );
    expandToolCards();
    expect(screen.getAllByText("Validation failed")).toHaveLength(1);
    cleanup();

    const failed = scanResult({
      action: "status",
      operation: operation({
        phase: "failed",
        findingCount: 0,
        error: "Reviewer model timed out.",
      }),
    });
    render(<SecurityScanCard rendererProps={props({ action: "status" }, failed)} />);
    expandToolCards();
    expect(screen.getAllByText("Reviewer model timed out.")).toHaveLength(1);
    cleanup();

    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "status" },
          failed,
          { type: "incomplete", reason: "error" },
          "security-failed",
        )}
      />,
    );
    expandToolCards();
  });

  test("a running plan names the target from its arguments", () => {
    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "preflight", target_kind: "scoped_path", include_paths: ["src/", "lib/"] },
          undefined,
          { type: "running" },
          "security-plan",
        )}
      />,
    );
    expect(header().textContent).toContain("Plan a scan of src/, lib/");
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expandToolCards();
    expect(screen.queryByText("Scan details unavailable.")).toBeNull();
  });

  test("an imported cloud pull says where to view the findings", () => {
    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "cloud_pull" },
          scanResult({ action: "cloud_pull", importedScan: { id: "scan-9", findingCount: 1 } }),
        )}
      />,
    );
    expandToolCards();
    expect(header().textContent).toContain("Import cloud findings");
    expect(card().textContent).toContain(
      "Imported 1 finding. Review imported findings with /security.",
    );
  });

  test("malformed details show one muted fallback line and no raw data", () => {
    render(
      <SecurityScanCard
        rendererProps={props(
          { action: "status" },
          scanResult({ action: "status", operation: "preflight-secret" }),
          undefined,
          "security-malformed",
        )}
      />,
    );
    const malformed = screen.getByTestId("t7-security-card-security-malformed");
    expect(header().getAttribute("aria-expanded")).toBe("false");
    expandToolCards();
    expect(screen.getByText("Scan details unavailable.")).toBeTruthy();
    expect(shownText(malformed)).not.toContain("preflight-secret");
  });

  test("with nothing known the header falls back to Security scan", () => {
    render(<SecurityScanCard rendererProps={props({}, undefined, { type: "running" })} />);
    expect(header().textContent).toContain("Security scan");
  });
});
