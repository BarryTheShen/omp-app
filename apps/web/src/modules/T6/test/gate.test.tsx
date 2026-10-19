import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { INVENTORY, validateRegistry } from "@omp-app/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DESCRIPTORS } from "@/registry";
import { createRegistry } from "@/registry-core";
import { isDescriptorAvailable } from "@/registry-core/hooks";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { normalizeToolCall } from "../../U3/tool-card/normalize";
import { createToolRegistry } from "../../U3/tool-card/registry";
import {
  T6_EMPTY_STATE_FIXTURES,
  T6_LIFECYCLE_FIXTURES,
  type T6LifecycleFixture,
} from "../fixtures/lifecycle";
import { T6_SOURCE_RESULTS } from "../fixtures/source-results";
import {
  MemoryEditRenderer,
  normalizeRecall,
  normalizeReflect,
  RecallRenderer,
  RetainRenderer,
  T6_INVENTORY_COVERS,
  T6_TOOL_DESCRIPTORS,
} from "../index";

afterEach(cleanup);

const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLACEHOLDERS = [
  "Unable to render",
  "Malformed",
  "malformed",
  "undefined",
  "NaN",
  "[object Object]",
  "No displayable content",
  "unavailable",
];
interface ExpectedDescriptor {
  readonly covers: readonly string[];
  readonly requires: readonly string[];
  readonly match: { readonly by: "name"; readonly name: string };
}
const EXPECTED_DESCRIPTOR_TABLE: Readonly<Record<string, ExpectedDescriptor>> = {
  "T6.learn": { covers: ["T6.learn"], requires: [], match: { by: "name", name: "learn" } },
  "T6.manage-skill": {
    covers: ["T6.manage-skill"],
    requires: [],
    match: { by: "name", name: "manage_skill" },
  },
  "T6.memory-edit": {
    covers: ["T6.memory-edit"],
    requires: [],
    match: { by: "name", name: "memory_edit" },
  },
  "T6.recall": { covers: ["T6.recall"], requires: [], match: { by: "name", name: "recall" } },
  "T6.xdRecall": { covers: [], requires: [], match: { by: "name", name: "xd__recall" } },
  "T6.reflect": { covers: ["T6.reflect"], requires: [], match: { by: "name", name: "reflect" } },
  "T6.retain": { covers: ["T6.retain"], requires: [], match: { by: "name", name: "retain" } },
  "T6.xdRetain": { covers: [], requires: [], match: { by: "name", name: "xd__retain" } },
};
const EMPTY_BRANCH_TEXT: Readonly<Partial<Record<string, string>>> = {
  "T6.recall": "No memory text returned.",
  "T6.reflect": "No synthesized answer returned.",
  "T6.retain": "No memory items returned.",
  "T6.learn": "No memory lesson returned.",
  "T6.manage-skill": "No skill name was given.",
};

function descriptorOf(fixture: T6LifecycleFixture) {
  const descriptor = T6_TOOL_DESCRIPTORS.find((item) => item.id === fixture.descriptor);
  if (descriptor === undefined) throw new Error(`No T6 descriptor ${fixture.descriptor}`);
  return descriptor;
}

function renderFixture(fixture: T6LifecycleFixture) {
  const Renderer = descriptorOf(fixture).renderer;
  const props = { type: "tool-call", ...fixture.input } as unknown as ToolRendererProps;
  return render(<Renderer {...props} />);
}

function openEveryFold(container: HTMLElement) {
  for (let pass = 0; pass < 4; pass += 1) {
    for (const trigger of container.querySelectorAll('button[aria-expanded="false"]')) {
      fireEvent.click(trigger);
    }
  }
}

