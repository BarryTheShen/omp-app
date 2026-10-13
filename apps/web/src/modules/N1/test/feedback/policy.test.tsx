import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import type { Notification } from "../../contract";
import { ExtensionWidgets, LiveAnnouncer, NotificationFeedback } from "../../feedback";
import { announcementsPass } from "../../feedback/announcer";
import { NotificationProjector } from "../../notifications";

const threadId = ThreadIdSchema.parse("thread-n1-policy");

afterEach(() => cleanup());

function makeProjector(): NotificationProjector {
  return new NotificationProjector({ source: new OmpRuntimeStore({ threadId }) });
}

function notify(
  projector: NotificationProjector,
  message: string,
  notifyType: "info" | "warning" | "error" = "warning",
): void {
  projector.present({ kind: "notify", message, notifyType }, { threadId });
}

/** The messages a live region currently holds, in order. */
function read(channel: "polite" | "assertive"): Array<string | null> {
  return Array.from(document.querySelectorAll(`[data-n1-live="${channel}"] p`)).map(
    (item) => item.textContent,
  );
}

function notice(overrides: Partial<Notification>): Notification {
  return {
    threadId,
    dedupeKey: "notice-1",
    severity: "info",
    placement: "toast",
    message: "A notice",
    live: "polite",
    focus: "preserve",
    ...overrides,
  };
}

describe("one live-region policy for notices", () => {
  test("a notice is read once, politely, and notices already shown at mount are not read", () => {
    const projector = makeProjector();
    notify(projector, "Shown before mount");
    render(<LiveAnnouncer projector={projector} />);
    expect(read("polite")).toEqual([]);

    act(() => {
      notify(projector, "Build finished");
    });
    expect(read("polite")).toEqual(["Build finished"]);

    act(() => {
      projector.present(
        { kind: "setStatus", statusKey: "build", statusText: "Running" },
        { threadId },
      );
    });
    expect(read("polite")).toEqual(["Build finished"]);
    projector.dispose();
  });

  test("an error is read assertively, not politely", () => {
    const projector = makeProjector();
    render(<LiveAnnouncer projector={projector} />);

    act(() => {
      notify(projector, "The connection dropped", "error");
    });

    expect(read("assertive")).toEqual(["The connection dropped"]);
    expect(read("polite")).toEqual([]);
    projector.dispose();
  });

  test("re-rendering does not read a notice again", () => {
    const projector = makeProjector();
    const { rerender } = render(<LiveAnnouncer projector={projector} />);
    act(() => {
      notify(projector, "Tests passed");
    });

    rerender(<LiveAnnouncer projector={projector} />);
    rerender(<LiveAnnouncer projector={projector} />);

    expect(read("polite")).toEqual(["Tests passed"]);
    projector.dispose();
  });

  test("a notice that left and came back is read again, as the new message it now is", () => {
    const projector = makeProjector();
    render(<LiveAnnouncer projector={projector} />);
    const retry = {
      threadId,
      dedupeKey: "retry:active",
      severity: "info" as const,
      placement: "banner" as const,
      message: "Retrying (1/3)",
      live: "polite" as const,
      focus: "preserve" as const,
    };
    act(() => {
      projector.getBus().publish(retry);
    });
    act(() => {
      projector.getBus().dismiss(threadId, "retry:active");
    });
    act(() => {
      projector.getBus().publish({ ...retry, message: "Retrying (2/3)" });
    });

    expect(read("polite")).toEqual(["Retrying (1/3)", "Retrying (2/3)"]);
    projector.dispose();
  });

  test("statuses and widgets are never read", () => {
    const projector = makeProjector();
    render(<LiveAnnouncer projector={projector} />);

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

    expect(read("polite")).toEqual([]);
    expect(read("assertive")).toEqual([]);
    projector.dispose();
  });

  test("the live regions exist before any notice, so a later one is read as it lands", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);

    expect(document.querySelector('[data-n1-live="polite"]')).not.toBeNull();
    expect(document.querySelector('[data-n1-live="assertive"]')).not.toBeNull();
    projector.dispose();
  });

  test("the pure pass announces only what is new, and forgets what left", () => {
    const first = announcementsPass(new Set(), [notice({ message: "One" })]);
    expect(first.polite).toEqual(["One"]);
    expect(first.assertive).toEqual([]);

    const second = announcementsPass(first.present, [notice({ message: "One" })]);
    expect(second.polite).toEqual([]);

    const errored = announcementsPass(second.present, [
      notice({ dedupeKey: "two", severity: "error", live: "assertive", message: "Two" }),
    ]);
    expect(errored.assertive).toEqual(["Two"]);
    expect(errored.present.size).toBe(1);
  });

  test("a notice that is not live is never read", () => {
    const pass = announcementsPass(new Set(), [notice({ live: "off", message: "Silent" })]);
    expect(pass.polite).toEqual([]);
    expect(pass.assertive).toEqual([]);
  });

  test("an informational notice waits in the omp notices line, and no live region reads it", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);

    act(() => {
      notify(projector, "Build cache warmed", "info");
    });

    expect(read("polite")).toEqual([]);
    expect(read("assertive")).toEqual([]);
    expect(
      within(screen.getByTestId("n1-feedback")).getByRole("button", { name: "1 notice from omp" }),
    ).toBeTruthy();
    projector.dispose();
  });
});

