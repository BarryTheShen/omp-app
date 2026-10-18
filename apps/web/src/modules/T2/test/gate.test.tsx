import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { normalizeToolCall, type ToolRendererProps } from "../../U3/tool-card";
import { AstGrepToolRenderer } from "../ast-grep";
import { T2_DESCRIPTORS, T2_TOOL_DESCRIPTORS } from "../descriptor";
import { FindToolRenderer } from "../find";
import {
  T2_LATE_DIAGNOSTIC_FIXTURES,
  T2_LIFECYCLE_FIXTURES,
  type T2LifecycleFixture,
} from "../fixtures/lifecycle";
import { GlobToolRenderer } from "../glob";
import { GrepCard } from "../grep";
import { LateDiagnosticsCard } from "../late-diagnostics";
import { LspToolRenderer } from "../lsp";

const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLACEHOLDERS = [
  "No displayable content",
  "Malformed",
  "Unable to render",
  "[object Object]",
  "undefined",
  "NaN",
];

afterEach(cleanup);

function openEveryFold(container: HTMLElement) {
  for (let pass = 0; pass < 4; pass += 1) {
    for (const trigger of container.querySelectorAll('button[aria-expanded="false"]')) {
      fireEvent.click(trigger);
    }
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

function rendererOf(toolName: string) {
  switch (toolName) {
    case "ast_grep":
      return AstGrepToolRenderer;
    case "find":
      return FindToolRenderer;
    case "glob":
      return GlobToolRenderer;
    case "grep":
      return GrepCard;
    case "lsp":
      return LspToolRenderer;
    default:
      throw new Error(`No renderer for ${toolName}`);
  }
}

function renderFixture(fixture: T2LifecycleFixture) {
  const Renderer = rendererOf(fixture.input.toolName);
  return render(<Renderer {...(fixture.input as ToolRendererProps)} />);
}

function sourceFiles(): Array<{ name: string; text: string }> {
  return readdirSync(MODULE_DIR, { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({ name, text: readFileSync(join(MODULE_DIR, name), "utf8") }));
}

describe("T2 descriptors and W4 coverage", () => {
  test("validates owner-prefixed descriptors and claims exactly six T2 rows", () => {
    expect(validateRegistry(T2_DESCRIPTORS)).toEqual([]);
    const rows = INVENTORY.filter((row) => row.group === "T2").map((row) => row.id);
    const claimed = T2_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(rows).toHaveLength(6);
    expect([...claimed].sort()).toEqual([...rows].sort());
    expect(new Set(claimed).size).toBe(6);
  });

  test("claims only the five tools and one late diagnostic message", () => {
    expect(T2_TOOL_DESCRIPTORS.map((descriptor) => descriptor.match)).toEqual([
      { by: "name", name: "ast_grep" },
      { by: "name", name: "find" },
      { by: "name", name: "glob" },
      { by: "name", name: "grep" },
      { by: "name", name: "lsp" },
    ]);
    expect(T2_DESCRIPTORS.map((descriptor) => descriptor.owner)).toEqual([
      "T2",
      "T2",
      "T2",
      "T2",
      "T2",
      "T2",
    ]);
  });

  for (const descriptor of T2_TOOL_DESCRIPTORS) {
    test(`${descriptor.id} has every lifecycle state and a large-result fixture`, () => {
      const mine = T2_LIFECYCLE_FIXTURES.filter((fixture) => fixture.descriptor === descriptor.id);
      const states = new Set(mine.map((fixture) => fixture.name.split(":")[0]));
      for (const state of ["running", "partial", "cancelled", "success", "error"]) {
        expect(states.has(state), `${descriptor.id} has no ${state} fixture`).toBe(true);
      }
      expect(mine.some((fixture) => fixture.size === "large")).toBe(true);
    });
  }

  for (const fixture of T2_LIFECYCLE_FIXTURES) {
    test(`normalizes ${fixture.name} without losing raw input`, () => {
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

  for (const fixture of T2_LIFECYCLE_FIXTURES.filter(
    (item) => item.expect.phase === "success" || item.expect.phase === "error",
  )) {
    test(`shows returned facts and no placeholders for ${fixture.name}`, () => {
      const { container } = renderFixture(fixture);
      openEveryFold(container);
      const text = visibleText(container);
      for (const fact of fixture.shows) expect(text).toContain(fact.replace(/\s+/g, " "));
      for (const placeholder of PLACEHOLDERS) expect(text).not.toContain(placeholder);
    });
  }

  test("keeps two concurrent calls on their own ids and arguments", () => {
    const running = T2_LIFECYCLE_FIXTURES.filter((fixture) =>
      fixture.name.startsWith("running: glob:"),
    );
    const first = running[0];
    const second = running[1];
    if (!first || !second) throw new Error("No concurrent glob fixtures");
    const a = normalizeToolCall({ ...first.input, toolCallId: "t2-concurrent-first" });
    const b = normalizeToolCall({ ...second.input, toolCallId: "t2-concurrent-second" });
    expect(a.toolCallId).not.toBe(b.toolCallId);
    expect(a.args).toEqual(first.input.args);
    expect(b.args).toEqual(second.input.args);
    expect(a.args).not.toEqual(b.args);
  });

  test("keeps the recorded semantic-find no-hit state visible", () => {
    const fixture = T2_LIFECYCLE_FIXTURES.find(
      (item) => item.expect.phase === "success" && item.name.includes("no relevant passages"),
    );
    if (!fixture) throw new Error("No semantic-find no-hit fixture");
    const { container } = renderFixture(fixture);
    openEveryFold(container);
    expect(visibleText(container)).toContain("No matches.");
  });

  for (const fixture of T2_LATE_DIAGNOSTIC_FIXTURES) {
    test(`renders ${fixture.name} through the message adapter`, () => {
      const { container } = render(
        <LateDiagnosticsCard identity={fixture.identity} snapshot={fixture.snapshot} />,
      );
      openEveryFold(container);
      const text = visibleText(container);
      for (const fact of fixture.shows) expect(text).toContain(fact);
      expect(container.querySelector("[data-testid^='t2-late-diagnostics-']")).toBeTruthy();
    });
  }

  test("keeps descriptor source render-only and out of the central registry", () => {
    for (const file of sourceFiles()) {
      expect(file.text).not.toMatch(/from ["'][^"']*registry/);
      expect(file.text).not.toMatch(/\b(?:fetch|readFile|writeFile|Bun\.spawn)\s*\(/);
    }
  });
});
