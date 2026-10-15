import { ThreadId as ThreadIdSchema } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createP3Runs } from "./runs";
import type { P3FailedState, P3RunState, P3SentState } from "./status";
import { sourceThread, userEntry } from "./test-support";
import { P3RunStatusSurface, P3RunStatusView } from "./view";

afterEach(cleanup);

const newChat = ThreadIdSchema.parse("branch-of-source");
const otherChat = ThreadIdSchema.parse("unrelated-chat");

const record = {
  kind: "edit" as const,
  sourceEntryId: userEntry,
  sourceThreadId: sourceThread,
  replacement: { text: "Explain again", images: [] },
};

const sent: P3SentState = {
  ...record,
  phase: "sent",
  threadId: newChat,
  workspaceGuarantee: "not-managed",
  externalChanges: [],
  partialFailure: null,
};

const failed: P3FailedState = {
  ...record,
  phase: "failed",
  branched: false,
  chatThreadId: sourceThread,
  message: "omp is busy",
  retryable: true,
};

describe("P3RunStatusView", () => {
  test("says the edit went to a new branch, says nothing about files no restore touched, and offers the way back", () => {
    const onOpenSource = vi.fn();
    render(
      <P3RunStatusView
        canRetry={false}
        onDismiss={() => undefined}
        onOpenSource={onOpenSource}
        onRetry={() => undefined}
        openError={null}
        showOpenSource
        state={sent}
      />,
    );

    expect(screen.getByText("Sent in this new chat, branched from the original.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the original chat" }));
    expect(onOpenSource).toHaveBeenCalledTimes(1);
  });

  test("in the original chat the same notice says the new chat branched from this one", () => {
    render(
      <P3RunStatusView
        canRetry={false}
        onDismiss={() => undefined}
        onOpenSource={() => undefined}
        onRetry={() => undefined}
        openError={null}
        showOpenSource={false}
        state={sent}
      />,
    );

    expect(screen.getByText("Sent in a new chat branched from this one.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the original chat" })).toBeNull();
  });

  test("a restore the app managed says what it restored", () => {
    const props = {
      canRetry: false,
      onDismiss: () => undefined,
      onOpenSource: () => undefined,
      onRetry: () => undefined,
      openError: null,
      showOpenSource: true,
    };
    const { rerender } = render(
      <P3RunStatusView {...props} state={{ ...sent, workspaceGuarantee: "boundary" }} />,
    );
    expect(
      screen.getByText(
        "Sent in this new chat, branched from the original. Workspace files were restored to the last checkpoint.",
      ),
    ).toBeTruthy();
    rerender(<P3RunStatusView {...props} state={{ ...sent, workspaceGuarantee: "exact" }} />);
    expect(
      screen.getByText(
        "Sent in this new chat, branched from the original. Workspace files were restored to the state before this message.",
      ),
    ).toBeTruthy();
  });

  test("keeps a failed edit's text on screen and offers Try again only where a retry can run", () => {
    const onRetry = vi.fn();
    const { rerender } = render(
      <P3RunStatusView
        canRetry
        onDismiss={() => undefined}
        onOpenSource={() => undefined}
        onRetry={onRetry}
        openError={null}
        showOpenSource={false}
        state={failed}
      />,
    );

    expect(screen.getByText("omp is busy")).toBeTruthy();
    expect(
      screen.getByText("Explain again", { selector: "[data-slot='p3-run-kept-text']" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledTimes(1);

    rerender(
      <P3RunStatusView
        canRetry={false}
        onDismiss={() => undefined}
        onOpenSource={() => undefined}
        onRetry={onRetry}
        openError={null}
        showOpenSource={false}
        state={failed}
      />,
    );
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  test("shows an open error as an alert", () => {
    render(
      <P3RunStatusView
        canRetry={false}
        onDismiss={() => undefined}
        onOpenSource={() => undefined}
        onRetry={() => undefined}
        openError="The original chat could not be opened."
        showOpenSource={false}
        state={sent}
      />,
    );

    expect(screen.getByRole("alert").textContent).toBe("The original chat could not be opened.");
  });

  test("a finished or failed notice has a Dismiss control that ends it, and a sending run has none", () => {
    const onDismiss = vi.fn();
    const { rerender } = render(
      <P3RunStatusView
        canRetry={false}
        onDismiss={onDismiss}
        onOpenSource={() => undefined}
        onRetry={() => undefined}
        openError={null}
        showOpenSource={false}
        state={sent}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledTimes(1);

    rerender(
      <P3RunStatusView
        canRetry={false}
        onDismiss={onDismiss}
        onOpenSource={() => undefined}
        onRetry={() => undefined}
        openError={null}
        showOpenSource={false}
        state={failed}
      />,
    );
    expect(screen.getByRole("button", { name: "Dismiss" })).toBeTruthy();

    rerender(
      <P3RunStatusView
        canRetry={false}
        onDismiss={onDismiss}
        onOpenSource={() => undefined}
        onRetry={() => undefined}
        openError={null}
        showOpenSource={false}
        state={{ ...record, phase: "sending" }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
  });
});

describe("P3RunStatusSurface", () => {
  test("stays hidden in a chat the run did not touch", () => {
    const runs = createP3Runs();
    runs.status.set(sent);

    render(
      <P3RunStatusSurface
        onOpenSource={async () => undefined}
        onRetry={async () => undefined}
        runs={runs}
        threadId={otherChat}
      />,
    );

    expect(screen.queryByText(/Sent in/)).toBeNull();
  });

  test("shows a sending run in its source chat, without a button back to that same chat", () => {
    const runs = createP3Runs();
    const sending: P3RunState = { ...record, phase: "sending" };
    runs.status.set(sending);

    render(
      <P3RunStatusSurface
        onOpenSource={async () => undefined}
        onRetry={async () => undefined}
        runs={runs}
        threadId={sourceThread}
      />,
    );

    expect(screen.getByText("Sending the edited message as a new branch…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open the original chat" })).toBeNull();
  });

  test("retries a failure in the chat it belongs to, passing the failure", () => {
    const runs = createP3Runs();
    runs.status.set(failed);
    const onRetry = vi.fn(async () => undefined);

    render(
      <P3RunStatusSurface
        onOpenSource={async () => undefined}
        onRetry={onRetry}
        runs={runs}
        threadId={sourceThread}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledWith(failed);
  });

  test("opening a chat the run did not touch ends a finished notice", () => {
    const runs = createP3Runs();
    runs.status.set(sent);

    render(
      <P3RunStatusSurface
        onOpenSource={async () => undefined}
        onRetry={async () => undefined}
        runs={runs}
        threadId={otherChat}
      />,
    );

    expect(runs.status.getSnapshot()).toEqual({ phase: "idle" });
  });

  test("a notice stays while the person is in a chat its run touched", () => {
    const runs = createP3Runs();
    runs.status.set(sent);

    render(
      <P3RunStatusSurface
        onOpenSource={async () => undefined}
        onRetry={async () => undefined}
        runs={runs}
        threadId={newChat}
      />,
    );

    expect(runs.status.getSnapshot()).toBe(sent);
    expect(screen.getByText("Sent in this new chat, branched from the original.")).toBeTruthy();
  });

  test("Dismiss in the chat ends the notice everywhere it shows", () => {
    const runs = createP3Runs();
    runs.status.set(sent);

    render(
      <P3RunStatusSurface
        onOpenSource={async () => undefined}
        onRetry={async () => undefined}
        runs={runs}
        threadId={sourceThread}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));

    expect(runs.status.getSnapshot()).toEqual({ phase: "idle" });
    expect(screen.queryByText(/Sent in/)).toBeNull();
  });
});
