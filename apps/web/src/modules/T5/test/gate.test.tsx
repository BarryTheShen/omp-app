import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CapabilityStatus, INVENTORY, validateRegistry } from "@omp-app/contracts";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { DESCRIPTORS, TOOL_RENDERERS } from "../../../registry";
import { createRegistry } from "../../../registry-core/create-registry";
import {
  capabilityStatus,
  isDescriptorAvailable,
  UPSTREAM_UNAVAILABLE,
} from "../../../registry-core/hooks";
import type { ToolRendererProps } from "../../U3/tool-card/contract";
import { normalizeToolCall } from "../../U3/tool-card/normalize";
import { T5_TOOL_DESCRIPTORS } from "../descriptor";
import { T5_LIFECYCLE_FIXTURES, type T5LifecycleFixture } from "../fixtures/lifecycle";
import { T5_REAL_RESULTS } from "../fixtures/real-results";
import { T5_VIBE_REAL_RESULTS } from "../fixtures/vibe-real-results";
import { T5_VIBE_SOURCE_RESULTS } from "../fixtures/vibe-source-results";
import { TaskSubagentsContext } from "../task";

afterEach(cleanup);

const MODULE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const PLACEHOLDERS = ["Unable to render", "Malformed", "undefined", "NaN", "[object Object]"];

const T5_DESCRIPTOR_TABLE = [
  ["T5.hub", ["T5.hub"], { by: "name", name: "hub" }],
  ["T5.task", ["T5.task", "P1.task-subagent-card"], { by: "name", name: "task" }],
  ["T5.vibeKill", ["T5.vibe-kill"], { by: "name", name: "vibe_kill" }],
  ["T5.vibeList", ["T5.vibe-list"], { by: "name", name: "vibe_list" }],
  ["T5.vibeSend", ["T5.vibe-send"], { by: "name", name: "vibe_send" }],
  ["T5.vibeSpawn", ["T5.vibe-spawn"], { by: "name", name: "vibe_spawn" }],
  ["T5.vibeWait", ["T5.vibe-wait"], { by: "name", name: "vibe_wait" }],
  ["T5.yield", ["T5.yield"], { by: "name", name: "yield" }],
  ["T5.wait", ["T5.wait"], { by: "name", name: "wait" }],
] as const;

function descriptorOf(fixture: T5LifecycleFixture) {
  const descriptor = T5_TOOL_DESCRIPTORS.find((item) => item.id === fixture.descriptor);
  if (descriptor === undefined) throw new Error(`No T5 descriptor ${fixture.descriptor}`);
  return descriptor;
}

function renderFixture(fixture: T5LifecycleFixture) {
  const Renderer = descriptorOf(fixture).renderer;
  const props = { type: "tool-call", ...fixture.input } as unknown as ToolRendererProps;
  return render(<Renderer {...props} />);
}

function openEveryFold(container: HTMLElement) {
  for (let pass = 0; pass < 4; pass += 1) {
    for (const trigger of container.querySelectorAll('button[aria-expanded="false"]'))
      fireEvent.click(trigger);
    for (const trigger of container.querySelectorAll("button[data-u3-show-all]"))
      fireEvent.click(trigger);
    for (const detail of container.querySelectorAll("details")) {
      if (detail instanceof HTMLDetailsElement) detail.open = true;
    }
  }
}

