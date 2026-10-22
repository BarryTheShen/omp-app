import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { FocusScope } from "./focus-scope";

afterEach(() => {
  cleanup();
});

/** A reopenable scope opened and closed by a button outside it, as an in-place drawer is. */
function ReopenableHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="opener" type="button" onClick={() => setOpen((value) => !value)}>
        Open scope
      </button>
      <FocusScope reopenable restoreFocus={() => document.getElementById("opener")} trapped={open}>
        <button type="button">First control</button>
        <button type="button">Last control</button>
      </FocusScope>
    </>
  );
}

describe("a reopenable FocusScope", () => {
  test("takes focus each time it is trapped, and gives focus back when it stops being trapped", () => {
    render(<ReopenableHarness />);
    const opener = screen.getByRole("button", { name: "Open scope" });
    const first = screen.getByRole("button", { name: "First control" });
    opener.focus();

    fireEvent.click(opener);
    expect(document.activeElement).toBe(first);

    fireEvent.click(opener);
    expect(document.activeElement).toBe(opener);

    fireEvent.click(opener);
    expect(document.activeElement).toBe(first);
  });

  test("takes no focus while it starts untrapped", () => {
    render(<ReopenableHarness />);
    const opener = screen.getByRole("button", { name: "Open scope" });
    opener.focus();
    expect(document.activeElement).toBe(opener);
  });
});
