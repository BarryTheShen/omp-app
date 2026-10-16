import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { normalizeToolCall, type ToolRendererProps } from "../U3/tool-card";
import { T1_TOOL_DESCRIPTORS } from "./descriptor";
import { EditToolRenderer } from "./edit";
import { T1_LIFECYCLE_FIXTURES, type T1LifecycleFixture } from "./fixtures/lifecycle";
import { T1_OMP_SOURCE_RESULTS } from "./fixtures/source-results";
import { createReadToolRenderer } from "./read";
import type { ReadUrlRenderer } from "./read-url-seam";

afterEach(cleanup);

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

/** Phrases a card shows when it could not read the result omp sent. None may appear for a result omp returned. */
const PLACEHOLDERS = [
  "No displayable content",
  "Malformed",
  "malformed",
  "Unable to render",
  "unavailable",
  "[object Object]",
  "undefined",
  "NaN",
  "(no before text)",
  "(no replacement text)",
];

/** The stand-in for T4's URL renderer: it shows the first line of the text it is given, so the test can see it. */
const URL_STUB: ReadUrlRenderer = (props) => <p>stub: {props.text.split("\n")[0] ?? ""}</p>;

/** Every T1 source file, tests excluded and playgrounds included, with its text. */
function sourceFiles(): Array<{ readonly name: string; readonly text: string }> {
  return readdirSync(MODULE_DIR, { recursive: true })
    .map((entry) => String(entry))
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({
      name: relative(MODULE_DIR, join(MODULE_DIR, name)),
      text: readFileSync(join(MODULE_DIR, name), "utf8"),
    }));
}

/** The module specifiers a file names: `from "x"`, `import "x"`, `import("x")` and `require("x")`. */
function importsOf(text: string): string[] {
  return [...text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g)].map(
    (match) => match[1] ?? "",
  );
}