describe("notice tones follow U0's severity tokens", () => {
  test("each severity uses its U0 tone and no page-level color", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);

    act(() => {
      notify(projector, "Saved", "info");
      notify(projector, "Careful", "warning");
      projector.getBus().publish(
        notice({
          dedupeKey: "failed",
          severity: "error",
          placement: "banner",
          message: "Failed",
        }),
      );
    });

    const strip = within(screen.getByTestId("n1-feedback"));
    const toneOf = (message: string) =>
      strip.getByText(message).closest("article")?.className ?? "";
    // An informational notice is kept in the omp notices line, so it draws no card and takes no tone.
    expect(strip.getByRole("button", { name: "1 notice from omp" })).toBeTruthy();
    expect(strip.getAllByRole("article")).toHaveLength(2);
    expect(toneOf("Careful")).toContain("bg-warning-surface");
    expect(toneOf("Failed")).toContain("bg-danger-surface");
    for (const message of ["Careful", "Failed"]) {
      expect(toneOf(message)).not.toMatch(/destructive|warning\/50/);
    }
    projector.dispose();
  });
});

describe("extension widgets follow their placement", () => {
  test("each placement draws only its own widgets", () => {
    const projector = makeProjector();
    render(
      <>
        <ExtensionWidgets placement="aboveEditor" projector={projector} />
        <ExtensionWidgets placement="belowEditor" projector={projector} />
      </>,
    );

    act(() => {
      projector.present(
        {
          kind: "setWidget",
          widgetKey: "above",
          widgetLines: ["Shown above"],
          widgetPlacement: "aboveEditor",
        },
        { threadId },
      );
      projector.present(
        {
          kind: "setWidget",
          widgetKey: "below",
          widgetLines: ["Shown below"],
          widgetPlacement: "belowEditor",
        },
        { threadId },
      );
    });

    const above = document.querySelector('[data-widget-placement="aboveEditor"]');
    const below = document.querySelector('[data-widget-placement="belowEditor"]');
    expect(above?.textContent).toContain("Shown above");
    expect(above?.textContent).not.toContain("Shown below");
    expect(below?.textContent).toContain("Shown below");
    expect(below?.textContent).not.toContain("Shown above");
    projector.dispose();
  });

  test("a strip draws only the widgets in its scope", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} widgets="belowEditor" />);

    act(() => {
      projector.present(
        {
          kind: "setWidget",
          widgetKey: "above",
          widgetLines: ["Shown above"],
          widgetPlacement: "aboveEditor",
        },
        { threadId },
      );
      projector.present(
        {
          kind: "setWidget",
          widgetKey: "below",
          widgetLines: ["Shown below"],
          widgetPlacement: "belowEditor",
        },
        { threadId },
      );
    });

    expect(screen.queryByText("Shown above")).toBeNull();
    expect(screen.getByText("Shown below")).toBeTruthy();
    projector.dispose();
  });
});

