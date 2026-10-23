import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect, useRef, useState } from "react";
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

/** Moves focus into the message box in the commit that ends the scope's trap, before the scope gives focus back. */
function MoveFocusOut({ open }: { readonly open: boolean }) {
  const wasOpen = useRef(false);
  useLayoutEffect(() => {
    if (wasOpen.current && !open) document.getElementById("message")?.focus();
    wasOpen.current = open;
  }, [open]);
  return null;
}

/** A reopenable scope that its own button closes, while the focus goes to a message box outside it. */
function MovingHarness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button id="opener" type="button" onClick={() => setOpen(true)}>
        Open scope
      </button>
      <textarea id="message" aria-label="Message box" />
      <MoveFocusOut open={open} />
      <FocusScope reopenable restoreFocus={() => document.getElementById("opener")} trapped={open}>
        <button type="button" onClick={() => setOpen(false)}>
          Close scope
        </button>
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

  test("leaves focus that moved outside it on purpose where it went", () => {
    render(<MovingHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Open scope" }));
    fireEvent.click(screen.getByRole("button", { name: "Close scope" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message box" }));
  });
});
