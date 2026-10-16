import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CollaborationPanel } from "../../collab";
import type { ParticipantState, ReadOnlySessionSnapshot } from "../../contract/contract";
import { createUnavailableCollaborationPort } from "../../contract/contract";

afterEach(() => cleanup());

const snapshot = createUnavailableCollaborationPort().readOnlySession.getSnapshot();
const participants: readonly ParticipantState[] = [
  { id: "host", displayName: "Ada", role: "host", presence: "active", readOnly: false },
  { id: "viewer", displayName: "Lin", role: "viewer", presence: "disconnected", readOnly: true },
];

function renderPanel(
  patch: Partial<{
    readonly open: boolean;
    readonly snapshot: ReadOnlySessionSnapshot;
  }> = {},
) {
  return render(
    <CollaborationPanel
      onOpenChange={vi.fn()}
      open={patch.open ?? true}
      snapshot={patch.snapshot ?? snapshot}
    />,
  );
}

describe("collaboration panel", () => {
  test("shows unsupported actions with one terminal-only reason", () => {
    renderPanel();
    expect(
      screen.getByText(
        "Every action is unavailable because omp only offers collaboration in its terminal.",
      ),
    ).toBeTruthy();

    for (const label of [
      "Host a session",
      "Create a view link",
      "Join a session",
      "Leave the session",
      "Stop sharing",
      "Copy sharing link",
    ]) {
      const control = screen.getByRole("button", { name: label });
      expect((control as HTMLButtonElement).disabled).toBe(true);
      expect(control.getAttribute("aria-describedby")).toBeTruthy();
    }
  });

  test("renders participant roles and presence without dimming read-only rows", () => {
    renderPanel({ snapshot: { ...snapshot, participants: [...participants] } });
    expect(screen.queryByText("Guest · Active")).toBeNull();
    expect(screen.getByText("Host · Active")).toBeTruthy();
    expect(screen.getByText("Viewer · Disconnected · Read-only")).toBeTruthy();
  });

  test("Escape and the close button restore focus to the opener", () => {
    function FocusHarness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button id="collaboration-opener" onClick={() => setOpen(true)} type="button">
            Open collaboration
          </button>
          <CollaborationPanel
            invokingFocus="collaboration-opener"
            onOpenChange={(next) => setOpen(next)}
            open={open}
            restoreFocus={(token) => document.getElementById(token)?.focus()}
            snapshot={snapshot}
          />
        </>
      );
    }

    render(<FocusHarness />);
    const opener = screen.getByRole("button", { name: "Open collaboration" });
    fireEvent.click(opener);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close Collaboration" }),
    );
    fireEvent.keyDown(screen.getByRole("region", { name: "Collaboration" }), { key: "Escape" });
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    fireEvent.click(screen.getByRole("button", { name: "Close Collaboration" }));
    expect(document.activeElement).toBe(opener);
  });

  test("passes the open state to PanelShell", () => {
    const { rerender } = render(
      <CollaborationPanel onOpenChange={vi.fn()} open snapshot={snapshot} />,
    );
    rerender(<CollaborationPanel onOpenChange={vi.fn()} open={false} snapshot={snapshot} />);
    expect(
      document.querySelector('[data-panel-open="false"]')?.getAttribute("data-panel-open"),
    ).toBe("false");
  });
});
