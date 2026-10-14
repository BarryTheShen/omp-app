import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import type { ToolRendererProps } from "../U3/tool-card/contract";
import type { RealToolResult } from "../U3/tool-card/real-result";
import { T5_TOOL_DESCRIPTORS } from "./descriptor";
import { T5_VIBE_SOURCE_RESULTS } from "./fixtures/vibe-source-results";
import { VibeKillRenderer, VibeListRenderer, VibeSendRenderer, VibeWaitRenderer } from "./vibe";

afterEach(cleanup);

const RENDERERS = {
  vibe_send: VibeSendRenderer,
  vibe_list: VibeListRenderer,
  vibe_wait: VibeWaitRenderer,
  vibe_kill: VibeKillRenderer,
} as const;

/** The props a card gets for one source-derived call, as a transcript passes them. */
function propsFor(sample: RealToolResult): ToolRendererProps {
  return {
    type: "tool-call",
    toolCallId: `t5-vibe-${sample.name}`,
    toolName: sample.toolName,
    args: sample.args,
    argsText: JSON.stringify(sample.args),
    result: sample.result,
    isError: sample.isError,
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

/** The same props with omp's status replaced, as a transcript passes a call that is still running or was cut off. */
function withStatus(props: ToolRendererProps, status: unknown): ToolRendererProps {
  return { ...props, status } as unknown as ToolRendererProps;
}

function sampleNamed(prefix: string): RealToolResult {
  const sample = T5_VIBE_SOURCE_RESULTS.find((item) => item.name.startsWith(prefix));
  if (sample === undefined) throw new Error(`No source-derived vibe sample named "${prefix}".`);
  return sample;
}

function rendererFor(sample: RealToolResult) {
  const renderer = RENDERERS[sample.toolName as keyof typeof RENDERERS];
  if (renderer === undefined) throw new Error(`No vibe card for ${sample.toolName}.`);
  return renderer;
}

describe("vibe cards show what omp returned", () => {
  test.each(T5_VIBE_SOURCE_RESULTS.map((sample) => [sample.name, sample] as const))(
    "%s",
    (_name, sample) => {
      const Renderer = rendererFor(sample);
      const { container } = render(<Renderer {...propsFor(sample)} />);
      expandToolCards();
      for (const text of sample.shows) expect(container.textContent).toContain(text);
    },
  );

  test("no card has a control that sends, steers, kills, cancels or waits", () => {
    for (const sample of T5_VIBE_SOURCE_RESULTS) {
      const Renderer = rendererFor(sample);
      const { unmount } = render(<Renderer {...propsFor(sample)} />);
      expandToolCards();
      // The card's own disclosure button is U3's, and its name carries the tool's verb; only other buttons are controls.
      const controls = screen
        .queryAllByRole("button", { name: /send|steer|kill|cancel|wait|stop/i })
        .filter((button) => button.getAttribute("data-slot") !== "u3-tool-card-trigger");
      expect(controls).toHaveLength(0);
      unmount();
    }
  });

  test("a wait that ran out says so, and lists no settled turn", () => {
    const { container } = render(
      <VibeWaitRenderer {...propsFor(sampleNamed("vibe_wait: the wait ran out"))} />,
    );
    expandToolCards();
    expect(screen.getByRole("status").textContent).toBe(
      "No turn settled before the wait ran out. Wait again to keep waiting.",
    );
    expect(container.querySelector('[data-slot="t5-vibe-settled"]')).toBeNull();
  });

  test("a killed worker is named once, by id, and never shown as a live row", () => {
    const { container } = render(
      <VibeListRenderer {...propsFor(sampleNamed("vibe_list: live workers"))} />,
    );
    expandToolCards();
    expect(screen.getByTestId("t5-vibe-screen-fast-1")).toBeTruthy();
    expect(screen.queryByTestId("t5-vibe-screen-fast-3")).toBeNull();
    expect(container.textContent).toContain("Killed (1): fast-3");
  });

  test("a worker's trace and output show their last lines, and say how many they leave out", () => {
    const sample = sampleNamed("vibe_list: live workers");
    const busy = structuredClone(sample);
    const details = busy.result.details as { screens: { trace: string[] }[] };
    details.screens[0] = {
      ...details.screens[0],
      trace: ["read: a.ts", "read: b.ts", "read: c.ts", "read: d.ts", "read: e.ts", "read: f.ts"],
    } as (typeof details.screens)[number];
    const { container } = render(<VibeListRenderer {...propsFor(busy)} />);
    expandToolCards();
    expect(screen.getByText("Tool calls (last 4 of 6)")).toBeTruthy();
    expect(container.textContent).not.toContain("read: a.ts");
    expect(container.textContent).toContain("read: c.ts\nread: d.ts\nread: e.ts\nread: f.ts");
  });

  test("a wait that is still running says so while omp streams its progress", () => {
    const sample = sampleNamed("vibe_wait: no turn in flight");
    const progress = {
      ...propsFor(sample),
      status: { type: "running" },
      result: {
        content: [{ type: "text", text: "" }],
        details: {
          op: "wait",
          screens: [],
          wait: { settled: [], stillRunning: ["good-2"], timedOut: false, waiting: true },
        },
      },
    } as unknown as ToolRendererProps;
    render(<VibeWaitRenderer {...progress} />);
    expandToolCards();
    expect(screen.getByText("Waiting for worker turns")).toBeTruthy();
    expect(screen.getByText("Waiting for worker turns to settle.")).toBeTruthy();
  });

  test("a malformed value in omp's details shows a visible error and no guessed worker list", () => {
    const sample = sampleNamed("vibe_list: live workers");
    const broken = structuredClone(sample);
    (broken.result.details as Record<string, unknown>).hiddenKilled = true;
    render(<VibeListRenderer {...propsFor(broken)} />);
    expandToolCards();
    expect(screen.getByText("Worker details were malformed; raw output is retained.")).toBeTruthy();
    expect(screen.queryByTestId("t5-vibe-screen-fast-1")).toBeNull();
  });

  test("an interrupted wait says it stopped waiting, and shows omp's words once", () => {
    render(<VibeWaitRenderer {...propsFor(sampleNamed("vibe_wait: interrupted by a message"))} />);
    expandToolCards();
    expect(screen.getByText("Stopped waiting; 1 worker still running")).toBeTruthy();
    expect(screen.getByTestId("t5-vibe-wait-text").textContent).toContain(
      "Still running: `good-2`.",
    );
    expect(screen.queryByText("Still running:")).toBeNull();
  });

  test("a call still running names what it is doing, and a cut-off call says Cancelled", () => {
    const cases = [
      [VibeSendRenderer, sampleNamed("vibe_send: a new turn"), "Sending the message"],
      [
        VibeKillRenderer,
        sampleNamed("vibe_kill: a worker whose turn was cancelled"),
        "Stopping worker fast-1",
      ],
      [VibeListRenderer, sampleNamed("vibe_list: live workers"), "Listing workers"],
    ] as const;
    for (const [Renderer, sample, pending] of cases) {
      const running = render(
        <Renderer
          {...withStatus({ ...propsFor(sample), result: undefined }, { type: "running" })}
        />,
      );
      expandToolCards();
      expect(screen.getByText(pending)).toBeTruthy();
      running.unmount();
      const cut = render(
        <Renderer {...withStatus(propsFor(sample), { type: "incomplete", reason: "cancelled" })} />,
      );
      expandToolCards();
      expect(screen.getAllByText("Cancelled").length).toBeGreaterThan(0);
      cut.unmount();
    }
  });
});

describe("the vibe tools are bound to their cards", () => {
  test.each([
    ["vibe_send", VibeSendRenderer],
    ["vibe_list", VibeListRenderer],
    ["vibe_wait", VibeWaitRenderer],
    ["vibe_kill", VibeKillRenderer],
  ] as const)("%s renders through its own card", (name, renderer) => {
    const descriptor = T5_TOOL_DESCRIPTORS.find(
      (item) => "name" in item.match && item.match.name === name,
    );
    expect(descriptor?.renderer).toBe(renderer);
  });
});