function expectDisclosuresLinked(container: HTMLElement) {
  const triggers = container.querySelectorAll("button[aria-expanded][aria-controls]");
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
  return (container.textContent ?? "").replace(/\s+/g, " ");
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

describe("T5 public descriptors and W4/CC8 coverage", () => {
  test("validates the literal covers, match and requires table", () => {
    expect(validateRegistry(T5_TOOL_DESCRIPTORS)).toEqual([]);
    expect(T5_TOOL_DESCRIPTORS).toHaveLength(T5_DESCRIPTOR_TABLE.length);
    for (const [id, covers, match] of T5_DESCRIPTOR_TABLE) {
      const descriptor = T5_TOOL_DESCRIPTORS.find((item) => item.id === id);
      expect(descriptor?.covers).toEqual(covers);
      expect(descriptor?.match).toEqual(match);
      expect(descriptor?.requires).toEqual([]);
    }
    const rows = INVENTORY.filter((row) => row.group === "T5").map((row) => row.id);
    expect(rows).toHaveLength(9);
    expect(
      T5_TOOL_DESCRIPTORS.flatMap((descriptor) => descriptor.covers)
        .filter((id) => id.startsWith("T5."))
        .sort(),
    ).toEqual([...rows].sort());
  });

  test("the central registry composes every T5 descriptor and the sole P1 task-row claim", () => {
    const composed = createRegistry(DESCRIPTORS);
    const t5 = composed.descriptors.filter((descriptor) => descriptor.id.startsWith("T5."));
    expect(t5.map((descriptor) => descriptor.id)).toEqual(
      T5_TOOL_DESCRIPTORS.map((descriptor) => descriptor.id),
    );
    expect(t5.flatMap((descriptor) => descriptor.covers)).toContain("P1.task-subagent-card");
    expect(TOOL_RENDERERS.filter((descriptor) => descriptor.owner === "T5")).toHaveLength(9);
  });

  test("descriptor availability uses the registry capability helpers and upstream reason", () => {
    const task = T5_TOOL_DESCRIPTORS.find((descriptor) => descriptor.id === "T5.task");
    if (task === undefined) throw new Error("No task descriptor");
    const gated = { ...task, requires: ["omp.subagent-events" as const] };
    expect(isDescriptorAvailable(gated, {})).toBe(false);
    expect(
      isDescriptorAvailable(gated, {
        "omp.subagent-events": CapabilityStatus.parse({ state: "available", via: "omp" }),
      }),
    ).toBe(true);
    expect(capabilityStatus({}, "upstream.t5")).toEqual(UPSTREAM_UNAVAILABLE);
  });

  for (const descriptor of T5_TOOL_DESCRIPTORS) {
    test(`${descriptor.id} has every lifecycle state and a genuinely large fixture`, () => {
      const fixtures = T5_LIFECYCLE_FIXTURES.filter(
        (fixture) => fixture.descriptor === descriptor.id,
      );
      const states = new Set(fixtures.map((fixture) => fixture.name.split(":")[0]));
      for (const state of ["running", "partial", "cancelled", "success", "error"])
        expect(states.has(state)).toBe(true);
      expect(
        fixtures.some((fixture) => fixture.size === "large" && fixture.basis === "scripted"),
      ).toBe(true);
    });
  }

  for (const fixture of T5_LIFECYCLE_FIXTURES) {
    test(`normalizes ${fixture.name} and preserves identity`, () => {
      const state = normalizeToolCall(fixture.input);
      expect(state).toMatchObject(fixture.expect);
      expect(state.toolCallId).toBe(fixture.input.toolCallId);
      expect(state.argsText).toBe(fixture.input.argsText);
    });
  }

  for (const fixture of T5_LIFECYCLE_FIXTURES) {
    test(`renders ${fixture.name} with its phase, facts and linked disclosures`, () => {
      const { container } = renderFixture(fixture);
      expect(
        container.querySelector("[data-slot='u3-tool-card']")?.getAttribute("data-phase"),
      ).toBe(fixture.expect.phase);
      openEveryFold(container);
      expectDisclosuresLinked(container);
      if (fixture.expect.phase === "success" || fixture.expect.phase === "error") {
        const text = visibleText(container);
        for (const fact of fixture.shows) expect(text).toContain(fact);
        for (const placeholder of PLACEHOLDERS) expect(text).not.toContain(placeholder);
      }
    });
  }

  test("the recorded 26-row log is folded to 16 lines and offers all 26", () => {
    const fixture = T5_LIFECYCLE_FIXTURES.find(
      (item) =>
        item.name.includes("hub: the log of a service that is ready") &&
        item.expect.phase === "success",
    );
    if (fixture === undefined) throw new Error("No recorded large hub log fixture");
    const { container } = renderFixture(fixture);
    expect(container.querySelector("[data-u3-show-all]")?.textContent).toContain(
      "Show all 26 lines",
    );
    expect(
      container.querySelector("[data-testid='t5-hub-log-text']")?.textContent?.split("\n"),
    ).toHaveLength(16);
  });

  test("an empty nested task card shows no worker controls", () => {
    const fixture = T5_LIFECYCLE_FIXTURES.find(
      (item) => item.name.includes("empty: task") && item.expect.phase === "success",
    );
    if (fixture === undefined) throw new Error("No empty task fixture");
    const Renderer = descriptorOf(fixture).renderer;
    const props = {
      type: "tool-call",
      ...fixture.input,
      nested: { depth: 1, messages: [] },
    } as unknown as ToolRendererProps;
    const { container } = render(
      <TaskSubagentsContext.Provider value={() => []}>
        <Renderer {...props} />
      </TaskSubagentsContext.Provider>,
    );
    expect(visibleText(container)).toContain("No agents reported");
    expect(container.querySelector('button[aria-label*="Stop" i]')).toBeNull();
    expect(container.querySelector("input,textarea")).toBeNull();
  });

  test("a populated nested task card renders its recorded worker without controls", () => {
    const fixture = T5_LIFECYCLE_FIXTURES.find(
      (item) =>
        item.name.includes("task: one agent started in the background") &&
        item.expect.phase === "success",
    );
    if (fixture === undefined) throw new Error("No populated task fixture");
    const Renderer = descriptorOf(fixture).renderer;
    const props = {
      type: "tool-call",
      ...fixture.input,
      nested: { depth: 1, messages: [] },
    } as unknown as ToolRendererProps;
    const { container } = render(
      <TaskSubagentsContext.Provider value={() => []}>
        <Renderer {...props} />
      </TaskSubagentsContext.Provider>,
    );
    const text = visibleText(container);
    expect(text).toContain("Running · 1 agent");
    expect(text).toContain("BuilderTwo");
    expect(text).toContain("Pending");
    expect(container.querySelector('button[aria-label*="Stop" i]')).toBeNull();
    expect(container.querySelector("input,textarea")).toBeNull();
  });
  test("two calls of different tools in one tree each show only their own facts and keep distinct disclosure ids", () => {
    const pick = (needle: string): T5LifecycleFixture => {
      const found = T5_LIFECYCLE_FIXTURES.find(
        (item) =>
          item.name.endsWith(needle) &&
          (item.expect.phase === "success" || item.expect.phase === "error"),
      );
      if (found === undefined) throw new Error(`No T5 fixture ends with: ${needle}`);
      return found;
    };
    const first = pick("wait: a task that failed, with its error");
    const second = pick("hub: a message delivered to one peer");
    const propsOf = (fixture: T5LifecycleFixture) =>
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
    expect(textOf("first")).not.toContain("WriterOne");
    expect(textOf("second")).not.toContain("ScoutThree");
    const controls = [...container.querySelectorAll("button[aria-controls]")].map((button) =>
      button.getAttribute("aria-controls"),
    );
    expect(controls.length).toBeGreaterThan(1);
    expect(new Set(controls).size).toBe(controls.length);
  });

  test("recorded and named scripted samples preserve the real result envelope", () => {
    for (const sample of [...T5_REAL_RESULTS, ...T5_VIBE_REAL_RESULTS, ...T5_VIBE_SOURCE_RESULTS]) {
      expect(sample.result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.any(String) }),
      ]);
      expect(sample.result.details === undefined || typeof sample.result.details === "object").toBe(
        true,
      );
    }
  });
});

describe("T5 safety boundary", () => {
  test("does not import another tool module, registry, filesystem, network or process APIs", () => {
    for (const file of sourceFiles()) {
      const imports = [
        ...file.text.matchAll(/(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g),
      ].map((match) => match[1] ?? "");
      for (const specifier of imports)
        expect(specifier, `${file.name} imports ${specifier}`).not.toMatch(
          /(^|\/)T(?:[1-4]|[67])(\/|$)|registry/,
        );
      expect(
        file.text.match(
          /\bfetch\s*\(|child_process|Bun\.spawn|Bun\.file|Bun\.write|node:fs|(?:from|import|require)\s*\(?\s*["'](?:fs|fs\/promises)["']|XMLHttpRequest|new WebSocket\(/u,
        )?.[0] ?? null,
      ).toBeNull();
    }
  });
});
