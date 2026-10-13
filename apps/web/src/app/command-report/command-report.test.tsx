import { ThreadId } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { LayoutArea } from "@/layout";
import { type CommandReport, useCommandReport } from "./command-report";

afterEach(cleanup);

const threadA = ThreadId.parse("thread-command-a");
const threadB = ThreadId.parse("thread-command-b");

interface Probe {
  readonly show: (report: CommandReport) => void;
}

/** Mounts the hook and the right sidebar's panels the way the app does, and hands the test the hook's `show`. */
function Harness({
  threadId,
  probe,
}: {
  readonly threadId: ThreadId;
  readonly probe: { current: Probe | null };
}) {
  const { show, surface } = useCommandReport({ threadId });
  probe.current = { show };
  return (
    <>
      <textarea aria-label="Message input" />
      <LayoutArea area="panels" surfaces={{ commandOutput: surface }} />
    </>
  );
}

function reportPanel() {
  return screen.queryByRole("region", { name: "Command output" });
}

describe("D2.3 command output panel", () => {
  test("the report is listed only while it is open, and only in the chat its command ran in", () => {
    const probe: { current: Probe | null } = { current: null };
    const { rerender } = render(<Harness probe={probe} threadId={threadA} />);
    expect(reportPanel()).toBeNull();

    act(() => probe.current?.show({ command: "/tools", text: "read\nbash" }));
    expect(reportPanel()).not.toBeNull();

    rerender(<Harness probe={probe} threadId={threadB} />);
    expect(reportPanel()).toBeNull();

    rerender(<Harness probe={probe} threadId={threadA} />);
    expect(reportPanel()).not.toBeNull();
  });

  test("every line of the report is shown in order, in one block that keeps the line breaks", () => {
    const probe: { current: Probe | null } = { current: null };
    render(<Harness probe={probe} threadId={threadA} />);

    act(() =>
      probe.current?.show({
        command: "/tools",
        text: "Tools (3 active)\n  read\n  bash\n  edit",
      }),
    );

    const block = reportPanel()?.querySelector("pre");
    expect(block?.textContent).toBe("Tools (3 active)\n  read\n  bash\n  edit");
    expect(reportPanel()?.textContent).toContain("/tools");
  });

  test("the close button closes the report and returns focus to the composer", () => {
    const probe: { current: Probe | null } = { current: null };
    render(<Harness probe={probe} threadId={threadA} />);
    act(() => probe.current?.show({ command: "/tools", text: "read\nbash" }));

    fireEvent.click(screen.getByRole("button", { name: "Close Command output" }));

    expect(reportPanel()).toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('textarea[aria-label="Message input"]'),
    );
  });

  test("Escape closes the report, and a new report replaces the one before it", () => {
    const probe: { current: Probe | null } = { current: null };
    render(<Harness probe={probe} threadId={threadA} />);
    act(() => probe.current?.show({ command: "/tools", text: "read\nbash" }));
    act(() => probe.current?.show({ command: "/mcp list", text: "one\ntwo" }));

    expect(reportPanel()?.textContent).toContain("/mcp list");
    expect(reportPanel()?.textContent).not.toContain("/tools");

    fireEvent.keyDown(screen.getByRole("region", { name: "Command output" }), { key: "Escape" });
    expect(reportPanel()).toBeNull();
  });
});
