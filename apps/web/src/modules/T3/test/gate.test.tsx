import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INVENTORY, ToolCallId, validateRegistry } from "@omp-app/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DESCRIPTORS } from "../../../registry";
import { createRegistry, isDescriptorAvailable } from "../../../registry-core";
import { normalizeToolCall, type ToolRendererProps } from "../../U3/tool-card";
import { T3_INVENTORY_COVERS, T3_TOOL_DESCRIPTORS } from "../descriptor";
import { T3_LIFECYCLE_FIXTURES, type T3LifecycleFixture } from "../fixtures/lifecycle";
import * as T3 from "../index";

const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLACEHOLDERS = [
  "No displayable content",
  "Malformed",
  "malformed",
  "Unable to render",
  "unavailable",
  "[object Object]",
  "undefined",
  "NaN",
];
const EXPECTED_T3: Readonly<
  Record<string, { covers: readonly string[]; requires: readonly string[] }>
> = {
  "T3.computer": { covers: ["T3.computer"], requires: [] },
  "T3.debug": { covers: ["T3.debug"], requires: [] },
  "T3.eval": { covers: ["T3.eval"], requires: [] },
};
afterEach(cleanup);

function openEveryFold(container: HTMLElement) {
  for (let pass = 0; pass < 4; pass += 1) {
    for (const trigger of container.querySelectorAll('button[aria-expanded="false"]'))
      fireEvent.click(trigger);
  }
}

function expectDisclosuresLinked(container: HTMLElement) {
  for (const trigger of container.querySelectorAll("button[aria-controls]")) {
    const id = trigger.getAttribute("aria-controls") ?? "";
    expect(
      container.ownerDocument.getElementById(id),
      `the disclosure controls #${id}`,
    ).not.toBeNull();
  }
}

function visibleText(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll("details:not([open]) > :not(summary)"))
    hidden.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ");
}

function renderFixture(fixture: T3LifecycleFixture) {
  const descriptor = T3_TOOL_DESCRIPTORS.find((candidate) => candidate.id === fixture.descriptor);
  if (!descriptor) throw new Error(`No descriptor ${fixture.descriptor}`);
  return render(<descriptor.renderer {...(fixture.input as ToolRendererProps)} />);
}
function fixtureNamed(name: string): T3LifecycleFixture {
  const fixture = T3_LIFECYCLE_FIXTURES.find((candidate) => candidate.name === name);
  if (!fixture) throw new Error(`Missing T3 fixture ${name}`);
  return fixture;
}

function withResultDetails(
  fixture: T3LifecycleFixture,
  patch: Readonly<Record<string, unknown>>,
): T3LifecycleFixture {
  const result = fixture.input.result;
  if (result === null || typeof result !== "object" || Array.isArray(result))
    throw new Error(`Fixture ${fixture.name} has no result envelope`);
  const envelope = result as Record<string, unknown>;
  const details = envelope.details;
  if (details === null || typeof details !== "object" || Array.isArray(details))
    throw new Error(`Fixture ${fixture.name} has no details object`);
  return {
    ...fixture,
    input: {
      ...fixture.input,
      result: { ...envelope, details: { ...(details as Record<string, unknown>), ...patch } },
    },
  };
}

function sourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(MODULE_DIR, { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(MODULE_DIR, name), "utf8") }));
}

