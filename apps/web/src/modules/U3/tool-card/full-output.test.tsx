import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { FullOutputProvider, OutputCutNote } from "./full-output";

afterEach(() => cleanup());

const cut = { shownBytes: 65_536, totalBytes: 209_715 };

/** A load the test finishes by hand, so the test can look at the page while the output loads. */
function heldLoad() {
  const done = Promise.withResolvers<void>();
  const load = vi.fn(() => done.promise);
  return {
    load,
    finish: () => done.resolve(),
    fail: (message: string) => done.reject(new Error(message)),
  };
}

describe("OutputCutNote", () => {
  test("while the full output loads, its button keeps focus and says so, and a second press does nothing", async () => {
    const held = heldLoad();
    render(
      <FullOutputProvider value={held.load}>
        <OutputCutNote cut={cut} toolCallId="call-1" />
      </FullOutputProvider>,
    );
    const button = screen.getByRole("button", { name: "Load full output" });
    button.focus();
    fireEvent.click(button);

    const loading = screen.getByRole("button", { name: "Loading full output…" });
    expect(loading).toBe(button);
    expect(loading.hasAttribute("disabled")).toBe(false);
    expect(loading.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(held.load).toHaveBeenCalledTimes(1);

    await act(async () => held.finish());
  });

  test("when the full output has loaded, the card is told once", async () => {
    const held = heldLoad();
    const onLoaded = vi.fn();
    render(
      <FullOutputProvider value={held.load}>
        <OutputCutNote cut={cut} onLoaded={onLoaded} toolCallId="call-1" />
      </FullOutputProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    await act(async () => held.finish());

    expect(onLoaded).toHaveBeenCalledTimes(1);
  });

  test("a load that fails says why, the button works again, and the card is not told it loaded", async () => {
    const held = heldLoad();
    const onLoaded = vi.fn();
    render(
      <FullOutputProvider value={held.load}>
        <OutputCutNote cut={cut} onLoaded={onLoaded} toolCallId="call-1" />
      </FullOutputProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Load full output" }));
    await act(async () => held.fail("the connection dropped"));

    expect(screen.getByRole("alert").textContent).toBe("the connection dropped");
    const again = screen.getByRole("button", { name: "Load full output" });
    expect(again.getAttribute("aria-disabled")).toBe("false");
    expect(onLoaded).not.toHaveBeenCalled();
  });
});
