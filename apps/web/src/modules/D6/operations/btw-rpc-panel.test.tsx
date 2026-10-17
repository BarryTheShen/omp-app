import { ThreadId } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { BtwRpcController, type BtwRpcSource } from "./btw-rpc";
import { btwRpcViews } from "./btw-rpc-panel";

const BtwRpcPanel = btwRpcViews.panel;

afterEach(cleanup);

describe("BtwRpcPanel", () => {
  test("survives StrictMode's effect replay and can start again after closing", async () => {
    let subscriptions = 0;
    let unsubscriptions = 0;
    const source: BtwRpcSource = {
      send: vi.fn(async () => ({ records: [] })) as BtwRpcSource["send"],
      subscribe: () => {
        subscriptions += 1;
        return () => {
          unsubscriptions += 1;
        };
      },
    };
    const controller = new BtwRpcController({ threadId: ThreadId.parse("btw-panel"), source });
    const view = render(
      <StrictMode>
        <BtwRpcPanel controller={controller} onBranch={() => undefined} open />
      </StrictMode>,
    );
    await waitFor(() => expect(subscriptions).toBe(2));
    view.unmount();
    expect(unsubscriptions).toBe(2);
    controller.start();
    expect(subscriptions).toBe(3);
    controller.dispose();
  });
  test("renders typed history and wires Copy and Cancel", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const send = vi.fn(async ({ command }: { readonly command: { readonly type: string } }) => {
      if (command.type === "get_btw_history") {
        return {
          records: [
            {
              id: "topic-1",
              question: "What changed?",
              answer: "The answer.",
              status: "complete",
              createdAt: 1,
              updatedAt: 2,
              leafId: null,
            },
          ],
        };
      }
      return { cancelled: true };
    });
    const source: BtwRpcSource = {
      send: send as BtwRpcSource["send"],
      subscribe: () => () => undefined,
    };
    const controller = new BtwRpcController({ threadId: ThreadId.parse("btw-panel"), source });
    render(<BtwRpcPanel controller={controller} onBranch={() => undefined} open />);
    await waitFor(() => expect(screen.getAllByText("What changed?")).not.toHaveLength(0));
    fireEvent.click(screen.getByRole("button", { name: "Copy answer" }));
    expect(writeText).toHaveBeenCalledWith("The answer.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel question" }));
    expect(send).toHaveBeenLastCalledWith({
      threadId: ThreadId.parse("btw-panel"),
      command: { type: "btw_cancel", recordId: "topic-1" },
    });
  });
});