describe("T3 descriptors and W4 coverage", () => {
  test("validates the three T3 inventory claims exactly once", () => {
    expect(validateRegistry(T3_TOOL_DESCRIPTORS)).toEqual([]);
    const rows = INVENTORY.filter((row) => row.group === "T3").map((row) => row.id);
    expect(T3_INVENTORY_COVERS).toEqual(rows);
    expect(T3_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)).toEqual(rows);
  });

  test("pins each descriptor's covers, requires and availability", () => {
    for (const descriptor of T3_TOOL_DESCRIPTORS) {
      expect({ covers: descriptor.covers, requires: descriptor.requires }).toEqual(
        EXPECTED_T3[descriptor.id],
      );
      expect(isDescriptorAvailable(descriptor, {})).toBe(true);
    }
  });

  test("composes T3 through the app registry with each inventory row exactly once", () => {
    const registry = createRegistry(DESCRIPTORS);
    for (const row of T3_INVENTORY_COVERS) {
      expect(
        registry.descriptors.filter((descriptor) => descriptor.covers.includes(row)),
      ).toHaveLength(1);
    }
  });

  test("keeps exact tool names and pins the complete public barrel", () => {
    expect(T3_TOOL_DESCRIPTORS.map((descriptor) => descriptor.match)).toEqual([
      { by: "name", name: "computer" },
      { by: "name", name: "debug" },
      { by: "name", name: "eval" },
    ]);
    expect(Object.keys(T3).sort()).toEqual(
      [
        "ComputerArgsSchema",
        "ComputerDetailsSchema",
        "DebugArgsSchema",
        "DebugCard",
        "DebugDetailsSchema",
        "DebugToolRenderer",
        "EvalArgsSchema",
        "EvalCard",
        "EvalCellSchema",
        "EvalDetailsSchema",
        "EvalToolRenderer",
        "T3_INVENTORY_COVERS",
        "T3_TOOL_DESCRIPTORS",
        "decodeComputerArgs",
        "decodeDebugArgs",
        "decodeDebugDetails",
        "decodeEvalArgs",
        "mapT3Failure",
        "normalizeComputer",
        "normalizeEval",
      ].sort(),
    );
  });
  test("renders the pre-existing computer fallback through its descriptor in every state", () => {
    const descriptor = T3_TOOL_DESCRIPTORS.find((candidate) => candidate.id === "T3.computer");
    if (!descriptor) throw new Error("No computer descriptor");
    for (const [status, phase] of [
      [{ type: "running" }, "running"],
      [{ type: "complete" }, "success"],
      [{ type: "incomplete", reason: "error", error: "computer unavailable" }, "error"],
    ] as const) {
      const props = {
        type: "tool-call",
        toolCallId: `t3-computer-fallback-${phase}`,
        toolName: "computer",
        args: { action: "capabilities" },
        argsText: '{"action":"capabilities"}',
        result: phase === "success" ? { text: "computer result" } : undefined,
        status,
      } as unknown as ToolRendererProps;
      const { container } = render(<descriptor.renderer {...props} />);
      expect(
        container.querySelector("[data-slot='u3-tool-card']")?.getAttribute("data-phase"),
      ).toBe(phase);
      expect(container.querySelector("button[aria-expanded][aria-controls]")).toBeTruthy();
      cleanup();
    }
  });

  test("covers only the renderers that exist on main: eval and debug", () => {
    expect(T3_LIFECYCLE_FIXTURES.every((fixture) => fixture.input.toolName !== "computer")).toBe(
      true,
    );
    expect(new Set(T3_LIFECYCLE_FIXTURES.map((fixture) => fixture.input.toolName))).toEqual(
      new Set(["eval", "debug"]),
    );
  });

  for (const toolName of ["eval", "debug"]) {
    test(`${toolName} has every lifecycle state${toolName === "eval" ? " and a large-result fixture" : ""}`, () => {
      const mine = T3_LIFECYCLE_FIXTURES.filter((fixture) => fixture.input.toolName === toolName);
      const states = new Set(mine.map((fixture) => fixture.name.split(":")[0]));
      for (const state of ["running", "partial", "cancelled", "success", "error"]) {
        expect(states.has(state), `${toolName} has no ${state} fixture`).toBe(true);
      }
      if (toolName === "eval") expect(mine.some((fixture) => fixture.size === "large")).toBe(true);
    });
  }
  test("reads fixture provenance and keeps recorded versus scripted bases explicit", () => {
    expect(
      T3_LIFECYCLE_FIXTURES.every((fixture) => ["recorded", "scripted"].includes(fixture.basis)),
    ).toBe(true);
    expect(T3_LIFECYCLE_FIXTURES.some((fixture) => fixture.basis === "recorded")).toBe(true);
    expect(T3_LIFECYCLE_FIXTURES.some((fixture) => fixture.basis === "scripted")).toBe(true);
  });
  for (const fixture of T3_LIFECYCLE_FIXTURES) {
    test(`normalizes ${fixture.name} and preserves its id`, () => {
      const state = normalizeToolCall(fixture.input);
      expect(state).toMatchObject(fixture.expect);
      expect(state.toolCallId).toBe(fixture.input.toolCallId);
      expect(state.argsText).toBe(fixture.input.argsText);
    });

    test(`renders ${fixture.name} with its phase and linked disclosures`, () => {
      const { container } = renderFixture(fixture);
      const card = container.querySelector("[data-slot='u3-tool-card']");
      expect(card?.getAttribute("data-phase")).toBe(fixture.expect.phase);
      expect(container.querySelector("button[aria-expanded][aria-controls]")).toBeTruthy();
      openEveryFold(container);
      expectDisclosuresLinked(container);
    });
  }

  for (const fixture of T3_LIFECYCLE_FIXTURES.filter(
    (item) => item.expect.phase === "success" || item.expect.phase === "error",
  )) {
    test(`shows returned facts and no placeholders for ${fixture.name}`, () => {
      const { container } = renderFixture(fixture);
      openEveryFold(container);
      const text = visibleText(container);
      for (const fact of fixture.shows) expect(text).toContain(fact.replace(/\s+/g, " "));
      for (const placeholder of PLACEHOLDERS) {
        if (fixture.name.includes("details unavailable") && placeholder === "unavailable") continue;
        expect(text).not.toContain(placeholder);
      }
    });
  }

  test("pins the v18.9.1 eval display preview and debug empty/error text", () => {
    const large = T3_LIFECYCLE_FIXTURES.find(
      (fixture) => fixture.name === "success: eval: scripted v18.9.1 large display preview",
    );
    if (!large) throw new Error("Missing scripted large eval fixture");
    const largeResult = large.input.result as {
      content: Array<{ text?: string }>;
      details: {
        cells: Array<{ output?: string }>;
        jsonOutputs: Array<{ preview: string; truncated: boolean; totalBytes: number }>;
        meta: { truncation: { totalBytes: number; outputLines: number; outputBytes: number } };
      };
    };
    expect(largeResult.content[0]?.text?.startsWith("display[1]:\n")).toBe(true);
    expect(largeResult.details.cells[0]?.output).toBe(largeResult.content[0]?.text);
    expect(largeResult.details.jsonOutputs[0]).toMatchObject({
      preview: expect.stringContaining("[…"),
      truncated: true,
      totalBytes: 38_892,
    });
    expect(largeResult.details.meta.truncation.totalBytes).toBe(38_892);
    expect(largeResult.details.meta.truncation.outputBytes).toBeLessThanOrEqual(8_000);
    const empty = T3_LIFECYCLE_FIXTURES.find(
      (fixture) => fixture.name.includes("no cells executed") && fixture.expect.phase === "success",
    );
    if (!empty) throw new Error("Missing empty eval fixture");
    expect((empty.input.result as { content: Array<{ text?: string }> }).content[0]?.text).toBe(
      "No cells were executed.",
    );
    const noSessions = T3_LIFECYCLE_FIXTURES.find(
      (fixture) => fixture.name.includes("no debug sessions") && fixture.expect.phase === "success",
    );
    if (!noSessions) throw new Error("Missing no-session debug fixture");
    expect(
      (noSessions.input.result as { content: Array<{ text?: string }> }).content[0]?.text,
    ).toBe("No debug sessions.");
    const debugError = T3_LIFECYCLE_FIXTURES.find(
      (fixture) => fixture.name.includes("details unavailable") && fixture.expect.phase === "error",
    );
    if (!debugError) throw new Error("Missing debug error fixture");
    expect(
      (debugError.input.result as { content: Array<{ text?: string }> }).content[0]?.text,
    ).toBe("Debug details unavailable.");
  });
  test("keeps concurrent eval and debug cards on their own ids and results", () => {
    const evalFixture = T3_LIFECYCLE_FIXTURES.find(
      (fixture) => fixture.input.toolName === "eval" && fixture.expect.phase === "success",
    );
    const debugFixture = T3_LIFECYCLE_FIXTURES.find(
      (fixture) =>
        fixture.input.toolName === "debug" &&
        fixture.name.includes("debug sessions result") &&
        fixture.expect.phase === "success",
    );
    if (!evalFixture || !debugFixture) throw new Error("Missing concurrent eval/debug fixtures");
    const evalDescriptor = T3_TOOL_DESCRIPTORS.find(
      (descriptor) => descriptor.id === evalFixture.descriptor,
    );
    const debugDescriptor = T3_TOOL_DESCRIPTORS.find(
      (descriptor) => descriptor.id === debugFixture.descriptor,
    );
    if (!evalDescriptor || !debugDescriptor) throw new Error("Missing concurrent descriptors");
    const evalInput = { ...evalFixture.input, toolCallId: "t3-concurrent-eval" };
    const debugInput = { ...debugFixture.input, toolCallId: "t3-concurrent-debug" };
    const { container } = render(
      <>
        <evalDescriptor.renderer {...(evalInput as ToolRendererProps)} />
        <debugDescriptor.renderer {...(debugInput as ToolRendererProps)} />
      </>,
    );
    openEveryFold(container);
    expect(container.querySelector("[data-testid='t3-eval-card-t3-concurrent-eval']")).toBeTruthy();
    expect(
      container.querySelector("[data-testid='t3-debug-card-t3-concurrent-debug']"),
    ).toBeTruthy();
    const text = visibleText(container);
    expect(text).toContain("python");
    expect(text).toContain("debug-session-1");
  });
  test("shows a failed eval card that says its execution details were not retained", () => {
    const fixture = fixtureNamed("success: eval: scripted no cells executed");
    const recorded = fixture.input.result as { details: unknown };
    const failure = T3.mapT3Failure(new Error("eval backend stopped"), "eval");
    const failedFixture: T3LifecycleFixture = {
      ...fixture,
      input: {
        ...fixture.input,
        toolState: {
          toolCallId: ToolCallId.parse(fixture.input.toolCallId),
          toolName: fixture.input.toolName,
          status: "error",
          result: {
            content: [{ type: "text", text: failure.appError.message }],
            details: recorded.details,
          },
          isError: true,
        },
      },
    };
    const { container } = renderFixture(failedFixture);
    openEveryFold(container);

    expect(container.querySelector("[role='alert']")?.textContent).toContain(
      "execution details were not retained in the error",
    );
  });

  test("lists all 64 eval status events from the result", () => {
    const fixture = T3_LIFECYCLE_FIXTURES.find(
      (candidate) =>
        candidate.input.toolName === "eval" &&
        candidate.name.includes("browser call with status events") &&
        candidate.expect.phase === "success",
    );
    if (!fixture) throw new Error("Missing recorded eval status-event fixture");
    const statusEvents = Array.from({ length: 64 }, (_, index) => ({
      op: "browser",
      detail: `status event ${index + 1}`,
    }));
    const result = withResultDetails(fixture, { statusEvents });
    const { container } = renderFixture(result);
    openEveryFold(container);

    const eventRows = container.querySelectorAll("[data-testid='t3-eval-status-events'] > div");
    expect(eventRows).toHaveLength(64);
    expect(eventRows[63]?.textContent).toContain("status event 64");
  });

  test("a cancelled eval call never says that evaluation finished", () => {
    const fixture = T3_LIFECYCLE_FIXTURES.find(
      (candidate) => candidate.input.toolName === "eval" && candidate.expect.phase === "cancelled",
    );
    if (!fixture) throw new Error("Missing cancelled eval fixture");
    const { container } = renderFixture(fixture);
    openEveryFold(container);

    const alert = container.querySelector("[role='alert']")?.textContent ?? "";
    expect(alert).toContain("Evaluation cancelled.");
    expect(alert).not.toContain("Evaluation finished.");
  });

  test("one eval cell is labeled as one cell", () => {
    const fixture = T3_LIFECYCLE_FIXTURES.find(
      (candidate) =>
        candidate.input.toolName === "eval" &&
        candidate.name.includes("one cell that finished") &&
        candidate.expect.phase === "success",
    );
    if (!fixture) throw new Error("Missing one-cell eval fixture");
    const { container } = renderFixture(fixture);
    const header = container.querySelector("[data-slot='u3-tool-card-trigger']")?.textContent ?? "";

    expect(header).toContain("1 cell");
    expect(header).not.toContain("1 cells");
  });

  test("the sessions action header and tooltip say Debug sessions", () => {
    const fixture = fixtureNamed("success: scripted v18.9.1 debug sessions result");
    const { container } = renderFixture(fixture);
    const summary = container.querySelector("[data-slot='u3-tool-card-trigger'] span[title]");

    expect(summary?.textContent).toBe("Debug sessions");
    expect(summary?.getAttribute("title")).toBe("Debug sessions");
  });

  test("a failed debug call's first line becomes its error banner", () => {
    const fixture = fixtureNamed("error: scripted debug details unavailable result");
    const recorded = fixture.input.result as {
      readonly content: readonly unknown[];
      readonly details: unknown;
    };
    const scriptedFailure: T3LifecycleFixture = {
      ...fixture,
      input: {
        ...fixture.input,
        result: {
          ...recorded,
          content: [
            {
              type: "text",
              text: "Debug details unavailable.\nThe adapter sent additional diagnostic text.",
            },
          ],
        },
      },
    };
    const { container } = renderFixture(scriptedFailure);

    expect(container.querySelector("[role='alert']")?.textContent).toBe(
      "Debug details unavailable.",
    );
    expect(container.querySelector("[data-testid='t3-debug-text']")).toBeNull();
  });

  test("a pending eval cell makes the call partial", () => {
    const fixture = T3_LIFECYCLE_FIXTURES.find(
      (candidate) =>
        candidate.input.toolName === "eval" &&
        candidate.name.includes("one cell that finished") &&
        candidate.expect.phase === "success",
    );
    if (!fixture) throw new Error("Missing one-cell eval fixture");
    const result = fixture.input.result as {
      readonly details: {
        readonly cells: readonly Record<string, unknown>[];
      };
    };
    const pending = withResultDetails(fixture, {
      cells: result.details.cells.map((cell, index) =>
        index === 0 ? { ...cell, status: "pending" } : cell,
      ),
    });
    const { container } = renderFixture(pending);

    expect(container.querySelector("[data-slot='u3-tool-card']")?.getAttribute("data-phase")).toBe(
      "partial",
    );
  });

  test("an unrecognized future debug session status remains visible as returned", () => {
    const fixture = fixtureNamed("success: scripted v18.9.1 debug sessions result");
    const result = fixture.input.result as {
      readonly details: {
        readonly sessions: readonly Record<string, unknown>[];
      };
    };
    const futureStatus = withResultDetails(fixture, {
      sessions: result.details.sessions.map((session, index) =>
        index === 0 ? { ...session, status: "paused" } : session,
      ),
    });
    const { container } = renderFixture(futureStatus);
    openEveryFold(container);

    expect(container.querySelector("[data-testid='t3-debug-sessions']")?.textContent).toContain(
      "Status: paused",
    );
  });

  test("does not import a registry or execute eval, debug or computer work", () => {
    for (const file of sourceFiles()) {
      expect(file.text).not.toMatch(
        /(?:from|import|require)\s*\(?\s*["'](?:fs|fs\/promises|node:fs|child_process|node:child_process)["']/,
      );
      expect(file.text).not.toMatch(
        /\b(?:fetch|Bun\.spawn|Bun\.file|child_process|execFile|readFile)\s*\(/,
      );
      expect(file.text).not.toMatch(/import\(\s*["']playwright["']\)/);
      expect(file.text).not.toMatch(
        /node:(?:fs|child_process)|WebSocket|from ["'](?:playwright|@playwright)/,
      );
      expect(file.text).not.toMatch(/\b(?:playwright|chromium|debugger)\s*\(/i);
    }
  });
});
