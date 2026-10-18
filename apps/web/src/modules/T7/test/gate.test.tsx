import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CapabilityKey,
  type CapabilityMap,
  type Descriptor,
  INVENTORY,
  validateRegistry,
} from "@omp-app/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { TOOL_RENDERERS } from "@/registry";
import {
  capabilityStatus,
  isDescriptorAvailable,
  UPSTREAM_UNAVAILABLE,
} from "@/registry-core/hooks";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { normalizeToolCall } from "../../U3/tool-card/normalize";
import { createToolRegistry } from "../../U3/tool-card/registry";
import { T7_TOOL_DESCRIPTORS } from "../descriptor";
import { T7_LIFECYCLE_FIXTURES, type T7LifecycleFixture } from "../fixtures/lifecycle";
import { T7_REAL_RESULTS } from "../fixtures/real-results";
import { T7_SOURCE_RESULTS } from "../fixtures/source-results";

afterEach(cleanup);

const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const T7_ROWS = [
  "T7.checkpoint",
  "T7.goal",
  "T7.host-custom-mcp-tool-fallback",
  "T7.reject",
  "T7.resolve",
  "T7.rewind",
  "T7.security-scan",
  "T7.think",
] as const;

const T7_CLAIMS: Readonly<
  Record<
    string,
    { readonly covers: readonly string[]; readonly requires: readonly CapabilityKey[] }
  >
> = {
  "T7.checkpoint": { covers: ["T7.checkpoint"], requires: [] },
  "T7.goal": { covers: ["T7.goal"], requires: ["upstream.goal"] },
  "T7.host-custom-mcp-tool-fallback": {
    covers: ["T7.host-custom-mcp-tool-fallback"],
    requires: [],
  },
  "T7.mcp": { covers: [], requires: [] },
  "T7.xdMcp": { covers: [], requires: [] },
  "T7.reject": { covers: ["T7.reject"], requires: [] },
  "T7.resolve": { covers: ["T7.resolve"], requires: [] },
  "T7.rewind": { covers: ["T7.rewind"], requires: ["host.checkpoints"] },
  "T7.securityScan": { covers: ["T7.security-scan"], requires: ["upstream.security-scan"] },
  "T7.think": { covers: ["T7.think"], requires: [] },
};

const PLACEHOLDERS = [
  "Scan details unavailable.",
  "Tool result unavailable.",
  "Details unavailable.",
  "No result available.",
] as const;

function descriptorOf(fixture: T7LifecycleFixture): (typeof T7_TOOL_DESCRIPTORS)[number] {
  const descriptor = T7_TOOL_DESCRIPTORS.find((item) => item.id === fixture.descriptor);
  if (descriptor === undefined) throw new Error(`No T7 descriptor ${fixture.descriptor}`);
  return descriptor;
}

function renderFixture(fixture: T7LifecycleFixture) {
  const Renderer = descriptorOf(fixture).renderer;
  const props = { type: "tool-call", ...fixture.input } as unknown as ToolRendererProps;
  return render(<Renderer {...props} />);
}

function openEveryFold(container: HTMLElement): void {
  for (let pass = 0; pass < 4; pass += 1) {
    for (const trigger of container.querySelectorAll('button[aria-expanded="false"]'))
      fireEvent.click(trigger);
  }
}

