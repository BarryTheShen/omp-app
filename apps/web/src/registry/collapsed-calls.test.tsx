import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import type { ToolRendererProps } from "../modules/U3/tool-card/contract";
import type { RealToolResult } from "../modules/U3/tool-card/real-result";
import { createToolRegistry } from "../modules/U3/tool-card/registry";
import { TOOL_RENDERERS } from "./index";
import { REAL_TOOL_RESULTS } from "./real-results";

afterEach(cleanup);

const registry = createToolRegistry(TOOL_RENDERERS);

/** A call's disclosure button: the one line it is, folded or open. */
const LINE = '[data-slot="u3-tool-card-trigger"]';

const collapse = (text: string) => text.replace(/\s+/g, " ");

/** The call as assistant-ui hands it to its renderer: finished with omp's result, or still running. */
function callProps(sample: RealToolResult, running: boolean): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: `${sample.name}-${running ? "running" : "finished"}`,
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
    result: running ? undefined : sample.result,
    isError: running ? false : sample.isError,
    status: running ? { type: "running" } : { type: "complete" },
    runActive: running,
  } as unknown as ToolRendererProps;
}

/** The text on screen: a folded card's body is not mounted, so only its line is in it. */
const onScreen = (container: HTMLElement) => collapse(container.textContent ?? "");

describe("every tool call starts as one line, running or finished", () => {
  test.each(REAL_TOOL_RESULTS)(
    "$name: folded at first, its line keeps the state chip",
    (sample) => {
      const Renderer = registry.resolve(sample.toolName).renderer;
      const { container } = render(<Renderer {...callProps(sample, false)} />);
      const line = container.querySelector<HTMLElement>(LINE);
      expect(line).not.toBeNull();
      expect(line?.tagName).toBe("BUTTON");
      expect(line?.getAttribute("aria-expanded")).toBe("false");

      // The chip sits on the line, so a failed call still says so while it is folded.
      const phase = sample.isError ? "error" : "success";
      expect(line?.querySelector(`[data-testid="tool-state-chip-${phase}"]`)).not.toBeNull();

      // Whatever the body shows is not on screen while the line is folded.
      const folded = onScreen(container);
      for (const wanted of sample.shows) {
        if (!(line?.textContent ?? "").includes(collapse(wanted))) {
          expect(folded).not.toContain(collapse(wanted));
        }
      }

      // A click opens the call, and then the body shows what omp returned.
      if (line === null) throw new Error(`${sample.name}: the card has no line`);
      fireEvent.click(line);
      expect(line.getAttribute("aria-expanded")).toBe("true");
      const opened = onScreen(container);
      for (const wanted of sample.shows) expect(opened).toContain(collapse(wanted));
    },
  );

  test.each(REAL_TOOL_RESULTS)(
    "$name: a call still running starts as one line too, and its line says Running",
    (sample) => {
      const Renderer = registry.resolve(sample.toolName).renderer;
      const { container } = render(<Renderer {...callProps(sample, true)} />);
      const line = container.querySelector<HTMLElement>(LINE);
      expect(line).not.toBeNull();
      expect(line?.getAttribute("aria-expanded")).toBe("false");
      expect(line?.querySelector('[data-testid="tool-state-chip-running"]')).not.toBeNull();
      expect(
        container.querySelector("[data-slot='u3-tool-card']")?.getAttribute("data-phase"),
      ).toBe("running");

      // Nothing opens by itself: a click on the running call's line opens it.
      if (line === null) throw new Error(`${sample.name}: the card has no line`);
      fireEvent.click(line);
      expect(line.getAttribute("aria-expanded")).toBe("true");
    },
  );
});
