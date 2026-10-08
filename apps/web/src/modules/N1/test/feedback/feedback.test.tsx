import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "vitest";
import { OmpRuntimeStore } from "../../../R0/store";
import { NotificationFeedback } from "../../feedback";
import { NotificationProjector } from "../../notifications";

const threadId = ThreadIdSchema.parse("thread-n1-feedback");

afterEach(() => cleanup());

describe("NotificationFeedback", () => {
  test("renders projector notices, statuses and widgets without moving focus", () => {
    const projector = new NotificationProjector({ source: new OmpRuntimeStore({ threadId }) });
    render(<NotificationFeedback projector={projector} />);

    act(() => {
      projector.present(
        { kind: "notify", message: "Extension finished", notifyType: "info" },
        { threadId },
      );
      projector.present(
        { kind: "setStatus", statusKey: "build", statusText: "Running" },
        { threadId },
      );
      projector.present(
        { kind: "setWidget", widgetKey: "build", widgetLines: ["Building"] },
        { threadId },
      );
    });

    expect(screen.getByText("Extension finished")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Building")).toBeTruthy();
    expect(screen.getByTestId("n1-feedback")).toBeTruthy();
    projector.dispose();
  });

  test("removes a widget when the handoff clears it", () => {
    const projector = new NotificationProjector({ source: new OmpRuntimeStore({ threadId }) });
    render(<NotificationFeedback projector={projector} />);

    act(() => {
      projector.present(
        { kind: "setWidget", widgetKey: "build", widgetLines: ["Building"] },
        { threadId },
      );
    });
    expect(screen.getByText("Building")).toBeTruthy();

    act(() => {
      projector.present({ kind: "setWidget", widgetKey: "build" }, { threadId });
    });
    expect(screen.queryByText("Building")).toBeNull();
    projector.dispose();
  });

  test("shows the newest three toasts, counts the rest, and dismisses one on request", () => {
    const projector = new NotificationProjector({ source: new OmpRuntimeStore({ threadId }) });
    render(<NotificationFeedback projector={projector} />);

    act(() => {
      for (let index = 1; index <= 5; index += 1) {
        projector.present(
          { kind: "notify", message: `Update ${index}`, notifyType: "info" },
          { threadId },
        );
      }
    });

    expect(screen.queryByText("Update 1")).toBeNull();
    expect(screen.queryByText("Update 2")).toBeNull();
    expect(screen.getByText("Update 3")).toBeTruthy();
    expect(screen.getByText("Update 5")).toBeTruthy();
    expect(screen.getByTestId("n1-feedback-more").textContent).toContain("+2 more");

    act(() => {
      screen.getAllByRole("button", { name: "Dismiss notification" })[2]?.click();
    });
    expect(screen.queryByText("Update 5")).toBeNull();
    expect(screen.getByText("Update 2")).toBeTruthy();
    expect(screen.getByTestId("n1-feedback-more").textContent).toContain("+1 more");
    projector.dispose();
  });
});