function expectDisclosuresLinked(container: HTMLElement): void {
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

function resultText(fixture: T7LifecycleFixture): string {
  const result = fixture.input.result;
  if (
    result === undefined ||
    typeof result !== "object" ||
    result === null ||
    !("content" in result)
  )
    return "";
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string"
        ? [part.text]
        : [],
    )
    .join("\n");
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

describe("T7 public descriptors and W4 coverage", () => {
  test("uses the literal covers/requires table and validates all eight T7 rows", () => {
    expect(validateRegistry(T7_TOOL_DESCRIPTORS)).toEqual([]);
    expect(
      INVENTORY.filter((row) => row.group === "T7")
        .map((row) => row.id)
        .sort(),
    ).toEqual([...T7_ROWS].sort());
    for (const descriptor of T7_TOOL_DESCRIPTORS) {
      const expected = T7_CLAIMS[descriptor.id];
      expect(expected, `${descriptor.id} is missing from the literal gate table`).toBeDefined();
      expect(descriptor.covers).toEqual(expected?.covers);
      expect(descriptor.requires).toEqual(expected?.requires);
    }
    const claimed = T7_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers);
    expect(T7_ROWS.every((row) => claimed.filter((item) => item === row).length === 1)).toBe(true);
  });

  test("central registry resolves exact, both MCP prefixes and the sole fallback", () => {
    const toolRegistry = createToolRegistry(TOOL_RENDERERS);
    expect(toolRegistry.resolve("mcp__sample_server_sample_tool").descriptor?.id).toBe("T7.mcp");
    expect(toolRegistry.resolve("xd__mcp__sample_server_sample_tool").descriptor?.id).toBe(
      "T7.xdMcp",
    );
    expect(toolRegistry.resolve("some_unregistered_tool").descriptor?.id).toBe(
      "T7.host-custom-mcp-tool-fallback",
    );
    expect(TOOL_RENDERERS.filter((descriptor) => descriptor.match.by === "fallback")).toHaveLength(
      1,
    );
  });

  test("capability hooks mark required descriptors unavailable while keeping recorded history resolvable", () => {
    const empty: CapabilityMap = {};
    for (const descriptor of T7_TOOL_DESCRIPTORS) {
      const required = T7_CLAIMS[descriptor.id]?.requires ?? [];
      expect(isDescriptorAvailable(descriptor as unknown as Descriptor, empty)).toBe(
        required.length === 0,
      );
      for (const key of required) {
        const status = capabilityStatus(empty, key);
        if (key.startsWith("upstream.")) expect(status).toEqual(UPSTREAM_UNAVAILABLE);
        else expect(status).toBeUndefined();
      }
    }
    const registryTool = createToolRegistry(TOOL_RENDERERS);
    expect(registryTool.resolve("goal", empty).available).toBe(false);
    expect(registryTool.resolve("security_scan", empty).available).toBe(false);
    const recorded = T7_LIFECYCLE_FIXTURES.find(
      (fixture) => fixture.basis === "recorded" && fixture.expect.phase === "success",
    );
    if (recorded === undefined) throw new Error("No recorded T7 success fixture");
    const { container } = renderFixture(recorded);
    openEveryFold(container);
    for (const fact of recorded.shows) expect(visibleText(container)).toContain(fact);
  });

  for (const descriptor of T7_TOOL_DESCRIPTORS) {
    test(`${descriptor.id} has every lifecycle state and a real large-result fixture`, () => {
      const fixtures = T7_LIFECYCLE_FIXTURES.filter(
        (fixture) => fixture.descriptor === descriptor.id,
      );
      const states = new Set(fixtures.map((fixture) => fixture.name.split(":")[0]));
      for (const state of ["running", "partial", "cancelled", "success", "error"])
        expect(states.has(state), `${descriptor.id} lacks ${state}`).toBe(true);
      const large = fixtures.find(
        (fixture) =>
          fixture.size === "large" &&
          (fixture.expect.phase === "success" || fixture.expect.phase === "error") &&
          resultText(fixture).split("\n").length >= 24,
      );
      expect(large, `${descriptor.id} lacks a genuinely large settled result`).toBeDefined();
    });
  }

  for (const fixture of T7_LIFECYCLE_FIXTURES) {
    test(`normalizes ${fixture.name} and preserves its call id`, () => {
      const state = normalizeToolCall(fixture.input);
      expect(state).toMatchObject(fixture.expect);
      expect(state.toolCallId).toBe(fixture.input.toolCallId);
      if (fixture.input.argsText !== undefined) expect(state.argsText).toBe(fixture.input.argsText);
    });

    test(`renders ${fixture.name} with the shared card grammar and facts`, () => {
      const { container } = renderFixture(fixture);
      const card = container.querySelector("[data-slot='u3-tool-card']");
      expect(card?.getAttribute("data-phase")).toBe(fixture.expect.phase);
      expect(container.querySelector("button[aria-expanded][aria-controls]")).toBeTruthy();
      openEveryFold(container);
      expectDisclosuresLinked(container);
      if (fixture.expect.phase === "success" || fixture.expect.phase === "error") {
        const text = visibleText(container);
        for (const fact of fixture.shows) expect(text).toContain(fact.replace(/\s+/g, " "));
        for (const placeholder of PLACEHOLDERS) expect(text).not.toContain(placeholder);
      }
    });
  }

  test("two calls of different tools in one tree each show only their own facts and keep distinct disclosure ids", () => {
    const pick = (needle: string): T7LifecycleFixture => {
      const found = T7_LIFECYCLE_FIXTURES.find(
        (item) => item.name.endsWith(needle) && item.expect.phase === "success",
      );
      if (found === undefined) throw new Error(`No T7 fixture ends with: ${needle}`);
      return found;
    };
    const first = pick("checkpoint: builder result envelope");
    const second = pick("security_scan: completed operation");
    const propsOf = (fixture: T7LifecycleFixture) =>
      ({ type: "tool-call", ...fixture.input }) as unknown as ToolRendererProps;
    const First = descriptorOf(first).renderer;
    const Second = descriptorOf(second).renderer;
    const { container } = render(
      <>
        <div data-case="first">
          <First {...propsOf(first)} />
        </div>
        <div data-case="second">
          <Second {...propsOf(second)} />
        </div>
      </>,
    );
    openEveryFold(container);
    const textOf = (id: string) =>
      visibleText(container.querySelector(`[data-case='${id}']`) as HTMLElement);
    for (const fact of first.shows) expect(textOf("first")).toContain(fact);
    for (const fact of second.shows) expect(textOf("second")).toContain(fact);
    expect(textOf("first")).not.toContain("0 findings");
    expect(textOf("second")).not.toContain("Scrubbed checkpoint goal");
    const controls = [...container.querySelectorAll("button[aria-controls]")].map((button) =>
      button.getAttribute("aria-controls"),
    );
    expect(controls.length).toBeGreaterThan(1);
    expect(new Set(controls).size).toBe(controls.length);
  });

  test("large fallback output folds 24 lines to a bounded preview", () => {
    const fixture = T7_LIFECYCLE_FIXTURES.find(
      (item) =>
        item.name.includes("custom fallback large result") && item.expect.phase === "success",
    );
    if (fixture === undefined) throw new Error("No large fallback fixture");
    const { container } = renderFixture(fixture);
    openEveryFold(container);
    expect(container.querySelector("[data-u3-show-all]")?.textContent).toContain(
      "Show all 24 lines",
    );
    expect(
      container.querySelector("[data-slot='u3-text-output'] pre")?.textContent?.split("\n"),
    ).toHaveLength(16);
  });

  test("private think fixtures never expose thought text", () => {
    const fixture = T7_LIFECYCLE_FIXTURES.find(
      (item) => item.name.includes("private acknowledgment") && item.expect.phase === "success",
    );
    if (fixture === undefined) throw new Error("No private think fixture");
    const { container } = renderFixture(fixture);
    openEveryFold(container);
    expect(visibleText(container)).not.toContain("Scrubbed private thought");
  });

  test("scripted and recorded results retain the omp envelope", () => {
    for (const sample of [...T7_REAL_RESULTS, ...T7_SOURCE_RESULTS]) {
      expect(sample.result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.any(String) }),
      ]);
      expect(sample.result.details === undefined || typeof sample.result.details === "object").toBe(
        true,
      );
    }
    expect(T7_SOURCE_RESULTS.every((sample) => sample.name.startsWith("[scripted]"))).toBe(true);
  });
});

describe("T7 safety boundary", () => {
  test("does not import another tool module, registry, filesystem, network or process APIs", () => {
    for (const file of sourceFiles()) {
      const imports = [
        ...file.text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g),
      ].map((match) => match[1] ?? "");
      for (const specifier of imports) {
        expect(specifier, `${file.name} imports ${specifier}`).not.toMatch(
          /(^|\/)T[1-6](\/|$)|registry/,
        );
      }
      expect(
        file.text.match(
          /\bfetch\s*\(|child_process|Bun\.spawn|Bun\.file|Bun\.write|node:fs|(?:from|import|require)\s*\(?\s*["'](?:fs|fs\/promises)["']|readFile\(|XMLHttpRequest|new WebSocket\(/,
        )?.[0] ?? null,
      ).toBeNull();
    }
  });
});
