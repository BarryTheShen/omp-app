import { ThreadPrimitive } from "@assistant-ui/react";
import { AppFailure } from "@omp-app/contracts";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { SubagentClient } from "@/modules/P1/client";
import type { NestedTranscriptSource } from "@/modules/P1/contract";
import { FocusedAgentTranscript } from "../focused-view";
import { NestedAgentTranscript } from "../nested-view";
import { ReadOnlyThread } from "../read-only-thread";
import { createFocusedAgentRuntime } from "../source";
import { agentRef, assistantMessage, FakeFeed, transcriptPage, userMessage } from "./fixtures";

const originalScrollTo = HTMLElement.prototype.scrollTo;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: originalScrollTo,
  });
});

/**
 * The thread a nested task card sits in: the library's read-only thread with its viewport, the same
 * context the app's main thread gives a card.
 */
function InThread({ children }: { readonly children: ReactNode }) {
  return (
    <ReadOnlyThread messages={[]}>
      <ThreadPrimitive.Root>
        <ThreadPrimitive.Viewport>{children}</ThreadPrimitive.Viewport>
      </ThreadPrimitive.Root>
    </ReadOnlyThread>
  );
}

/** A worker's read-only source, the shape a nested task card receives. */
function nestedSource(feed: FakeFeed): NestedTranscriptSource {
  return { agent: feed.agent, read: feed.read, subscribe: feed.subscribe, readOnly: true };
}

/** The first read is asked for once the view has mounted; the test answers it. */
async function awaitRead(feed: FakeFeed): Promise<void> {
  await waitFor(() => expect(feed.pendingReads).toBeGreaterThan(0));
}

/** A client whose transcript reads are empty; steering is recorded and can be made to fail. */
function stubClient(options: { readonly steerFails?: AppFailure } = {}) {
  const steers: Array<{ readonly id: string; readonly message: string }> = [];
  const client: SubagentClient = {
    getRoster: async () => [],
    readTranscript: async (_id, readOptions) => {
      const fromByte = readOptions?.fromByte ?? 0;
      return transcriptPage({ fromByte, nextByte: fromByte });
    },
    cancel: async () => ({ cancelled: true }),
    steer: async (subagentId, message) => {
      if (options.steerFails !== undefined) throw options.steerFails;
      steers.push({ id: subagentId, message });
    },
    setSubscriptionLevel: async (level) => level,
    acquireSubscription: async (level) => ({ level, release: async () => {} }),
    subscribeNotifications: () => () => {},
    dispose: async () => {},
  };
  return { client, steers };
}

const CONTROL_NAMES = /edit|regenerate|branch|reload|answer|approve|steer|compose|send|retry/i;

describe("the nested worker transcript", () => {
  test("shows the worker's messages read-only, with no control that could change the worker", async () => {
    const feed = new FakeFeed(agentRef());
    render(
      <InThread>
        <NestedAgentTranscript source={nestedSource(feed)} />
      </InThread>,
    );
    await awaitRead(feed);
    feed.answer(
      transcriptPage({
        fromByte: 0,
        nextByte: 60,
        messages: [userMessage("Look at the logs"), assistantMessage("Found the cause.")],
      }),
    );
    expect(await screen.findByText("Found the cause.")).toBeTruthy();
    expect(screen.getByText("Look at the logs")).toBeTruthy();

    const region = document.querySelector('[data-read-only="true"]');
    expect(region).not.toBeNull();
    if (region === null) throw new Error("the nested transcript is not read-only");
    expect(within(region as HTMLElement).queryAllByRole("button", { name: CONTROL_NAMES })).toEqual(
      [],
    );
    expect(within(region as HTMLElement).queryAllByRole("textbox")).toEqual([]);
  });

  test("a failed read is a visible row with a way to try again, and the retry asks omp again", async () => {
    const feed = new FakeFeed(agentRef());
    render(
      <InThread>
        <NestedAgentTranscript source={nestedSource(feed)} />
      </InThread>,
    );
    await awaitRead(feed);
    feed.fail(new AppFailure({ code: "not_found", message: "omp detail", retryable: true }));
    expect(await screen.findByText("The transcript could not be read")).toBeTruthy();
    expect(screen.getByText("This worker's transcript is no longer available.")).toBeTruthy();
    expect(screen.queryByText("omp detail")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(feed.requests).toHaveLength(2));
    expect(feed.requests).toEqual([0, 0]);
  });

  test("a finished worker with no messages says nothing was recorded", async () => {
    const feed = new FakeFeed(agentRef({ status: "completed" }));
    render(
      <InThread>
        <NestedAgentTranscript source={nestedSource(feed)} />
      </InThread>,
    );
    await awaitRead(feed);
    feed.answer(transcriptPage({ fromByte: 0, nextByte: 0 }));
    expect(await screen.findByText("No messages were recorded")).toBeTruthy();
  });
});

