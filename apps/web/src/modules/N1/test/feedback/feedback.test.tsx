import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import { NotificationFeedback, NotificationNotices } from "../../feedback";
import { TOAST_LIFETIME_MS } from "../../feedback/notices";
import { NotificationProjector } from "../../notifications";

const threadId = ThreadIdSchema.parse("thread-n1-feedback");

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeProjector(): NotificationProjector {
  return new NotificationProjector({ source: new OmpRuntimeStore({ threadId }) });
}

function notify(
  projector: NotificationProjector,
  message: string,
  notifyType: "info" | "warning" | "error" = "info",
): void {
  act(() => {
    projector.present({ kind: "notify", message, notifyType }, { threadId });
  });
}

/**
 * The strip as the person sees it. The live region repeats each notice's text outside the strip for
 * screen readers, so every visible-text query is scoped here.
 */
function strip() {
  return within(screen.getByTestId("n1-feedback"));
}

function dismissButtons(): HTMLElement[] {
  return strip().getAllByRole("button", { name: "Dismiss notification" });
}

describe("NotificationFeedback", () => {
  test("renders projector notices, statuses and widgets", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);

    notify(projector, "Extension finished");
    act(() => {
      projector.present(
        { kind: "setStatus", statusKey: "build", statusText: "Running" },
        { threadId },
      );
      projector.present(
        { kind: "setWidget", widgetKey: "build", widgetLines: ["Building"] },
        { threadId },
      );
    });

    expect(strip().getByText("Extension finished")).toBeTruthy();
    expect(strip().getByText("Running")).toBeTruthy();
    expect(strip().getByText("Building")).toBeTruthy();
    expect(screen.getByTestId("n1-feedback").hidden).toBe(false);
    projector.dispose();
  });

  test("removes a widget when the handoff clears it", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);

    act(() => {
      projector.present(
        { kind: "setWidget", widgetKey: "build", widgetLines: ["Building"] },
        { threadId },
      );
    });
    expect(strip().getByText("Building")).toBeTruthy();

    act(() => {
      projector.present({ kind: "setWidget", widgetKey: "build" }, { threadId });
    });
    expect(strip().queryByText("Building")).toBeNull();
    projector.dispose();
  });

  test("shows the newest three toasts, counts the rest, and dismisses one on request", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);

    for (let index = 1; index <= 5; index += 1) notify(projector, `Update ${index}`);

    expect(strip().queryByText("Update 1")).toBeNull();
    expect(strip().queryByText("Update 2")).toBeNull();
    expect(strip().getByText("Update 3")).toBeTruthy();
    expect(strip().getByText("Update 5")).toBeTruthy();
    expect(screen.getByTestId("n1-feedback-more").textContent).toContain("+2 more");

    act(() => {
      dismissButtons()[2]?.click();
    });
    expect(strip().queryByText("Update 5")).toBeNull();
    expect(strip().getByText("Update 2")).toBeTruthy();
    expect(screen.getByTestId("n1-feedback-more").textContent).toContain("+1 more");
    projector.dispose();
  });

  test("keeps focus where it is while notices, statuses and widgets arrive", () => {
    const projector = makeProjector();
    render(
      <>
        <textarea aria-label="Message input" />
        <NotificationFeedback projector={projector} />
      </>,
    );
    const composer = screen.getByRole("textbox", { name: "Message input" });
    composer.focus();

    notify(projector, "Build finished");
    act(() => {
      projector.present(
        { kind: "setStatus", statusKey: "build", statusText: "Running" },
        { threadId },
      );
      projector.present(
        {
          kind: "setWidget",
          widgetKey: "build",
          widgetLines: ["Building"],
          widgetPlacement: "belowEditor",
        },
        { threadId },
      );
    });

    expect(strip().getByText("Build finished")).toBeTruthy();
    expect(document.activeElement).toBe(composer);
    projector.dispose();
  });

  test("dismissing a focused notice moves focus to the next one, not to the page", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);
    for (let index = 1; index <= 3; index += 1) notify(projector, `Update ${index}`);

    const first = dismissButtons()[0];
    first?.focus();
    if (first) fireEvent.click(first, { detail: 0 });

    expect(strip().queryByText("Update 1")).toBeNull();
    expect(document.activeElement?.closest("article")?.textContent).toContain("Update 2");
    projector.dispose();
  });

  test("Escape dismisses the focused notice and keeps focus among the others", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);
    for (let index = 1; index <= 3; index += 1) notify(projector, `Update ${index}`);

    const middle = strip().getByText("Update 2").closest("article");
    dismissButtons()[1]?.focus();
    act(() => {
      if (middle) fireEvent.keyDown(middle, { key: "Escape" });
    });

    expect(strip().queryByText("Update 2")).toBeNull();
    expect(document.activeElement?.closest("article")?.textContent).toContain("Update 3");
    projector.dispose();
  });

  test("the last notice dismissed from the keyboard returns focus to the composer, not to a control before the notices", () => {
    const projector = makeProjector();
    render(
      <>
        <button type="button">Before</button>
        <hr aria-label="Resize panels sidebar" tabIndex={0} />
        <NotificationFeedback projector={projector} />
        <textarea aria-label="Message input" />
      </>,
    );
    notify(projector, "Only one");
    const dismiss = dismissButtons()[0];
    dismiss?.focus();
    if (dismiss) fireEvent.click(dismiss, { detail: 0 });

    expect(strip().queryByText("Only one")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message input" }));
    projector.dispose();
  });

  test("+N more opens every notice in place and keeps focus on the control", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);
    for (let index = 1; index <= 5; index += 1) notify(projector, `Update ${index}`);

    const more = screen.getByTestId("n1-feedback-more");
    more.focus();
    act(() => {
      fireEvent.click(more);
    });

    expect(more.getAttribute("aria-expanded")).toBe("true");
    expect(more.textContent).toBe("Show fewer");
    expect(dismissButtons()).toHaveLength(5);
    expect(document.activeElement).toBe(more);
    projector.dispose();
  });

  test("a banner stays until it is dismissed, and a toast leaves after its lifetime", () => {
    vi.useFakeTimers();
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);

    notify(projector, "Tests passed");
    act(() => {
      projector.getBus().publish({
        threadId,
        dedupeKey: "retry:active",
        severity: "info",
        placement: "banner",
        message: "Retrying in 2 seconds",
        live: "polite",
        focus: "preserve",
      });
    });
    expect(strip().getByText("Tests passed")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(TOAST_LIFETIME_MS + 2000);
    });

    expect(strip().queryByText("Tests passed")).toBeNull();
    expect(strip().getByText("Retrying in 2 seconds")).toBeTruthy();
    projector.dispose();
  });

  test("the strip is hidden, not removed, when it has nothing to show", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);
    expect(screen.getByTestId("n1-feedback").hidden).toBe(true);

    notify(projector, "Now there is one");
    expect(screen.getByTestId("n1-feedback").hidden).toBe(false);
    projector.dispose();
  });
});