describe("reduced motion", () => {
  test("the dismiss and expansion controls do not animate when motion is reduced", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);
    act(() => {
      for (let index = 1; index <= 4; index += 1) {
        projector.present(
          { kind: "notify", message: `Update ${index}`, notifyType: "warning" },
          { threadId },
        );
      }
    });

    const dismiss = screen.getAllByRole("button", { name: "Dismiss notification" })[0];
    const more = screen.getByTestId("n1-feedback-more");
    expect(dismiss?.className).toContain("motion-reduce:transition-none");
    expect(more.className).toContain("motion-reduce:transition-none");
    projector.dispose();
  });
});

describe("a projection failure is shown and read once", () => {
  test("the inline alert carries the message once, the banner is not repeated, and a good update clears it", () => {
    const projector = makeProjector();
    render(<NotificationFeedback projector={projector} />);
    const strip = within(screen.getByTestId("n1-feedback"));

    act(() => {
      projector.present({ kind: "setTitle", title: "   " }, { threadId });
    });

    expect(strip.getByText("omp update unavailable")).toBeTruthy();
    expect(strip.getAllByText("The extension title is empty.")).toHaveLength(1);
    expect(strip.getByRole("alert").textContent).toContain("The extension title is empty.");
    expect(read("assertive")).not.toContain("The extension title is empty.");
    expect(read("polite")).not.toContain("The extension title is empty.");

    act(() => {
      projector.present({ kind: "setTitle", title: "Build status" }, { threadId });
    });

    expect(strip.queryByText("omp update unavailable")).toBeNull();
    expect(screen.getByTestId("n1-feedback").hidden).toBe(true);
    projector.dispose();
  });
});

describe("the live regions suit a screen reader", () => {
  test("both regions are non-atomic, so only an addition is read", () => {
    const projector = makeProjector();
    render(<LiveAnnouncer projector={projector} />);

    for (const channel of ["polite", "assertive"]) {
      expect(
        document.querySelector(`[data-n1-live="${channel}"]`)?.getAttribute("aria-atomic"),
      ).toBe("false");
    }
    projector.dispose();
  });

  test("a second notice is added beside the first, which keeps its place in the region", () => {
    const projector = makeProjector();
    render(<LiveAnnouncer projector={projector} />);
    act(() => {
      notify(projector, "First");
    });
    const first = document.querySelector('[data-n1-live="polite"] p');

    act(() => {
      notify(projector, "Second");
    });

    const items = Array.from(document.querySelectorAll('[data-n1-live="polite"] p'));
    expect(items.map((item) => item.textContent)).toEqual(["First", "Second"]);
    expect(items[0]).toBe(first);
    projector.dispose();
  });

  test("a notice the app does not draw is not read, even when it is an error", () => {
    const projector = makeProjector();
    render(<LiveAnnouncer projector={projector} />);

    act(() => {
      projector.getBus().publish(
        notice({
          dedupeKey: "inline-error",
          placement: "inline",
          severity: "error",
          live: "assertive",
          message: "Shown inline elsewhere",
        }),
      );
    });
    expect(read("assertive")).toEqual([]);
    expect(read("polite")).toEqual([]);

    act(() => {
      projector
        .getBus()
        .publish(
          notice({ dedupeKey: "shown-toast", placement: "toast", message: "Shown in the strip" }),
        );
    });
    expect(read("polite")).toEqual(["Shown in the strip"]);
    projector.dispose();
  });

  test("a notice the transcript shows is read, politely or assertively, as its live setting says", () => {
    const projector = makeProjector();
    render(<LiveAnnouncer projector={projector} />);

    act(() => {
      projector.getBus().publish(
        notice({
          dedupeKey: "transcript-todo",
          placement: "transcript",
          severity: "warning",
          live: "polite",
          message: "Unfinished todos (attempt 1 of 3)",
        }),
      );
      projector.getBus().publish(
        notice({
          dedupeKey: "transcript-error",
          placement: "transcript",
          severity: "error",
          live: "assertive",
          message: "Retry failed in the transcript",
        }),
      );
    });
    expect(read("polite")).toEqual(["Unfinished todos (attempt 1 of 3)"]);
    expect(read("assertive")).toEqual(["Retry failed in the transcript"]);
    projector.dispose();
  });
});
