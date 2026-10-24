import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { expandToolCards } from "@/modules/U3/tool-card/test-support";
import { BashCard } from "./bash";
import type { ToolRendererProps } from "./contract";

afterEach(cleanup);

function props(result: unknown): ToolRendererProps {
  const args = { command: "printf 'Wall time: 3 seconds'" };
  return {
    type: "tool-call",
    toolCallId: "bash-1",
    toolName: "bash",
    args,
    argsText: JSON.stringify(args),
    result,
    status: { type: "complete" },
  } as unknown as ToolRendererProps;
}

describe("bash details as omp v18.12.6 builds them", () => {
  // `packages/coding-agent/src/tools/bash.ts:711-760`: omp adds the "Wall time: N seconds" footer to the text only when
  // the run took WALL_TIME_NOTICE_MIN_MS (1000 ms, `packages/tui/src/tools/bash.ts:216`), and records
  // `details.wallTimeNoticeEmitted` either way (:726, :746). Its own renderer strips the footer only when the flag is
  // not `false` (`packages/tui/src/tools/bash.ts:328-330`).
  test("a quick command's last line is its own output, not omp's footer, when wallTimeNoticeEmitted is false", () => {
    render(
      <BashCard
        rendererProps={props({
          content: [{ type: "text", text: "Wall time: 3 seconds" }],
          details: { wallTimeNoticeEmitted: false, timeoutSeconds: 300, wallTimeMs: 12.4 },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("u3-bash-stdout").querySelector("pre")?.textContent).toBe(
      "Wall time: 3 seconds",
    );
    expect(screen.getByText("Wall time: 12ms")).toBeTruthy();
  });

  test("a command that ran a second or more still has omp's footer taken off", () => {
    render(
      <BashCard
        rendererProps={props({
          content: [{ type: "text", text: "done\n\nWall time: 3.25 seconds" }],
          details: { wallTimeNoticeEmitted: true, timeoutSeconds: 300, wallTimeMs: 3250 },
        })}
      />,
    );
    expandToolCards();

    expect(screen.getByTestId("u3-bash-stdout").querySelector("pre")?.textContent).toBe("done");
  });
});