describe("a pointer dismissal does not hold the next notice", () => {
  test("focus goes to the browser after a click, so the remaining toast still leaves on its lifetime", () => {
    vi.useFakeTimers();
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);
    notify(projector, "Update 1");
    notify(projector, "Update 2");

    const second = dismissButtons()[1];
    second?.focus();
    if (second) fireEvent.click(second, { detail: 1 });

    expect(strip().queryByText("Update 2")).toBeNull();
    expect(document.activeElement).toBe(document.body);
    act(() => {
      vi.advanceTimersByTime(TOAST_LIFETIME_MS + 1000);
    });
    expect(strip().queryByText("Update 1")).toBeNull();
    projector.dispose();
  });
});

describe("notice stacks keep focus and pause on their own terms", () => {
  test("hovering and focusing are separate: a notice with focus stays after the pointer leaves", () => {
    vi.useFakeTimers();
    try {
      const projector = makeProjector();
      render(<NotificationFeedback projector={projector} />);
      notify(projector, "Hovered and focused");
      const article = strip().getByText("Hovered and focused").closest("article");
      const dismiss = strip().getByRole("button", { name: "Dismiss notification" });
      if (!article) throw new Error("the notice is not drawn");

      fireEvent.mouseEnter(article);
      act(() => {
        dismiss.focus();
      });
      fireEvent.mouseLeave(article);
      act(() => {
        vi.advanceTimersByTime(TOAST_LIFETIME_MS + 1000);
      });
      expect(strip().queryByText("Hovered and focused")).not.toBeNull();

      act(() => {
        dismiss.blur();
      });
      act(() => {
        vi.advanceTimersByTime(TOAST_LIFETIME_MS + 1000);
      });
      expect(strip().queryByText("Hovered and focused")).toBeNull();
      projector.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("when the stack empties with focus in it, focus returns to the composer and the list closes", () => {
    const projector = makeProjector();
    render(
      <>
        <NotificationFeedback projector={projector} />
        <textarea aria-label="Message input" />
      </>,
    );
    for (let index = 1; index <= 5; index += 1) notify(projector, `Update ${index}`);
    const more = screen.getByTestId("n1-feedback-more");
    act(() => {
      fireEvent.click(more);
    });
    more.focus();
    expect(more.textContent).toBe("Show fewer");

    act(() => {
      for (const item of projector.getBus().getSnapshot().notifications) {
        projector.getBus().dismiss(item.threadId, item.dedupeKey);
      }
    });

    expect(screen.getByTestId("n1-feedback").hidden).toBe(true);
    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Message input" }));
    for (let index = 1; index <= 5; index += 1) notify(projector, `Later ${index}`);
    expect(screen.getByTestId("n1-feedback-more").textContent).toBe("+2 more");
    projector.dispose();
  });

  test("the list of notices is capped in height, so long notices cannot push the status row away", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);
    notify(projector, "A notice");
    const list = strip().getByText("A notice").closest("article")?.parentElement;
    expect(list?.className).toContain("max-h-[30dvh]");
    projector.dispose();
  });
});

describe("the notices stack over the transcript", () => {
  test("draws the newest three notices and counts the rest", () => {
    const projector = makeProjector();
    render(<NotificationNotices projector={projector} />);
    for (let index = 1; index <= 5; index += 1) notify(projector, `Update ${index}`);

    const stack = within(screen.getByTestId("n1-notices"));
    expect(stack.queryByText("Update 2")).toBeNull();
    expect(stack.getByText("Update 3")).toBeTruthy();
    expect(stack.getByText("Update 5")).toBeTruthy();
    expect(screen.getByTestId("n1-feedback-more").textContent).toContain("+2 more");
    projector.dispose();
  });

  test("is hidden until a notice is waiting to be shown", () => {
    const projector = makeProjector();
    render(<NotificationNotices projector={projector} />);
    expect(screen.getByTestId("n1-notices").hidden).toBe(true);

    notify(projector, "Saved");
    expect(screen.getByTestId("n1-notices").hidden).toBe(false);
    projector.dispose();
  });

  test("the status strip keeps statuses and widgets and leaves notices to the stack", () => {
    const projector = makeProjector();
    render(<NotificationFeedback notices="none" projector={projector} />);
    notify(projector, "Extension finished");
    act(() => {
      projector.present(
        { kind: "setStatus", statusKey: "build", statusText: "Running" },
        { threadId },
      );
      projector.present(
        { kind: "setWidget", widgetKey: "build", widgetLines: ["Building"] },
        { threadId },
      );
    });

    expect(strip().queryByText("Extension finished")).toBeNull();
    expect(strip().getByText("Running")).toBeTruthy();
    expect(strip().getByText("Building")).toBeTruthy();
    projector.dispose();
  });

  test("the status strip takes no room while only notices are waiting", () => {
    const projector = makeProjector();
    render(<NotificationFeedback notices="none" projector={projector} />);
    notify(projector, "Saved");
    expect(screen.getByTestId("n1-feedback").hidden).toBe(true);
    projector.dispose();
  });

  test("is not drawn when its only banner is the projection's own error", () => {
    const projector = makeProjector();
    render(<NotificationNotices projector={projector} />);
    act(() => {
      projector.present({ kind: "setTitle", title: "   " }, { threadId });
    });
    expect(screen.getByTestId("n1-notices").hidden).toBe(true);
    projector.dispose();
  });
});
