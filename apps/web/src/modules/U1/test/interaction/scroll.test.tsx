import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useThreadScrollController } from "../../scroll";

function ScrollFixture() {
  const transcriptRootRef = useRef<HTMLDivElement | null>(null);
  const controller = useThreadScrollController(transcriptRootRef);
  return (
    <div ref={transcriptRootRef}>
      <button
        aria-label="Messages"
        data-slot="u1-thread-viewport"
        data-testid="viewport"
        type="button"
      >
        <span />
      </button>
      <output data-testid="is-at-bottom">{String(controller.isAtBottom)}</output>
      <button type="button" onClick={controller.followLatest}>
        Jump to latest
      </button>
      <button type="button" onClick={controller.jumpToLatest}>
        Message sent
      </button>
      <button type="button" onClick={() => controller.onAtBottomChange(false)}>
        The latest message is below
      </button>
      <button type="button" onClick={() => controller.onAtBottomChange(true)}>
        The latest message is here
      </button>
    </div>
  );
}

/** Gives the viewport a size and a recorder for scrolling: 1,000 px of content in 200 px. */
function sizedViewport() {
  const viewport = screen.getByTestId("viewport");
  const scrollTo = vi.fn();
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1_000 });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
  Object.defineProperty(viewport, "scrollTo", { configurable: true, value: scrollTo });
  return { viewport, scrollTo };
}

afterEach(() => cleanup());

describe("U1 scroll interaction policy", () => {
  test("mirrors assistant-ui's bottom state for anchor retention", () => {
    render(<ScrollFixture />);
    expect(screen.getByTestId("is-at-bottom").textContent).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "The latest message is below" }));
    expect(screen.getByTestId("is-at-bottom").textContent).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "The latest message is here" }));
    expect(screen.getByTestId("is-at-bottom").textContent).toBe("true");
  });

  test("Jump to latest scrolls to the bottom at once, never animated, and puts the focus on the transcript", () => {
    render(<ScrollFixture />);
    const { viewport, scrollTo } = sizedViewport();
    const jump = screen.getByRole("button", { name: "Jump to latest" });
    jump.focus();

    fireEvent.click(jump);

    // 1,000 px of content in a 200 px viewport: the bottom is at 800. "instant" is also what
    // reduced motion asks for, so one behavior serves everyone.
    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "instant" });
    expect(scrollTo).not.toHaveBeenCalledWith(expect.objectContaining({ behavior: "smooth" }));
    expect(document.activeElement).toBe(viewport);
  });

  test("sending a message scrolls to the newest message and leaves the focus where it was", () => {
    render(<ScrollFixture />);
    const { scrollTo } = sizedViewport();
    const send = screen.getByRole("button", { name: "Message sent" });
    send.focus();

    fireEvent.click(send);

    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: "instant" });
    expect(document.activeElement).toBe(send);
  });
});