function expectDisclosuresLinked(container: HTMLElement) {
  const triggers = [...container.querySelectorAll("button[aria-controls]")];
  expect(triggers.length).toBeGreaterThan(0);
  for (const trigger of triggers) {
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

function sourceFiles(): Array<{ readonly name: string; readonly text: string }> {
  return readdirSync(MODULE_DIR, { recursive: true })
    .map(String)
    .filter((name) => /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name))
    .map((name) => ({
      name: relative(MODULE_DIR, join(MODULE_DIR, name)),
      text: readFileSync(join(MODULE_DIR, name), "utf8"),
    }));
}

const FORBIDDEN =
  /\bfetch\s*\(|child_process|Bun\.spawn|Bun\.file|Bun\.write|node:fs|readFile\(|XMLHttpRequest|new WebSocket\(|(?:from|import|require)\s*\(?\s*["'](?:fs|fs\/promises)["']/;

const INVENTORY_DESCRIPTORS = T6_TOOL_DESCRIPTORS.filter((descriptor) =>
  descriptor.covers.some((row) =>
    T6_INVENTORY_COVERS.includes(row as (typeof T6_INVENTORY_COVERS)[number]),
  ),
);

describe("T6 public descriptors and lifecycle coverage", () => {
  test("pins every descriptor's literal inventory, capability requirement, and tool match", () => {
    expect(T6_TOOL_DESCRIPTORS).toHaveLength(Object.keys(EXPECTED_DESCRIPTOR_TABLE).length);
    for (const descriptor of T6_TOOL_DESCRIPTORS) {
      expect({
        covers: descriptor.covers,
        requires: descriptor.requires,
        match: descriptor.match,
      }).toEqual(EXPECTED_DESCRIPTOR_TABLE[descriptor.id]);
    }
    const rows = INVENTORY.filter((row) => row.group === "T6").map((row) => row.id);
    const claimed = T6_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(rows).toHaveLength(6);
    expect(claimed.filter((id) => id.startsWith("T6.")).sort()).toEqual([...rows].sort());
    expect(new Set(claimed).size).toBe(6);
    expect(validateRegistry(T6_TOOL_DESCRIPTORS)).toEqual([]);
  });

  test("composes T6 in the central registry without a second claim", () => {
    const registry = createRegistry([...DESCRIPTORS]);
    const t6 = registry.descriptors.filter((descriptor) => descriptor.id.startsWith("T6."));
    expect(t6).toHaveLength(T6_TOOL_DESCRIPTORS.length);
    for (const row of T6_INVENTORY_COVERS) {
      expect(
        registry.descriptors.filter((descriptor) => descriptor.covers.includes(row)).length,
      ).toBe(1);
    }
  });

  test("keeps the aliases on their intended renderers", () => {
    expect(
      T6_TOOL_DESCRIPTORS.find((descriptor) => descriptor.id === "T6.xdRecall")?.renderer,
    ).toBe(RecallRenderer);
    expect(
      T6_TOOL_DESCRIPTORS.find((descriptor) => descriptor.id === "T6.xdRetain")?.renderer,
    ).toBe(RetainRenderer);
  });

  test("memory-edit remains visible through the shared registry with no capability map", () => {
    const registry = createToolRegistry(T6_TOOL_DESCRIPTORS);
    const resolution = registry.resolve("memory_edit", {});
    expect(resolution.available).toBe(true);
    expect(resolution.renderer).toBe(MemoryEditRenderer);
    const fixture = T6_LIFECYCLE_FIXTURES.find(
      (item) => item.descriptor === "T6.memory-edit" && item.expect.phase === "success",
    );
    if (fixture === undefined) throw new Error("Missing memory-edit success fixture");
    expect(
      renderFixture(fixture).container.querySelector("[data-t6-tool='memory_edit']"),
    ).not.toBeNull();
    for (const descriptor of T6_TOOL_DESCRIPTORS)
      expect(isDescriptorAvailable(descriptor, {})).toBe(true);
  });

  for (const descriptor of INVENTORY_DESCRIPTORS) {
    test(`${descriptor.id} has every lifecycle phase and a fixture exceeding 4,000 characters`, () => {
      const fixtures = T6_LIFECYCLE_FIXTURES.filter(
        (fixture) => fixture.descriptor === descriptor.id,
      );
      const states = new Set(fixtures.map((fixture) => fixture.name.split(":")[0]));
      for (const state of ["running", "partial", "cancelled", "success", "error"]) {
        expect(states.has(state), `${descriptor.id} lacks ${state}`).toBe(true);
      }
      const large = fixtures.find(
        (fixture) => fixture.size === "large" && fixture.expect.phase === "success",
      );
      expect(large).toBeDefined();
      if (large !== undefined) {
        expect(
          (JSON.stringify(large.input.args)?.length ?? 0) +
            (JSON.stringify(large.input.result)?.length ?? 0),
        ).toBeGreaterThan(4_000);
      }
    });
  }

  for (const fixture of T6_LIFECYCLE_FIXTURES) {
    test(`normalizes ${fixture.name} to its expected tool state`, () => {
      const state = normalizeToolCall(fixture.input);
      expect(state).toMatchObject(fixture.expect);
      expect(state.argsText).toBe(fixture.input.argsText);
      if (fixture.expect.result !== undefined) expect(state.result).toEqual(fixture.input.result);
    });

    test(`renders ${fixture.name} with its phase, disclosures and visible facts`, () => {
      const { container } = renderFixture(fixture);
      const card = container.querySelector("[data-slot='u3-tool-card']");
      expect(card?.getAttribute("data-phase")).toBe(fixture.expect.phase);
      openEveryFold(container);
      expectDisclosuresLinked(container);
      const text = visibleText(container);
      for (const placeholder of PLACEHOLDERS) expect(text).not.toContain(placeholder);
      if (fixture.expect.phase === "success" || fixture.expect.phase === "error") {
        for (const fact of fixture.shows) expect(text).toContain(fact.replace(/\s+/g, " "));
      }
    });
  }

  for (const fixture of T6_EMPTY_STATE_FIXTURES) {
    test(`renders ${fixture.name} as an unrecorded empty state`, () => {
      const { container } = renderFixture(fixture);
      expect(
        container.querySelector("[data-slot='u3-tool-card']")?.getAttribute("data-phase"),
      ).toBe("unrecorded");
      openEveryFold(container);
      expectDisclosuresLinked(container);
      const text = visibleText(container);
      const expected = EMPTY_BRANCH_TEXT[fixture.descriptor];
      if (expected !== undefined) expect(text).toContain(expected);
    });
  }

  test("two concurrent recall calls render their own query and memory, never the other's", () => {
    const call = (id: string, query: string, memory: string) =>
      ({
        type: "tool-call",
        toolCallId: id,
        toolName: "recall",
        args: { query },
        argsText: JSON.stringify({ query }),
        result: {
          content: [
            {
              type: "text",
              text: `Found 1 relevant memory (as of 2026-10-07 21:44 UTC):\n\n- ${memory}`,
            },
          ],
          details: {},
        },
        isError: false,
        status: { type: "complete" },
      }) as unknown as ToolRendererProps;
    const { container } = render(
      <>
        <RecallRenderer {...call("t6-concurrent-first", "first query", "First stored memory.")} />
        <RecallRenderer
          {...call("t6-concurrent-second", "second query", "Second stored memory.")}
        />
      </>,
    );
    const cards = [...container.querySelectorAll<HTMLElement>("[data-t6-tool='recall']")];
    expect(cards).toHaveLength(2);
    for (const card of cards) openEveryFold(card);
    const [first, second] = cards.map((card) => visibleText(card));
    expect(first).toContain("first query");
    expect(first).toContain("First stored memory.");
    expect(first).not.toMatch(/second|Second/);
    expect(second).toContain("second query");
    expect(second).toContain("Second stored memory.");
    expect(second).not.toMatch(/first|First/);
    const controls = [...container.querySelectorAll("button[aria-controls]")].map((button) =>
      button.getAttribute("aria-controls"),
    );
    expect(controls.length).toBeGreaterThan(1);
    expect(new Set(controls).size).toBe(controls.length);
  });

  test("recognises empty recall and reflect source results in the T6 models", () => {
    const recall = T6_SOURCE_RESULTS.find(
      (sample) => sample.name === "scripted recall: no memories",
    );
    const reflect = T6_SOURCE_RESULTS.find(
      (sample) => sample.name === "scripted reflect: no relevant information",
    );
    if (recall === undefined || reflect === undefined)
      throw new Error("Missing scripted empty result");
    expect(normalizeRecall(recall.args, recall.result).noMatch).toBe(true);
    expect(normalizeReflect(reflect.args, reflect.result).noInformation).toBe(true);
  });

  test("bounds large recall and reflect previews at the 4,000-character limit", () => {
    const recall = T6_SOURCE_RESULTS.find(
      (sample) => sample.name === "scripted recall: large result past the memory text limit",
    );
    const reflect = T6_SOURCE_RESULTS.find(
      (sample) => sample.name === "scripted reflect: large answer past the memory text limit",
    );
    if (recall === undefined || reflect === undefined)
      throw new Error("Missing large source results");
    const recallModel = normalizeRecall(recall.args, recall.result);
    const reflectModel = normalizeReflect(reflect.args, reflect.result);
    expect(recallModel.content.truncated).toBe(true);
    expect(recallModel.content.text).toHaveLength(4_001);
    expect(recallModel.content.text.endsWith("…")).toBe(true);
    expect(reflectModel.answer.truncated).toBe(true);
    expect(reflectModel.answer.text).toHaveLength(4_001);
    expect(reflectModel.answer.text.endsWith("…")).toBe(true);
    const recallFixture = T6_LIFECYCLE_FIXTURES.find(
      (fixture) => fixture.name.includes(recall.name) && fixture.expect.phase === "success",
    );
    const reflectFixture = T6_LIFECYCLE_FIXTURES.find(
      (fixture) => fixture.name.includes(reflect.name) && fixture.expect.phase === "success",
    );
    if (recallFixture === undefined || reflectFixture === undefined)
      throw new Error("Missing large lifecycle fixtures");
    expect(visibleText(renderFixture(recallFixture).container)).toContain(
      "Memory preview truncated.",
    );
    expect(visibleText(renderFixture(reflectFixture).container)).toContain(
      "Reflection preview truncated.",
    );
  });
});

describe("T6 safety boundary", () => {
  test("does not import another tool module, registry, filesystem, network or process APIs", () => {
    for (const file of sourceFiles()) {
      const imports = [
        ...file.text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g),
      ].map((match) => match[1] ?? "");
      for (const specifier of imports) {
        expect(specifier, `${file.name} imports ${specifier}`).not.toMatch(
          /(^|\/)T[1-57](\/|$)|registry/,
        );
      }
      expect(file.text.match(FORBIDDEN)?.[0] ?? null).toBeNull();
    }
  });
});