/** Calls that run a tool, fetch, or read or write a file: none may appear in a T1 source file. */
const FORBIDDEN =
  /\bfetch\s*\(|child_process|Bun\.spawn|Bun\.file|Bun\.write|node:fs|(?:from|import|require)\s*\(?\s*["'](?:fs|fs\/promises)["']|readFile\(|XMLHttpRequest|new WebSocket\(/;

/** The text a person can read: the card with its closed raw details removed, as registry/real-results.test.tsx reads it. */
function visibleText(container: HTMLElement): string {
  const copy = container.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll("details:not([open]) > :not(summary)"))
    hidden.remove();
  return (copy.textContent ?? "").replace(/\s+/g, " ");
}

/** A folded card's body is not on screen, so open every fold, as a person would, before reading the text. */
function openEveryFold(container: HTMLElement) {
  for (let pass = 0; pass < 4; pass += 1) {
    for (const trigger of container.querySelectorAll('button[aria-expanded="false"]')) {
      fireEvent.click(trigger);
    }
  }
}

/** Each disclosure button names an element on the page that it controls. */
function expectDisclosuresLinked(container: HTMLElement) {
  for (const trigger of container.querySelectorAll("button[aria-controls]")) {
    const id = trigger.getAttribute("aria-controls") ?? "";
    expect(
      container.ownerDocument.getElementById(id),
      `the disclosure controls #${id}`,
    ).not.toBeNull();
  }
}

/** The descriptor that owns a fixture, by its id. */
function descriptorOf(fixture: T1LifecycleFixture) {
  const descriptor = T1_TOOL_DESCRIPTORS.find((item) => item.id === fixture.descriptor);
  if (descriptor === undefined) throw new Error(`No T1 descriptor ${fixture.descriptor}`);
  return descriptor;
}

/**
 * Renders one fixture's call through its descriptor's renderer, or T4's stub for a URL read. It passes no R0 state
 * (toolState, outputMeta, nested, runActive), which the transcript adds; the gate does not check those.
 */
function renderFixture(fixture: T1LifecycleFixture) {
  const Renderer =
    fixture.renderer === "url-stub"
      ? createReadToolRenderer(URL_STUB)
      : descriptorOf(fixture).renderer;
  const props = {
    type: "tool-call",
    toolCallId: fixture.input.toolCallId,
    toolName: fixture.input.toolName,
    args: fixture.input.args,
    argsText: fixture.input.argsText,
    result: fixture.input.result,
    isError: fixture.input.isError,
    status: fixture.input.status,
  } as unknown as ToolRendererProps;
  return render(<Renderer {...props} />);
}

describe("T1 descriptors", () => {
  test("pass the registry's rules: owner prefix, unique ids, known inventory rows, no double claim", () => {
    expect(validateRegistry(T1_TOOL_DESCRIPTORS)).toEqual([]);
  });

  test("cover each T1 inventory row once and claim no other row except the shared T4 URL row", () => {
    const t1Rows = INVENTORY.filter((row) => row.group === "T1").map((row) => row.id);
    const claimed = T1_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(t1Rows).toHaveLength(5);
    for (const id of t1Rows) expect(claimed.filter((row) => row === id)).toHaveLength(1);
    expect(claimed.filter((row) => !t1Rows.includes(row))).toEqual(["T4.fetch-read-url-path"]);
  });

  test("apply_patch keeps its own tool name and shares the edit renderer", () => {
    const alias = T1_TOOL_DESCRIPTORS.find(
      (descriptor) => descriptor.id === "T1.applyPatchRendererAlias",
    );
    expect(alias?.match).toEqual({ by: "name", name: "apply_patch" });
    expect(alias?.renderer).toBe(EditToolRenderer);
  });

  test("no T1 descriptor requires a capability", () => {
    expect(T1_TOOL_DESCRIPTORS.every((descriptor) => descriptor.requires.length === 0)).toBe(true);
  });
});

describe("T1 lifecycle fixtures", () => {
  for (const descriptor of T1_TOOL_DESCRIPTORS) {
    test(`fixture coverage: ${descriptor.id} has the running, partial, cancelled, success and error states, and a large-result marker (by name)`, () => {
      const mine = T1_LIFECYCLE_FIXTURES.filter((fixture) => fixture.descriptor === descriptor.id);
      const states = new Set(mine.map((fixture) => fixture.name.split(":")[0]));
      for (const state of ["running", "partial", "cancelled", "success", "error"]) {
        expect(states.has(state), `${descriptor.id} has no ${state} fixture`).toBe(true);
      }
      expect(mine.some((fixture) => fixture.size === "large")).toBe(true);
    });
  }
  test("source-built results use omp text content blocks", () => {
    for (const fixture of T1_OMP_SOURCE_RESULTS) {
      expect(fixture.result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.any(String) }),
      ]);
    }
  });

  for (const fixture of T1_LIFECYCLE_FIXTURES) {
    test(`normalizes ${fixture.name} to its state and keeps the raw call`, () => {
      const state = normalizeToolCall(fixture.input);
      expect(state).toMatchObject(fixture.expect);
      expect(state.argsText).toBe(fixture.input.argsText);
      if (fixture.expect.result !== undefined) expect(state.result).toEqual(fixture.input.result);
    });
  }

  test("two calls that run at once keep their own ids and their own arguments", () => {
    const [first, second] = T1_LIFECYCLE_FIXTURES.filter((fixture) =>
      fixture.name.startsWith("concurrent:"),
    );
    if (first === undefined || second === undefined) throw new Error("No concurrent fixtures");
    const a = normalizeToolCall(first.input);
    const b = normalizeToolCall(second.input);
    expect(a.toolCallId).not.toBe(b.toolCallId);
    expect(a.args).toEqual(first.input.args);
    expect(b.args).toEqual(second.input.args);
    expect(a.args).not.toEqual(b.args);
  });

  // Every URL result belongs to T4, so this gate renders only the running one with the shared card grammar.
  for (const fixture of T1_LIFECYCLE_FIXTURES.filter(
    (item) => item.renderer !== "url-stub" || item.expect.phase === "running",
  )) {
    test(`renders ${fixture.name} with the shared card grammar`, () => {
      const { container } = renderFixture(fixture);
      const card = container.querySelector("[data-slot='u3-tool-card']");
      expect(card?.getAttribute("data-phase")).toBe(fixture.expect.phase);
      expect(container.querySelector("button[aria-expanded][aria-controls]")).toBeTruthy();
      openEveryFold(container);
      expectDisclosuresLinked(container);
    });
  }

  for (const fixture of T1_LIFECYCLE_FIXTURES.filter(
    (item) => item.expect.phase === "success" || item.expect.phase === "error",
  )) {
    test(`shows the facts of ${fixture.name} once its card is open`, () => {
      const { container } = renderFixture(fixture);
      openEveryFold(container);
      const text = visibleText(container);
      for (const fact of fixture.shows) expect(text).toContain(fact.replace(/\s+/g, " "));
    });

    test(`shows no placeholder phrase for ${fixture.name}`, () => {
      const { container } = renderFixture(fixture);
      openEveryFold(container);
      const text = visibleText(container);
      for (const placeholder of PLACEHOLDERS) expect(text).not.toContain(placeholder);
    });
  }

  test("a URL read is handed to the injected T4 renderer, and the card shows what T4 draws", () => {
    const fixture = T1_LIFECYCLE_FIXTURES.find(
      (item) => item.renderer === "url-stub" && item.expect.phase === "success",
    );
    if (fixture === undefined) throw new Error("No URL read fixture");
    const { container } = renderFixture(fixture);
    openEveryFold(container);
    const text = visibleText(container);
    expect(text).toContain("stub: URL: https://example.com/docs/guide");
    expect(text).not.toContain("URL renderer unavailable");
  });
  test("a URL read without the injected renderer shows that the renderer is unavailable", () => {
    const fixture = T1_LIFECYCLE_FIXTURES.find(
      (item) => item.renderer === "url-stub" && item.expect.phase === "success",
    );
    if (fixture === undefined) throw new Error("No URL read fixture");
    const Renderer = createReadToolRenderer();
    const props = {
      type: "tool-call",
      ...fixture.input,
    } as unknown as ToolRendererProps;
    const { container } = render(<Renderer {...props} />);
    openEveryFold(container);
    expect(visibleText(container)).toContain("URL renderer unavailable");
  });

  test("shows a notice when a read's details do not decode", () => {
    const Renderer = createReadToolRenderer();
    const props = {
      type: "tool-call",
      toolCallId: "t1-undecodable-read",
      toolName: "read",
      args: { path: "src/app.ts" },
      argsText: '{"path":"src/app.ts"}',
      result: { content: [{ type: "text", text: "const retries = 3;" }], details: "not an object" },
      isError: false,
      status: { type: "complete" },
    } as unknown as ToolRendererProps;
    const { container } = render(<Renderer {...props} />);
    openEveryFold(container);
    expect(visibleText(container)).toContain(
      "Malformed read details; showing the raw tool result.",
    );
  });
});

describe("T1 source", () => {
  test("imports no other tool module and no registry, playgrounds included, so T1 never imports T2 to T7 or edits the central registry", () => {
    for (const file of sourceFiles()) {
      for (const specifier of importsOf(file.text)) {
        const reaches = /(^|\/)T[2-7](\/|$)/.test(specifier) || /registry/.test(specifier);
        expect({ file: file.name, specifier, reaches }).toEqual({
          file: file.name,
          specifier,
          reaches: false,
        });
      }
    }
  });

  test("runs no tool, fetches nothing and reads or writes no file: each card is drawn from the call it is given", () => {
    for (const file of sourceFiles()) {
      const found = FORBIDDEN.exec(file.text)?.[0] ?? null;
      expect({ file: file.name, found }).toEqual({ file: file.name, found: null });
    }
  });
});
