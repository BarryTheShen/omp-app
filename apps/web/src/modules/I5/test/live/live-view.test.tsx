import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { LiveState } from "../../contract";
import { LiveStatusPanel, LiveVoiceControl } from "../../live/live-view";

const idle: LiveState = {
  sessionId: null,
  voice: null,
  phase: "idle",
  muted: false,
  levels: { input: 0, output: 0 },
  transcripts: [],
  error: null,
  connected: false,
};

function control(
  state: Partial<LiveState>,
  unavailableReason: string | undefined = undefined,
  handlers = { onStart: vi.fn(), onStop: vi.fn(), onToggleMute: vi.fn() },
) {
  render(
    <LiveVoiceControl
      state={{ ...idle, ...state }}
      unavailableReason={unavailableReason}
      onStart={handlers.onStart}
      onStop={handlers.onStop}
      onToggleMute={handlers.onToggleMute}
    />,
  );
  return handlers;
}

describe("I5 live voice control", () => {
  afterEach(() => cleanup());

  test("idle, it offers a start icon, and says it is not live to a screen reader only", () => {
    const handlers = control({});
    fireEvent.click(screen.getByRole("button", { name: "Start live voice" }));
    expect(handlers.onStart).toHaveBeenCalledTimes(1);
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("Not live");
    expect(status.className).toContain("sr-only");
    expect(screen.queryByRole("button", { name: "Stop live voice" })).toBeNull();
  });

  test("without the live capability, start is disabled and its title says why", () => {
    control({}, "Live voice needs omp 18.9.1 or later.");
    const start = screen.getByRole("button", { name: "Start live voice" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(start.title).toBe("Live voice needs omp 18.9.1 or later.");
  });

  test("while live, it offers mute and stop icons, and reads the phase out", () => {
    const handlers = control({ phase: "listening", connected: true });
    expect(screen.getByRole("status").textContent).toBe("Listening");
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop live voice" }));
    expect(handlers.onToggleMute).toHaveBeenCalledTimes(1);
    expect(handlers.onStop).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Start live voice" })).toBeNull();
  });

  test("muted, the mute icon offers to unmute", () => {
    control({ phase: "muted", muted: true, connected: true });
    expect(screen.getByRole("button", { name: "Unmute microphone" })).toBeTruthy();
  });
});

describe("I5 live status panel", () => {
  afterEach(() => cleanup());

  test("while live it shows the words, both levels, and the lines still being spoken", () => {
    render(
      <LiveStatusPanel
        state={{
          ...idle,
          phase: "listening",
          connected: true,
          levels: { input: 0.25, output: 0.5 },
          transcripts: [
            { sessionId: "s", role: "user", turn: 0, text: "hel", final: false },
            { sessionId: "s", role: "assistant", turn: 1, text: "Hi, I can", final: false },
            { sessionId: "s", role: "user", turn: 2, text: "done", final: true },
          ],
        }}
      />,
    );
    expect(screen.getByTestId("live-status").textContent).toBe("Listening");
    expect(screen.getByRole("meter", { name: "Microphone level" }).getAttribute("value")).toBe(
      "0.25",
    );
    expect(screen.getByRole("meter", { name: "Speaker level" }).getAttribute("value")).toBe("0.5");
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "You: hel",
      "omp: Hi, I can",
    ]);
  });

  test("idle, with no line and no error, it shows nothing", () => {
    const { container } = render(<LiveStatusPanel state={idle} />);
    expect(container.textContent).toBe("");
  });

  test("when ended, it shows no words", () => {
    const { container } = render(<LiveStatusPanel state={{ ...idle, phase: "ended" }} />);
    expect(container.textContent).toBe("");
  });

  test("after an error, it shows the words and omp's error as an alert", () => {
    render(
      <LiveStatusPanel
        state={{
          ...idle,
          phase: "error",
          error: "No Codex OAuth credential is available for a live call.",
        }}
      />,
    );
    expect(screen.getByTestId("live-status").textContent).toBe("Stopped with an error");
    expect(screen.getByRole("alert").textContent).toBe(
      "No Codex OAuth credential is available for a live call.",
    );
  });
});