describe("the focused worker transcript", () => {
  test("a running worker's message is sent through the runtime, and the text clears once omp accepts it", async () => {
    const { client, steers } = stubClient();
    const runtime = createFocusedAgentRuntime({ agent: agentRef(), client });
    render(<FocusedAgentTranscript runtime={runtime} />);
    const box = screen.getByRole("textbox", { name: "Message to this worker" });
    fireEvent.change(box, { target: { value: "Drop the glob." } });
    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(steers).toEqual([{ id: "worker-1", message: "Drop the glob." }]));
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
  });

  test("a finished worker's editor is off and says why", () => {
    const { client } = stubClient();
    const runtime = createFocusedAgentRuntime({
      agent: agentRef({ status: "completed" }),
      client,
    });
    render(<FocusedAgentTranscript runtime={runtime} />);
    const box = screen.getByRole("textbox", { name: "Message to this worker" });
    expect((box as HTMLTextAreaElement).disabled).toBe(true);
    expect(screen.getByText("This worker has finished, so messages can't be sent.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Send" }).hasAttribute("disabled")).toBe(true);
  });

  test("a failed send keeps the typed words and says the message was not sent", async () => {
    const { client } = stubClient({
      steerFails: new AppFailure({
        code: "omp_error",
        message: "Subagent refused",
        retryable: true,
      }),
    });
    const runtime = createFocusedAgentRuntime({ agent: agentRef(), client });
    render(<FocusedAgentTranscript runtime={runtime} />);
    const box = screen.getByRole("textbox", { name: "Message to this worker" });
    fireEvent.change(box, { target: { value: "keep these words" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(
      await screen.findByText("The message was not sent. Your text is still here; try again."),
    ).toBeTruthy();
    expect((box as HTMLTextAreaElement).value).toBe("keep these words");
  });

  test("Escape clears the typed words first, and leaves focus on the next press", () => {
    const { client } = stubClient();
    const runtime = createFocusedAgentRuntime({ agent: agentRef(), client });
    const onExit = vi.fn();
    render(<FocusedAgentTranscript onExit={onExit} runtime={runtime} />);
    const box = screen.getByRole("textbox", { name: "Message to this worker" });
    fireEvent.change(box, { target: { value: "half a thought" } });
    fireEvent.keyDown(box, { key: "Escape" });
    expect((box as HTMLTextAreaElement).value).toBe("");
    expect(onExit).not.toHaveBeenCalled();
    fireEvent.keyDown(box, { key: "Escape" });
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  test("the transcript is a labelled, scrollable region", () => {
    const { client } = stubClient();
    const runtime = createFocusedAgentRuntime({ agent: agentRef(), client });
    render(<FocusedAgentTranscript runtime={runtime} />);
    expect(screen.getByRole("region", { name: "Worker messages" })).toBeTruthy();
  });

  test("a running worker's header says only Running, while a finished one stays read-only", () => {
    const { client } = stubClient();
    const running = render(
      <FocusedAgentTranscript runtime={createFocusedAgentRuntime({ agent: agentRef(), client })} />,
    );
    expect(document.querySelector('[data-slot="p1-focused-status"]')?.textContent).toBe("Running");
    running.unmount();

    render(
      <FocusedAgentTranscript
        runtime={createFocusedAgentRuntime({
          agent: agentRef({ status: "completed" }),
          client,
        })}
      />,
    );
    expect(document.querySelector('[data-slot="p1-focused-status"]')?.textContent).toBe(
      "Finished · read-only",
    );
  });

  test("the heading names a worker by its description, else by its id, never by its agent type", () => {
    const { client } = stubClient();
    const named = render(
      <FocusedAgentTranscript
        runtime={createFocusedAgentRuntime({
          agent: agentRef({ description: "LongProbe" }),
          client,
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "LongProbe" })).toBeTruthy();
    named.unmount();

    render(
      <FocusedAgentTranscript
        runtime={createFocusedAgentRuntime({
          agent: agentRef({ description: undefined }),
          client,
        })}
      />,
    );
    expect(screen.getByRole("heading", { name: "worker-1" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "task" })).toBeNull();
  });

  test("no follow row or empty band is shown while the reader is at the newest message", () => {
    const { client } = stubClient();
    render(
      <FocusedAgentTranscript runtime={createFocusedAgentRuntime({ agent: agentRef(), client })} />,
    );
    expect(document.querySelector('[data-slot="u1-scroll-follow-controls"]')).toBeNull();
    expect(screen.queryByRole("button", { name: "Jump to latest message" })).toBeNull();
  });

  test("a reader who scrolls away from the newest message: the browser's scroll anchoring is off, and the follow resumes after a wheel back to the bottom", () => {
    const { client } = stubClient();
    render(
      <FocusedAgentTranscript runtime={createFocusedAgentRuntime({ agent: agentRef(), client })} />,
    );
    const viewport = screen.getByRole("region", { name: "Worker messages" });
    // 1,000 px of content in a 200 px view: the bottom is at 800, where the reader starts.
    let top = 800;
    Object.defineProperty(viewport, "scrollHeight", { configurable: true, value: 1_000 });
    Object.defineProperty(viewport, "clientHeight", { configurable: true, value: 200 });
    Object.defineProperty(viewport, "scrollTop", {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value;
      },
    });
    fireEvent.scroll(viewport);
    expect(viewport.classList.contains("[overflow-anchor:none]")).toBe(false);

    // The reader scrolls up, away from the newest message: the app keeps their row in place itself.
    top = 300;
    fireEvent.scroll(viewport);
    expect(viewport.classList.contains("[overflow-anchor:none]")).toBe(true);

    // A wheel down, then back to the bottom: the follow resumes and the browser's anchoring is on again.
    fireEvent.wheel(viewport, { deltaY: 100 });
    top = 800;
    fireEvent.scroll(viewport);
    expect(viewport.classList.contains("[overflow-anchor:none]")).toBe(false);
  });
});
