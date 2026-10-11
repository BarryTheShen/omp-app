import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  test("the bottom state is the viewport's: away while the reader is above the newest rows, at the bottom again when they return", () => {
    render(<ScrollFixture />);
    const { viewport, position } = layoutViewport();
    expect(screen.getByTestId("is-at-bottom").textContent).toBe("true");

    position.top = 300;
    fireEvent.scroll(viewport);
    expect(screen.getByTestId("is-at-bottom").textContent).toBe("false");

    position.top = 800;
    fireEvent.scroll(viewport);
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

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** The viewport's position as the browser keeps it, so a test moves it the way layout and the reader do. */
function layoutViewport() {
  const viewport = screen.getByTestId("viewport");
  const position = { top: 0 };
  const scrollTo = vi.fn((options: ScrollToOptions) => {
    // 1,000 px of content in a 200 px viewport: the browser stops at 800.
    position.top = Math.min(options.top ?? 0, 800);
  });
  Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1_000 });
  Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
  Object.defineProperty(viewport, "scrollTo", { configurable: true, value: scrollTo });
  Object.defineProperty(viewport, "scrollTop", {
    configurable: true,
    get: () => position.top,
    set: (value: number) => {
      position.top = value;
    },
  });
  return { viewport, scrollTo, position };
}

describe("U1 scroll follow after a send", () => {
  test("after a send, the transcript returns to the newest message when layout moves it away", async () => {
    render(<ScrollFixture />);
    const { viewport, scrollTo, position } = layoutViewport();
    fireEvent.click(screen.getByRole("button", { name: "Message sent" }));
    await waitFor(() => expect(position.top).toBe(800));
    // The jump's own scroll settles in a few frames; only the follow may move the viewport after that.
    await delay(100);

    // Something the reader did not do moves the viewport off the bottom: a row drawn later, an animation.
    position.top = 500;
    fireEvent.scroll(viewport);

    await waitFor(() => expect(position.top).toBe(800));
    expect(scrollTo).toHaveBeenLastCalledWith({ top: 800, behavior: "instant" });
  });

  test("the reader's wheel ends the follow: after it, the transcript stays where the reader scrolls", async () => {
    render(<ScrollFixture />);
    const { viewport, position } = layoutViewport();
    fireEvent.click(screen.getByRole("button", { name: "Message sent" }));
    await waitFor(() => expect(position.top).toBe(800));
    await delay(100);
    position.top = 500;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(position.top).toBe(800));

    fireEvent.wheel(viewport);
    position.top = 300; // the reader's own scroll
    fireEvent.scroll(viewport);

    await delay(50);
    expect(position.top).toBe(300);
  });

  test("typing in a text field inside the transcript does not end the follow", async () => {
    render(<ScrollFixture />);
    const { viewport, position } = layoutViewport();
    const field = document.createElement("textarea");
    viewport.append(field);
    fireEvent.click(screen.getByRole("button", { name: "Message sent" }));
    await waitFor(() => expect(position.top).toBe(800));
    await delay(100);

    fireEvent.keyDown(field, { key: "a" });
    position.top = 500;
    fireEvent.scroll(viewport);

    await waitFor(() => expect(position.top).toBe(800));
  });
});
